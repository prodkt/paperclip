import { and, asc, count, desc, eq, ilike, inArray, max, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issues,
  pipelineCaseBlockers,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineGuidanceDocuments,
  pipelineStages,
  pipelineTransitions,
  pipelines,
} from "@paperclipai/db";
import {
  pipelineStageRunRoutineSchema,
  type ListCompanyCaseEventsQuery,
  type PipelineStageConfig,
  type PipelineStageRunRoutineConfig,
  type PipelineStageVariable,
  type ReviewCasesQuery,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { routineService } from "./routines.js";

type PipelineRow = typeof pipelines.$inferSelect;
type PipelineStageRow = typeof pipelineStages.$inferSelect;
type PipelineTransitionInsert = typeof pipelineTransitions.$inferInsert;
type PipelineTransitionSelect = typeof pipelineTransitions.$inferSelect;
type PipelineCaseRow = typeof pipelineCases.$inferSelect;
type PipelineCaseInsert = typeof pipelineCases.$inferInsert;
type PipelineCaseEventInsert = typeof pipelineCaseEvents.$inferInsert;
type PipelineCaseEvent = typeof pipelineCaseEvents.$inferSelect;
type PipelineCaseIssueLink = typeof pipelineCaseIssueLinks.$inferSelect;
type PipelineGuidanceDocument = typeof pipelineGuidanceDocuments.$inferSelect;
type PipelineCaseBlocker = typeof pipelineCaseBlockers.$inferSelect;
type PipelineDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type RoutineVariableValue = string | number | boolean;

type PipelineInput = Omit<typeof pipelines.$inferInsert, "id" | "createdAt" | "updatedAt">;
type PipelineStageInput = Omit<typeof pipelineStages.$inferInsert, "id" | "pipelineId" | "createdAt" | "updatedAt">;
type PipelineCaseActor = {
  actorId: string;
  actorType: "user" | "agent" | "system";
};
type PipelineCaseTransitionOptions = PipelineCaseActor & {
  reason?: string | null;
};

export type PipelineCaseEventWithContext = PipelineCaseEvent & {
  caseTitle: string | null;
  pipelineName: string | null;
  fromStageName: string | null;
  toStageName: string | null;
};

export type PipelineIntakeField = {
  key: string;
  label: string;
  type: PipelineStageVariable["type"];
  required?: boolean;
  options?: string[];
};

function isNonNullableObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStageConfig(config: PipelineStageConfig | unknown): PipelineStageConfig {
  if (!isNonNullableObject(config)) {
    return { variables: [] };
  }
  if (!("variables" in config) || !Array.isArray((config as { variables?: unknown }).variables)) {
    return { ...config, variables: [] };
  }
  return config as PipelineStageConfig;
}

const companyCaseEventTypeAliases: Record<string, string[]> = {
  review_decided: ["review_decided", "case.reviewed"],
  transition_forced: ["transition_forced", "case.transitioned"],
};

function normalizeCompanyCaseEventTypes(types: string | undefined): string[] {
  if (!types) return [];
  const requested = types
    .split(",")
    .map((type) => type.trim())
    .filter(Boolean);
  const normalized = requested.flatMap((type) => companyCaseEventTypeAliases[type] ?? [type]);
  return Array.from(new Set(normalized));
}

function eventPayloadStageIds(payload: Record<string, unknown> | null | undefined): string[] {
  const ids = [payload?.fromStageId, payload?.toStageId].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return Array.from(new Set(ids));
}

export function extractPipelineIntakeFormFields(stages: PipelineStageRow[]): PipelineIntakeField[] {
  const first = stages[0];
  if (!first) return [];
  const stageConfig = normalizeStageConfig(first.config);
  return stageConfig.variables
    .filter((variable) => variable.showInAddForm)
    .map((variable) => ({
      key: variable.key,
      label: variable.label,
      type: variable.type,
      required: variable.required,
      options: variable.options,
    }));
}

export function validateStageRequiredFields(
  fields: Record<string, unknown>,
  stageVariables: PipelineStageVariable[],
) {
  const missing = stageVariables
    .filter((variable) => variable.showInAddForm)
    .filter((variable) => variable.required)
    .filter((variable) => {
      const value = fields[variable.key];
      if (value == null) return true;
      if (typeof value === "string") return value.trim().length === 0;
      return false;
    })
    .map((variable) => variable.key);
  if (missing.length > 0) {
    throw unprocessable(`Missing required field(s): ${missing.join(", ")}`);
  }
}

export function isStageNewEntryDisabled(config: PipelineStageConfig | unknown) {
  const stageConfig = normalizeStageConfig(config);
  if (stageConfig.disable?.newEntries) return true;
  if ("disabled" in stageConfig && typeof stageConfig.disabled === "boolean") {
    return stageConfig.disabled;
  }
  if ("newEntriesDisabled" in stageConfig && typeof stageConfig.newEntriesDisabled === "boolean") {
    return stageConfig.newEntriesDisabled;
  }
  return false;
}

function coerceCaseFields(fields: Record<string, unknown> | null | undefined) {
  return fields ?? {};
}

export function mapConfiguredFields(mapping: Record<string, string>, fields: Record<string, unknown>) {
  const mapped: Record<string, unknown> = {};
  for (const [toKey, fromKey] of Object.entries(mapping)) {
    if (Object.hasOwn(fields, fromKey)) {
      mapped[toKey] = fields[fromKey];
    }
  }
  return mapped;
}

function isRoutineVariableValue(value: unknown): value is RoutineVariableValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function pickRoutineVariableValues(fields: Record<string, unknown>) {
  const picked: Record<string, RoutineVariableValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (isRoutineVariableValue(value)) {
      picked[key] = value;
    }
  }
  return picked;
}

function mapConfiguredRoutineValues(mapping: Record<string, string>, fields: Record<string, unknown>) {
  const mapped: Record<string, RoutineVariableValue> = {};
  for (const [toKey, fromKey] of Object.entries(mapping)) {
    const value = fields[fromKey];
    if (isRoutineVariableValue(value)) {
      mapped[toKey] = value;
    }
  }
  return mapped;
}

export function parseStageOnEnterRoutineConfig(config: PipelineStageConfig | unknown): PipelineStageRunRoutineConfig | null {
  const stageConfig = normalizeStageConfig(config);
  if (!isNonNullableObject(stageConfig.onEnter)) return null;
  const raw = (stageConfig.onEnter as { run_routine?: unknown }).run_routine;
  if (raw == null || typeof raw !== "object") return null;
  const parsed = pipelineStageRunRoutineSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}

function makeRoutineActorInput(actor?: PipelineCaseActor) {
  if (!actor) return undefined;
  if (actor.actorType === "agent") {
    return { agentId: actor.actorId, userId: null };
  }
  if (actor.actorType === "system") {
    return { agentId: null, userId: null };
  }
  return { agentId: null, userId: actor.actorId };
}

export async function triggerStageOnEnter(
  _db: Db,
  svc: ReturnType<typeof routineService>,
  stage: PipelineStageRow,
  caseRow: PipelineCaseRow,
  fields: Record<string, unknown>,
  actor?: PipelineCaseActor,
) {
  const onEnter = parseStageOnEnterRoutineConfig(stage.config);
  if (!onEnter) return;
  const mappedPayloadCaseFields = mapConfiguredFields(onEnter.caseFields ?? {}, fields);
  const mappedCaseFields = mapConfiguredRoutineValues(onEnter.caseFields ?? {}, fields);
  const mappedVariables = mapConfiguredRoutineValues(onEnter.variables, fields);
  await svc.runRoutine(onEnter.routineId, {
    source: "api",
    payload: {
      ...onEnter.payload,
      pipelineId: stage.pipelineId,
      caseId: caseRow.id,
      caseTitle: caseRow.title,
      ...mappedPayloadCaseFields,
    },
    variables: mappedVariables,
    caseFields: Object.keys(mappedCaseFields).length > 0 ? mappedCaseFields : pickRoutineVariableValues(fields),
  }, makeRoutineActorInput(actor));
}

async function resolvePipelineIntakeStage(db: PipelineDb, pipelineId: string, stageId?: string | null) {
  if (stageId) {
    const row = await db
      .select()
      .from(pipelineStages)
      .where(and(eq(pipelineStages.pipelineId, pipelineId), eq(pipelineStages.id, stageId)))
      .then((rows) => rows[0] ?? null);
    if (!row) {
      throw unprocessable("Stage does not belong to this pipeline");
    }
    return row;
  }

  const first = await db
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.pipelineId, pipelineId))
    .orderBy(asc(pipelineStages.position), asc(pipelineStages.createdAt))
    .limit(1);
  if (first.length === 0) {
    throw unprocessable("Pipeline has no stages");
  }
  const row = first[0];
  if (!row) {
    throw unprocessable("Pipeline has no stages");
  }
  return row;
}

function validateStageRequiredFieldsForIngest(stage: PipelineStageRow, fields: Record<string, unknown>) {
  if (isStageNewEntryDisabled(stage.config)) {
    throw unprocessable(`Stage "${stage.name}" is disabled for new entries`);
  }
  const config = normalizeStageConfig(stage.config);
  const requiredVariables = Array.isArray(config.variables)
    ? config.variables.filter((variable) => variable.showInAddForm)
    : [];
  validateStageRequiredFields(fields, requiredVariables);
}

type PipelineTransitionPayload = {
  transitions: Array<{
    fromStageId: string;
    toStageId: string;
    config?: Record<string, unknown>;
  }>;
  enforceTransitions?: boolean;
};

type PipelineListOptions = {
  q?: string;
  includeConnections?: boolean;
  includeCounts?: boolean;
};

type PipelineCaseListOptions = {
  stageId?: string;
  status?: string;
  q?: string;
  limit: number;
  offset: number;
};

type PipelineWithRelations = PipelineRow & {
  stages?: PipelineStageRow[];
  transitions?: PipelineTransitionSelect[];
  guidanceDocuments?: PipelineGuidanceDocument[];
  caseCount?: number;
  openCaseCount?: number;
  connections?: {
    upstreamPipelineIds?: string[];
    downstreamPipelineIds?: string[];
  };
};

const DEFAULT_CASE_LIST_LIMIT = 100;
const MAX_CASE_LIST_LIMIT = 500;

function parseQueryValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function clampCaseLimit(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CASE_LIST_LIMIT;
  if (value <= 0) return 1;
  if (value > MAX_CASE_LIST_LIMIT) return MAX_CASE_LIST_LIMIT;
  return Math.floor(value);
}

async function findPipeline(db: PipelineDb, pipelineId: string) {
  return db
    .select()
    .from(pipelines)
    .where(eq(pipelines.id, pipelineId))
    .then((rows) => rows[0] ?? null);
}

async function findPipelineCase(db: PipelineDb, caseId: string) {
  return db
    .select()
    .from(pipelineCases)
    .where(eq(pipelineCases.id, caseId))
    .then((rows) => rows[0] ?? null);
}

async function assertStageBelongsToPipeline(db: PipelineDb, pipelineId: string, stageId: string | undefined | null) {
  if (!stageId) return;
  const row = await db
    .select({ id: pipelineStages.id })
    .from(pipelineStages)
    .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, pipelineId)))
    .then((rows) => rows[0] ?? null);
  if (!row) {
    throw unprocessable("Stage does not belong to this pipeline");
  }
}

async function assertCaseBelongsToPipeline(db: PipelineDb, pipelineId: string, caseId: string | undefined | null) {
  if (!caseId) return;
  const row = await db
    .select({ pipelineId: pipelineCases.pipelineId })
    .from(pipelineCases)
    .where(eq(pipelineCases.id, caseId))
    .then((rows) => rows[0] ?? null);
  if (!row) {
    throw unprocessable("Reference case not found");
  }
  if (row.pipelineId !== pipelineId) {
    throw unprocessable("Reference case must belong to this pipeline");
  }
}

async function assertIssueBelongsToPipeline(db: PipelineDb, companyId: string, issueId: string) {
  const row = await db
    .select({ companyId: issues.companyId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);
  if (!row) {
    throw unprocessable("Issue not found");
  }
  if (row.companyId !== companyId) {
    throw unprocessable("Issue must belong to this company");
  }
}

async function writeCaseEvent(db: PipelineDb, row: PipelineCaseEventInsert) {
  const [event] = await db.insert(pipelineCaseEvents).values(row).returning();
  return event;
}

export function pipelineService(db: Db) {
  const routineSvc = routineService(db);

  return {
    listPipelines: async (
      companyId: string,
      query: PipelineListOptions = {},
    ): Promise<PipelineWithRelations[] | PipelineRow[]> => {
      const whereClauses = [eq(pipelines.companyId, companyId)] as Parameters<typeof and>[0][];
      const q = parseQueryValue(query.q);
      if (q) {
        whereClauses.push(ilike(pipelines.name, `%${q}%`));
      }

      const rows = await db
        .select()
        .from(pipelines)
        .where(and(...whereClauses))
        .orderBy(asc(pipelines.name), asc(pipelines.createdAt));

      if (!query.includeCounts && !query.includeConnections) {
        return rows;
      }

      if (rows.length === 0) {
        return rows as PipelineWithRelations[];
      }

      const pipelineIds = rows.map((row) => row.id);
      const [caseCounts, openCaseCounts] = await Promise.all([
        db
          .select({
            pipelineId: pipelineCases.pipelineId,
            count: count(),
          })
          .from(pipelineCases)
          .where(inArray(pipelineCases.pipelineId, pipelineIds))
          .groupBy(pipelineCases.pipelineId),
        db
          .select({
            pipelineId: pipelineCases.pipelineId,
            count: count(),
          })
          .from(pipelineCases)
          .where(and(inArray(pipelineCases.pipelineId, pipelineIds), ne(pipelineCases.status, "done"), ne(pipelineCases.status, "cancelled")))
          .groupBy(pipelineCases.pipelineId),
      ]);

      const caseCountByPipeline = new Map(caseCounts.map((row) => [row.pipelineId, Number(row.count)]));
      const openCaseCountByPipeline = new Map(openCaseCounts.map((row) => [row.pipelineId, Number(row.count)]));

      return rows.map((pipeline) => ({
        ...pipeline,
        caseCount: caseCountByPipeline.get(pipeline.id) ?? 0,
        openCaseCount: openCaseCountByPipeline.get(pipeline.id) ?? 0,
        ...(query.includeConnections
          ? {
            connections: {
              upstreamPipelineIds: [],
              downstreamPipelineIds: [],
            },
          }
          : {}),
      }));
    },

    getPipeline: async (pipelineId: string) => findPipeline(db, pipelineId),

    getPipelineWithRelations: async (pipelineId: string) => {
      const pipeline = await findPipeline(db, pipelineId);
      if (!pipeline) return null;
      const [stages, transitions, guidanceDocuments] = await Promise.all([
        db
          .select()
          .from(pipelineStages)
          .where(eq(pipelineStages.pipelineId, pipelineId))
          .orderBy(asc(pipelineStages.position), asc(pipelineStages.createdAt)),
        db
          .select()
          .from(pipelineTransitions)
          .where(eq(pipelineTransitions.pipelineId, pipelineId))
          .orderBy(asc(pipelineTransitions.fromStageId), asc(pipelineTransitions.toStageId)),
        db
          .select()
          .from(pipelineGuidanceDocuments)
          .where(eq(pipelineGuidanceDocuments.pipelineId, pipelineId))
          .orderBy(asc(pipelineGuidanceDocuments.key)),
      ]);

      return {
        ...pipeline,
        stages,
        transitions,
        guidanceDocuments,
      } satisfies PipelineWithRelations;
    },

    createPipeline: async (companyId: string, input: PipelineInput) => {
      const [pipeline] = await db
        .insert(pipelines)
        .values({ ...input, companyId })
        .returning();
      if (!pipeline) {
        throw conflict("Failed to create pipeline");
      }
      return pipeline as PipelineRow;
    },

    updatePipeline: async (pipelineId: string, input: Partial<PipelineInput>) => {
      const [pipeline] = await db
        .update(pipelines)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(pipelines.id, pipelineId))
        .returning();
      return pipeline ? pipeline as PipelineRow : null;
    },

    removePipeline: async (pipelineId: string) => {
      const [pipeline] = await db
        .delete(pipelines)
        .where(eq(pipelines.id, pipelineId))
        .returning();
      return pipeline ? pipeline as PipelineRow : null;
    },

    listPipelineStages: async (pipelineId: string) =>
      db
        .select()
        .from(pipelineStages)
        .where(eq(pipelineStages.pipelineId, pipelineId))
        .orderBy(asc(pipelineStages.position), asc(pipelineStages.createdAt)),

    createPipelineStage: async (pipelineId: string, input: PipelineStageInput) => {
      const pipeline = await findPipeline(db, pipelineId);
      if (!pipeline) {
        throw notFound("Pipeline not found");
      }

      const nextPos = input.position !== undefined
        ? input.position
        : await db
          .select({ maxPos: max(pipelineStages.position) })
          .from(pipelineStages)
          .where(eq(pipelineStages.pipelineId, pipelineId))
          .then((rows) => {
            const maxPos = rows[0]?.maxPos;
            if (typeof maxPos === "number") {
              return maxPos + 1;
            }
            return 0;
          });

      try {
        if (input.position !== undefined) {
          const stage = await db.transaction(async (tx) => {
            await tx
              .update(pipelineStages)
              .set({ position: sql`${pipelineStages.position} + 10000`, updatedAt: new Date() })
              .where(and(eq(pipelineStages.pipelineId, pipelineId), sql`${pipelineStages.position} >= ${nextPos}`));

            const [inserted] = await tx
              .insert(pipelineStages)
              .values({
                ...input,
                pipelineId,
                position: nextPos,
                config: input.config ?? { variables: [] },
              })
              .returning();

            await tx
              .update(pipelineStages)
              .set({ position: sql`${pipelineStages.position} - 9999`, updatedAt: new Date() })
              .where(and(eq(pipelineStages.pipelineId, pipelineId), sql`${pipelineStages.position} >= ${nextPos + 10000}`));

            return inserted;
          });
          if (!stage) {
            throw conflict("Failed to create pipeline stage");
          }
          return stage as PipelineStageRow;
        }

        const [stage] = await db
          .insert(pipelineStages)
          .values({
            ...input,
            pipelineId,
            position: nextPos,
            config: input.config ?? { variables: [] },
          })
          .returning();
        return stage as PipelineStageRow;
      } catch (err) {
        if ((err as { code?: unknown }).code === "23505") {
          throw conflict("Pipeline stage with this position already exists");
        }
        throw err;
      }
    },

    updatePipelineStage: async (pipelineId: string, stageId: string, input: Partial<PipelineStageInput>) => {
      if (Object.keys(input).length === 0) {
        return await db
          .select()
          .from(pipelineStages)
          .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, pipelineId)))
          .then((rows) => rows[0] ?? null);
      }

      try {
        const [stage] = await db
          .update(pipelineStages)
          .set({ ...input, updatedAt: new Date() })
          .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, pipelineId)))
          .returning();
        return stage ? stage as PipelineStageRow : null;
      } catch (err) {
        if ((err as { code?: unknown }).code === "23505") {
          throw conflict("Pipeline stage position is already in use");
        }
        throw err;
      }
    },

    removePipelineStage: async (pipelineId: string, stageId: string) => {
      const [removed] = await db
        .delete(pipelineStages)
        .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, pipelineId)))
        .returning();
      return removed ? removed as PipelineStageRow : null;
    },

    listPipelineTransitions: async (pipelineId: string) =>
      db
        .select()
        .from(pipelineTransitions)
        .where(eq(pipelineTransitions.pipelineId, pipelineId))
        .orderBy(asc(pipelineTransitions.fromStageId), asc(pipelineTransitions.toStageId)),

    setPipelineTransitions: async (pipelineId: string, payload: PipelineTransitionPayload) => {
      const pipeline = await findPipeline(db, pipelineId);
      if (!pipeline) {
        throw notFound("Pipeline not found");
      }

      const enforceTransitions = payload.enforceTransitions !== false;
      const transitions = payload.transitions.map((transition) => ({
        ...transition,
        pipelineId,
        config: transition.config ?? {},
      })) as PipelineTransitionInsert[];

      if (enforceTransitions && transitions.length > 0) {
        const stageIds = Array.from(new Set(transitions.flatMap((transition) => [transition.fromStageId, transition.toStageId])));
        if (stageIds.length > 0) {
          const known = await db
            .select({ id: pipelineStages.id })
            .from(pipelineStages)
            .where(and(eq(pipelineStages.pipelineId, pipelineId), inArray(pipelineStages.id, stageIds)));
          if (known.length !== stageIds.length) {
            throw unprocessable("Transition stage references must belong to this pipeline");
          }
        }
      }

      return db.transaction(async (tx) => {
        await tx.delete(pipelineTransitions).where(eq(pipelineTransitions.pipelineId, pipelineId));
        if (transitions.length === 0) {
          return [];
        }
        return tx
          .insert(pipelineTransitions)
          .values(transitions)
          .returning()
          .then((rows) => rows as PipelineTransitionSelect[]);
      });
    },

    listPipelineCases: async (
      pipelineId: string,
      query: PipelineCaseListOptions,
    ): Promise<PipelineCaseRow[]> => {
      const queryPipeline = await findPipeline(db, pipelineId);
      if (!queryPipeline) {
        throw notFound("Pipeline not found");
      }
      const where = [eq(pipelineCases.pipelineId, queryPipeline.id)] as Parameters<typeof and>[0][];
      const stageId = parseQueryValue(query.stageId);
      const status = parseQueryValue(query.status);
      const q = parseQueryValue(query.q);
      if (stageId) {
        where.push(eq(pipelineCases.stageId, stageId));
      }
      if (status) {
        where.push(eq(pipelineCases.status, status));
      }
      if (q) {
        where.push(ilike(pipelineCases.title, `%${q}%`));
      }

      const limit = clampCaseLimit(query.limit);
      const offset = Math.max(0, Number.isFinite(query.offset) ? Math.floor(query.offset) : 0);

      return db
        .select()
        .from(pipelineCases)
        .where(and(...where))
        .orderBy(desc(sql`coalesce(${pipelineCases.lastActivityAt}, ${pipelineCases.updatedAt}, ${pipelineCases.createdAt})`), asc(pipelineCases.id))
        .limit(limit)
        .offset(offset);
    },

    getPipelineCase: async (caseId: string) => findPipelineCase(db, caseId),

    ingestPipelineCase: async (
      pipelineId: string,
      input: Omit<PipelineCaseInsert, "id" | "createdAt" | "updatedAt" | "companyId">,
      actor?: PipelineCaseActor,
    ) => {
      const stage = await resolvePipelineIntakeStage(db, pipelineId, input.stageId);
      validateStageRequiredFieldsForIngest(stage, coerceCaseFields(input.fields));
      const [createdCase] = await db.transaction(async (tx) => {
        await assertCaseBelongsToPipeline(tx, pipelineId, input.parentCaseId);
        const pipeline = await findPipeline(tx, pipelineId);
        if (!pipeline) {
          throw notFound("Pipeline not found");
        }

        const [created] = await tx
          .insert(pipelineCases)
          .values({
            ...input,
            companyId: pipeline.companyId,
            pipelineId,
            status: input.status ?? "open",
            stageId: stage.id,
            fields: coerceCaseFields(input.fields),
            createdByActorId: actor?.actorId,
            createdByActorType: actor?.actorType,
            lastActivityAt: new Date(),
          })
          .returning();
        if (!created) {
          throw conflict("Failed to create case");
        }

        await writeCaseEvent(tx, {
          companyId: pipeline.companyId,
          pipelineId,
          caseId: created.id,
          kind: "case.ingested",
          summary: `Case ingested: ${created.title}`,
          payload: {
            status: created.status,
          },
        });

        return [created] as [PipelineCaseRow];
      });
      await triggerStageOnEnter(
        db,
        routineSvc,
        stage,
        createdCase,
        coerceCaseFields(input.fields),
        actor,
      );
      return createdCase;
    },

    ingestPipelineCases: async (
      pipelineId: string,
      items: Array<{
        title: string;
        status?: string;
        stageId?: string | null;
        parentCaseId?: string | null;
        fields?: Record<string, unknown>;
      }>,
      actor?: PipelineCaseActor,
    ) => {
      const pipeline = await findPipeline(db, pipelineId);
      if (!pipeline) {
        throw notFound("Pipeline not found");
      }
      let defaultStage: PipelineStageRow | null | undefined;
      const created = await db.transaction(async (tx) => {
        const created: Array<{ caseRow: PipelineCaseRow; stage: PipelineStageRow; fields: Record<string, unknown> }> = [];
        for (const item of items) {
          const stage = item.stageId
            ? await resolvePipelineIntakeStage(tx, pipelineId, item.stageId)
            : defaultStage ?? (defaultStage = await resolvePipelineIntakeStage(tx, pipelineId));
          const fields = coerceCaseFields(item.fields);
          validateStageRequiredFieldsForIngest(stage, fields);
          const next: PipelineCaseInsert = {
            ...item,
            companyId: pipeline.companyId,
            pipelineId,
            stageId: stage.id,
            status: item.status ?? "open",
            fields,
            createdByActorId: actor?.actorId,
            createdByActorType: actor?.actorType,
            lastActivityAt: new Date(),
          } as PipelineCaseInsert;
          await assertCaseBelongsToPipeline(tx, pipelineId, item.parentCaseId ?? null);
          const [createdCase] = await tx
            .insert(pipelineCases)
            .values(next)
            .returning();
          if (!createdCase) {
            throw conflict("Failed to create case");
          }
          await writeCaseEvent(tx, {
            companyId: pipeline.companyId,
            pipelineId,
            caseId: createdCase.id,
            kind: "case.ingested",
            summary: `Case ingested: ${createdCase.title}`,
            payload: {
              status: createdCase.status,
            },
          });
          created.push({
            caseRow: createdCase,
            stage,
            fields,
          });
        }
        return created;
      });
      for (const { caseRow, stage, fields } of created) {
        await triggerStageOnEnter(
          db,
          routineSvc,
          stage,
          caseRow,
          fields,
          actor,
        );
      }
      return created.map((entry) => entry.caseRow);
    },

    updatePipelineCase: async (
      caseId: string,
      input: Partial<Pick<PipelineCaseInsert, "title" | "status" | "stageId" | "fields">>,
    ) => {
      const current = await findPipelineCase(db, caseId);
      if (!current) return null;
      await assertStageBelongsToPipeline(db, current.pipelineId, input.stageId);
      const [updated] = await db
        .update(pipelineCases)
        .set({ ...input, lastActivityAt: new Date(), updatedAt: new Date() })
        .where(eq(pipelineCases.id, caseId))
        .returning();
      if (!updated) return null;
      await writeCaseEvent(db, {
        companyId: current.companyId,
        pipelineId: current.pipelineId,
        caseId: current.id,
        kind: "case.updated",
        summary: `Case updated: ${current.title}`,
        payload: input,
      });
      return updated as PipelineCaseRow;
    },

    transitionCaseStage: async (caseId: string, toStageId: string, options?: PipelineCaseTransitionOptions) => {
      const current = await findPipelineCase(db, caseId);
      if (!current) return null;
      await assertStageBelongsToPipeline(db, current.pipelineId, toStageId);
      if (current.stageId === toStageId) {
        return current;
      }
      const nextStage = await db
        .select()
        .from(pipelineStages)
        .where(and(eq(pipelineStages.pipelineId, current.pipelineId), eq(pipelineStages.id, toStageId)))
        .then((rows) => rows[0] ?? null);
      if (!nextStage) {
        throw notFound("Stage not found");
      }
      const [updated] = await db
        .update(pipelineCases)
        .set({ stageId: toStageId, lastActivityAt: new Date(), updatedAt: new Date() })
        .where(eq(pipelineCases.id, caseId))
        .returning();
      if (!updated) return null;
      await writeCaseEvent(db, {
        companyId: current.companyId,
        pipelineId: current.pipelineId,
        caseId,
        kind: "case.transitioned",
        summary: `Case transitioned: ${current.title}`,
        payload: {
          fromStageId: current.stageId,
          toStageId,
          reason: options?.reason ?? null,
        },
      });
      await triggerStageOnEnter(
        db,
        routineSvc,
        nextStage,
        updated,
        coerceCaseFields(updated.fields as Record<string, unknown> | null | undefined),
        options,
      );
      return updated as PipelineCaseRow;
    },

    createCaseBlocker: async (caseId: string, blockedByCaseId: string, reason?: string | null) => {
      const current = await findPipelineCase(db, caseId);
      if (!current) return null;
      if (caseId === blockedByCaseId) {
        throw unprocessable("A case cannot block itself");
      }
      const blockerCase = await findPipelineCase(db, blockedByCaseId);
      if (!blockerCase) {
        throw unprocessable("Blocked-by case not found");
      }
      if (blockerCase.pipelineId !== current.pipelineId) {
        throw unprocessable("Blocked-by case must belong to this pipeline");
      }
      try {
        const [created] = await db
          .insert(pipelineCaseBlockers)
          .values({
            caseId,
            blockedByCaseId,
            reason: reason ?? null,
            resolved: false,
          })
          .returning();
        return created as PipelineCaseBlocker;
      } catch (err) {
        if ((err as { code?: unknown }).code === "23505") {
          throw conflict("Blocker already exists");
        }
        throw err;
      }
    },

    listCaseBlockers: async (caseId: string) => {
      return db
        .select()
        .from(pipelineCaseBlockers)
        .where(eq(pipelineCaseBlockers.caseId, caseId))
        .orderBy(asc(pipelineCaseBlockers.createdAt));
    },

    resolveCaseBlocker: async (caseId: string, blockerId: string) => {
      const [updated] = await db
        .update(pipelineCaseBlockers)
        .set({ resolved: true, resolvedAt: new Date() })
        .where(and(eq(pipelineCaseBlockers.id, blockerId), eq(pipelineCaseBlockers.caseId, caseId)))
        .returning();
      return updated ? updated as PipelineCaseBlocker : null;
    },

    listGuidanceDocuments: async (pipelineId: string) =>
      db
        .select()
        .from(pipelineGuidanceDocuments)
        .where(eq(pipelineGuidanceDocuments.pipelineId, pipelineId))
        .orderBy(asc(pipelineGuidanceDocuments.key)),

    getGuidanceDocument: async (pipelineId: string, key: string) => {
      return db
        .select()
        .from(pipelineGuidanceDocuments)
        .where(and(eq(pipelineGuidanceDocuments.pipelineId, pipelineId), eq(pipelineGuidanceDocuments.key, key)))
        .then((rows) => rows[0] ?? null);
    },

    upsertGuidanceDocument: async (
      pipelineId: string,
      key: string,
      input: Pick<PipelineGuidanceDocument, "title" | "body">,
    ) => {
      const existing = await db
        .select({ id: pipelineGuidanceDocuments.id })
        .from(pipelineGuidanceDocuments)
        .where(and(eq(pipelineGuidanceDocuments.pipelineId, pipelineId), eq(pipelineGuidanceDocuments.key, key)))
        .then((rows) => rows[0] ?? null);
      if (existing) {
        const [updated] = await db
          .update(pipelineGuidanceDocuments)
          .set({
            title: input.title,
            body: input.body,
            updatedAt: new Date(),
          })
          .where(and(eq(pipelineGuidanceDocuments.pipelineId, pipelineId), eq(pipelineGuidanceDocuments.key, key)))
          .returning();
        return updated as PipelineGuidanceDocument;
      }
      const [created] = await db
        .insert(pipelineGuidanceDocuments)
        .values({
          pipelineId,
          key,
          title: input.title,
          body: input.body,
        })
        .returning();
      return created as PipelineGuidanceDocument;
    },

    deleteGuidanceDocument: async (pipelineId: string, key: string) => {
      const [deleted] = await db
        .delete(pipelineGuidanceDocuments)
        .where(and(eq(pipelineGuidanceDocuments.pipelineId, pipelineId), eq(pipelineGuidanceDocuments.key, key)))
        .returning();
      return deleted ? deleted as PipelineGuidanceDocument : null;
    },

    linkCaseIssue: async (caseId: string, issueId: string, role: string) => {
      const current = await findPipelineCase(db, caseId);
      if (!current) return null;
      await assertIssueBelongsToPipeline(db, current.companyId, issueId);
      try {
        const [created] = await db
          .insert(pipelineCaseIssueLinks)
          .values({
            caseId,
            issueId,
            role,
          })
          .returning();
        return created as PipelineCaseIssueLink;
      } catch (err) {
        if ((err as { code?: unknown }).code === "23505") {
          throw conflict("Case issue link already exists");
        }
        throw err;
      }
    },

    listCaseIssueLinks: async (caseId: string) => {
      return db
        .select()
        .from(pipelineCaseIssueLinks)
        .where(eq(pipelineCaseIssueLinks.caseId, caseId))
        .orderBy(asc(pipelineCaseIssueLinks.createdAt));
    },

    unlinkCaseIssue: async (linkId: string, caseId: string) => {
      const [deleted] = await db
        .delete(pipelineCaseIssueLinks)
        .where(and(eq(pipelineCaseIssueLinks.id, linkId), eq(pipelineCaseIssueLinks.caseId, caseId)))
        .returning();
      return deleted ? deleted as PipelineCaseIssueLink : null;
    },

    listCaseEvents: async (caseId: string): Promise<PipelineCaseEvent[]> => {
      const current = await findPipelineCase(db, caseId);
      if (!current) return [];
      return db
        .select()
        .from(pipelineCaseEvents)
        .where(eq(pipelineCaseEvents.caseId, current.id))
        .orderBy(desc(pipelineCaseEvents.createdAt));
    },

    listPipelineEvents: async (pipelineId: string): Promise<PipelineCaseEvent[]> => {
      return db
        .select()
        .from(pipelineCaseEvents)
        .where(eq(pipelineCaseEvents.pipelineId, pipelineId))
        .orderBy(desc(pipelineCaseEvents.createdAt));
    },

    listCompanyCaseEvents: async (
      companyId: string,
      query: ListCompanyCaseEventsQuery,
    ): Promise<PipelineCaseEventWithContext[]> => {
      const conditions = [eq(pipelineCaseEvents.companyId, companyId)];
      const types = normalizeCompanyCaseEventTypes(query.types);
      if (types.length > 0) {
        conditions.push(inArray(pipelineCaseEvents.kind, types));
      }
      if (query.pipelineId) {
        conditions.push(eq(pipelineCaseEvents.pipelineId, query.pipelineId));
      }

      const rows = await db
        .select({
          event: pipelineCaseEvents,
          caseTitle: pipelineCases.title,
          pipelineName: pipelines.name,
        })
        .from(pipelineCaseEvents)
        .leftJoin(pipelineCases, eq(pipelineCaseEvents.caseId, pipelineCases.id))
        .leftJoin(pipelines, eq(pipelineCaseEvents.pipelineId, pipelines.id))
        .where(and(...conditions))
        .orderBy(desc(pipelineCaseEvents.createdAt))
        .limit(query.limit)
        .offset(query.offset);

      const stageIds = Array.from(
        new Set(rows.flatMap((row) => eventPayloadStageIds(row.event.payload))),
      );
      const stageRows = stageIds.length > 0
        ? await db
          .select({ id: pipelineStages.id, name: pipelineStages.name })
          .from(pipelineStages)
          .where(inArray(pipelineStages.id, stageIds))
        : [];
      const stageNameById = new Map(stageRows.map((stage) => [stage.id, stage.name]));

      return rows.map((row) => {
        const payload = row.event.payload;
        const fromStageId = typeof payload?.fromStageId === "string" ? payload.fromStageId : null;
        const toStageId = typeof payload?.toStageId === "string" ? payload.toStageId : null;
        return {
          ...row.event,
          caseTitle: row.caseTitle,
          pipelineName: row.pipelineName,
          fromStageName: fromStageId ? stageNameById.get(fromStageId) ?? null : null,
          toStageName: toStageId ? stageNameById.get(toStageId) ?? null : null,
        };
      });
    },

    listCaseChildren: async (caseId: string) => {
      return db
        .select()
        .from(pipelineCases)
        .where(eq(pipelineCases.parentCaseId, caseId))
        .orderBy(asc(pipelineCases.createdAt));
    },

    suggestTransition: async (caseId: string, toStageId: string, reason?: string | null) => {
      const current = await findPipelineCase(db, caseId);
      if (!current) return null;
      await assertStageBelongsToPipeline(db, current.pipelineId, toStageId);
      const fields = { ...(current.fields ?? {}) } as Record<string, unknown>;
      fields.nextSuggestedStageId = toStageId;
      if (reason) {
        fields.nextSuggestedStageReason = reason;
      }
      const [updated] = await db
        .update(pipelineCases)
        .set({
          fields,
          lastActivityAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(pipelineCases.id, caseId))
        .returning();
      if (!updated) return null;
      await writeCaseEvent(db, {
        companyId: current.companyId,
        pipelineId: current.pipelineId,
        caseId,
        kind: "case.suggested",
        summary: `Case suggestion added for ${current.title}`,
        payload: { toStageId, reason },
      });
      return updated;
    },

    resolveSuggestion: async (caseId: string, decision: "accept" | "decline", note?: string | null) => {
      const current = await findPipelineCase(db, caseId);
      if (!current) return null;
      const fields = { ...(current.fields ?? {}) } as Record<string, unknown>;
      fields.suggestionResolution = {
        decision,
        note,
        resolvedAt: new Date().toISOString(),
      };
      const [updated] = await db
        .update(pipelineCases)
        .set({
          fields,
          lastActivityAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(pipelineCases.id, caseId))
        .returning();
      if (!updated) return null;
      await writeCaseEvent(db, {
        companyId: current.companyId,
        pipelineId: current.pipelineId,
        caseId,
        kind: "case.suggestion_resolved",
        summary: `Case suggestion ${decision}`,
        payload: { decision, note },
      });
      return updated;
    },

    reviewCase: async (
      caseId: string,
      decision: "approve" | "request_changes" | "drop",
      note?: string | null,
    ) => {
      const current = await findPipelineCase(db, caseId);
      if (!current) return null;

      const nextStatus = decision === "approve" ? "done" : decision === "drop" ? "cancelled" : current.status;
      const payload = { ...(current.fields ?? {}) } as Record<string, unknown>;
      payload.review = {
        decision,
        note,
        reviewedAt: new Date().toISOString(),
      };
      const [updated] = await db
        .update(pipelineCases)
        .set({
          status: nextStatus,
          fields: payload,
          lastActivityAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(pipelineCases.id, caseId))
        .returning();
      if (!updated) return null;
      await writeCaseEvent(db, {
        companyId: current.companyId,
        pipelineId: current.pipelineId,
        caseId,
        kind: "case.reviewed",
        summary: `Case ${decision}`,
        payload: { decision, note },
      });
      return updated;
    },

    listReviewCases: async (companyId: string, query: ReviewCasesQuery) => {
      const filters = [
        eq(pipelineCases.companyId, companyId),
        ne(pipelineCases.status, "done"),
        ne(pipelineCases.status, "cancelled"),
      ];
      if (query.pipelineId) {
        filters.push(eq(pipelineCases.pipelineId, query.pipelineId));
      }
      filters.push(eq(pipelineStages.kind, query.kind ?? "review"));

      return db
        .select({
          id: pipelineCases.id,
          companyId: pipelineCases.companyId,
          pipelineId: pipelineCases.pipelineId,
          stageId: pipelineCases.stageId,
          parentCaseId: pipelineCases.parentCaseId,
          title: pipelineCases.title,
          status: pipelineCases.status,
          fields: pipelineCases.fields,
          createdByActorId: pipelineCases.createdByActorId,
          createdByActorType: pipelineCases.createdByActorType,
          lastActivityAt: pipelineCases.lastActivityAt,
          createdAt: pipelineCases.createdAt,
          updatedAt: pipelineCases.updatedAt,
        })
        .from(pipelineCases)
        .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
        .where(and(...filters))
        .orderBy(desc(sql`coalesce(${pipelineCases.lastActivityAt}, ${pipelineCases.updatedAt}, ${pipelineCases.createdAt})`))
        .limit(query.limit)
        .offset(query.offset);
    },

    bulkReviewCases: async (
      companyId: string,
      caseIds: string[],
      decision: "approve" | "request_changes" | "drop",
      note?: string | null,
    ) => {
      const rows = await db
        .select({ id: pipelineCases.id })
        .from(pipelineCases)
        .where(and(eq(pipelineCases.companyId, companyId), inArray(pipelineCases.id, caseIds)));

      const updated: PipelineCaseRow[] = [];
      for (const row of rows) {
        const reviewed = await pipelineService(db).reviewCase(row.id, decision, note);
        if (reviewed) updated.push(reviewed);
      }
      return updated;
    },

    listPipelinesAttention: async (companyId: string) => {
      const attention = await db
        .select({
          pipelineId: pipelineCases.pipelineId,
          id: pipelineCases.id,
          title: pipelineCases.title,
        })
        .from(pipelineCases)
        .where(and(
          eq(pipelineCases.companyId, companyId),
          ne(pipelineCases.status, "done"),
          ne(pipelineCases.status, "cancelled"),
        ))
        .orderBy(desc(sql`coalesce(${pipelineCases.lastActivityAt}, ${pipelineCases.updatedAt}, ${pipelineCases.createdAt})`));
      return attention;
    },
  };
}
