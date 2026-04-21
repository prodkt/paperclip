import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memoryExtractionJobs } from "@paperclipai/db";
import type {
  ListMemoryExtractionJobsQuery,
  MemoryExtractionJob,
  MemoryExtractionJobAttributionMode,
  MemoryExtractionJobDetail,
  MemoryExtractionJobDispatcherKind,
  MemoryExtractionJobEffectiveState,
  MemoryExtractionJobListResponse,
  MemoryExtractionJobOperationType,
  MemoryExtractionJobSourceKind,
  MemoryExtractionJobSourceRef,
  MemoryExtractionJobStatus,
  MemoryExtractionJobUsage,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";

type MemoryJobRecord = typeof memoryExtractionJobs.$inferSelect;

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_LIST_OFFSET = 0;
const CLAIM_RETRY_ATTEMPTS = 5;
const TERMINAL_MEMORY_JOB_STATUSES = new Set<MemoryExtractionJobStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

export const DEFAULT_MEMORY_JOB_RECOVERY_ERROR_CODE = "lease_expired";
export const DEFAULT_MEMORY_JOB_RECOVERY_ERROR = "Memory job lease expired before completion";

export interface CreateMemoryJobInput {
  companyId: string;
  bindingId: string;
  bindingKey: string;
  operationType: MemoryExtractionJobOperationType;
  sourceKind: MemoryExtractionJobSourceKind;
  sourceAgentId?: string | null;
  sourceIssueId?: string | null;
  sourceProjectId?: string | null;
  sourceGoalId?: string | null;
  sourceHeartbeatRunId?: string | null;
  hookKind?: MemoryJobRecord["hookKind"];
  providerJobId?: string | null;
  submittedAt?: Date;
  attributionMode?: MemoryExtractionJobAttributionMode;
  costCents?: number;
  resultSummary?: string | null;
  errorCode?: string | null;
  error?: string | null;
  sourceRefJson?: MemoryExtractionJobSourceRef | null;
  dispatcherKind?: MemoryExtractionJobDispatcherKind;
  usageJson?: MemoryExtractionJobUsage | null;
  resultJson?: Record<string, unknown> | null;
}

export interface ClaimMemoryJobInput {
  leaseDurationMs: number;
  companyId?: string;
  dispatcherKind?: MemoryExtractionJobDispatcherKind;
  now?: Date;
}

interface MemoryJobLifecycleUpdate {
  companyId: string;
  jobId: string;
  now?: Date;
  providerJobId?: string | null;
  attributionMode?: MemoryExtractionJobAttributionMode;
  costCents?: number;
  resultSummary?: string | null;
  usageJson?: MemoryExtractionJobUsage | null;
  resultJson?: Record<string, unknown> | null;
}

export interface UpdateRunningMemoryJobInput extends MemoryJobLifecycleUpdate {
  leaseDurationMs?: number | null;
}

export interface CompleteMemoryJobInput extends MemoryJobLifecycleUpdate {}

export interface FailMemoryJobInput extends MemoryJobLifecycleUpdate {
  errorCode?: string | null;
  error?: string | null;
}

export interface CancelMemoryJobInput {
  companyId: string;
  jobId: string;
  now?: Date;
  resultSummary?: string | null;
  errorCode?: string | null;
  error?: string | null;
}

export interface RecoverExpiredMemoryJobsInput {
  companyId?: string;
  limit?: number;
  now?: Date;
  errorCode?: string;
  error?: string;
}

export interface RecoverExpiredMemoryJobsResult {
  recovered: number;
  jobIds: string[];
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isMemoryJobStuck(
  job: Pick<MemoryJobRecord, "status" | "leaseExpiresAt">,
  now = new Date(),
): boolean {
  return (
    job.status === "running"
    && job.leaseExpiresAt !== null
    && job.leaseExpiresAt.getTime() <= now.getTime()
  );
}

function effectiveStateForMemoryJob(
  job: Pick<MemoryJobRecord, "status" | "leaseExpiresAt">,
  now = new Date(),
): MemoryExtractionJobEffectiveState {
  return isMemoryJobStuck(job, now) ? "stuck" : job.status;
}

function retryRootIdForJob(job: Pick<MemoryJobRecord, "id" | "retryOfJobId">): string {
  return job.retryOfJobId ?? job.id;
}

function rerunEligibleForJob(job: Pick<MemoryJobRecord, "status">): boolean {
  return TERMINAL_MEMORY_JOB_STATUSES.has(job.status);
}

function toMemoryExtractionJob(job: MemoryJobRecord): MemoryExtractionJob {
  return {
    id: job.id,
    companyId: job.companyId,
    bindingId: job.bindingId,
    bindingKey: job.bindingKey,
    operationType: job.operationType,
    status: job.status,
    sourceAgentId: job.sourceAgentId,
    sourceIssueId: job.sourceIssueId,
    sourceProjectId: job.sourceProjectId,
    sourceGoalId: job.sourceGoalId,
    sourceHeartbeatRunId: job.sourceHeartbeatRunId,
    hookKind: job.hookKind,
    providerJobId: job.providerJobId,
    submittedAt: job.submittedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    attributionMode: job.attributionMode,
    costCents: job.costCents,
    resultSummary: job.resultSummary,
    errorCode: job.errorCode,
    error: job.error,
    sourceKind: job.sourceKind,
    sourceRefJson: (job.sourceRefJson as MemoryExtractionJobSourceRef | null) ?? null,
    retryOfJobId: job.retryOfJobId,
    attemptNumber: job.attemptNumber,
    dispatcherKind: job.dispatcherKind,
    leaseExpiresAt: job.leaseExpiresAt,
    usageJson: (job.usageJson as MemoryExtractionJobUsage | null) ?? null,
    resultJson: (job.resultJson as Record<string, unknown> | null) ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function withLifecycleUpdates(
  base: Record<string, unknown>,
  input: Partial<
    MemoryJobLifecycleUpdate
    & FailMemoryJobInput
    & CancelMemoryJobInput
    & UpdateRunningMemoryJobInput
  >,
): Record<string, unknown> {
  if (hasOwn(input, "providerJobId")) {
    base.providerJobId = input.providerJobId ?? null;
  }
  if (hasOwn(input, "attributionMode")) {
    base.attributionMode = input.attributionMode;
  }
  if (hasOwn(input, "costCents")) {
    base.costCents = input.costCents;
  }
  if (hasOwn(input, "resultSummary")) {
    base.resultSummary = input.resultSummary ?? null;
  }
  if (hasOwn(input, "usageJson")) {
    base.usageJson = input.usageJson ?? null;
  }
  if (hasOwn(input, "resultJson")) {
    base.resultJson = input.resultJson ?? null;
  }
  if (hasOwn(input, "errorCode")) {
    base.errorCode = input.errorCode ?? null;
  }
  if (hasOwn(input, "error")) {
    base.error = input.error ?? null;
  }
  return base;
}

async function ensureMemoryJobExists(
  db: Db,
  companyId: string,
  jobId: string,
): Promise<MemoryJobRecord> {
  const row = await db
    .select()
    .from(memoryExtractionJobs)
    .where(and(eq(memoryExtractionJobs.companyId, companyId), eq(memoryExtractionJobs.id, jobId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!row) {
    throw notFound(`Memory job not found: ${jobId}`);
  }

  return row;
}

async function countRetryLineages(
  db: Db,
  companyId: string,
  rootIds: string[],
): Promise<Map<string, number>> {
  if (rootIds.length === 0) {
    return new Map();
  }

  const uniqueRootIds = [...new Set(rootIds)];
  const rows = await db
    .select({
      id: memoryExtractionJobs.id,
      retryOfJobId: memoryExtractionJobs.retryOfJobId,
    })
    .from(memoryExtractionJobs)
    .where(
      and(
        eq(memoryExtractionJobs.companyId, companyId),
        or(
          inArray(memoryExtractionJobs.id, uniqueRootIds),
          inArray(memoryExtractionJobs.retryOfJobId, uniqueRootIds),
        ),
      ),
    );

  const counts = new Map<string, number>();
  for (const row of rows) {
    const rootId = row.retryOfJobId ?? row.id;
    counts.set(rootId, (counts.get(rootId) ?? 0) + 1);
  }

  for (const rootId of uniqueRootIds) {
    if (!counts.has(rootId)) {
      counts.set(rootId, 1);
    }
  }

  return counts;
}

export function memoryJobStore(db: Db) {
  async function getJob(
    companyId: string,
    jobId: string,
  ): Promise<MemoryJobRecord | null> {
    return db
      .select()
      .from(memoryExtractionJobs)
      .where(and(eq(memoryExtractionJobs.companyId, companyId), eq(memoryExtractionJobs.id, jobId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getDetail(
    companyId: string,
    jobId: string,
    opts: { now?: Date } = {},
  ): Promise<MemoryExtractionJobDetail | null> {
    const row = await getJob(companyId, jobId);
    if (!row) {
      return null;
    }

    const now = opts.now ?? new Date();
    const rootId = retryRootIdForJob(row);
    const retryCounts = await countRetryLineages(db, companyId, [rootId]);
    const retryCount = Math.max((retryCounts.get(rootId) ?? 1) - 1, 0);

    return {
      ...toMemoryExtractionJob(row),
      effectiveState: effectiveStateForMemoryJob(row, now),
      retryCount,
      rerunEligible: rerunEligibleForJob(row),
    };
  }

  async function list(
    companyId: string,
    query: Partial<ListMemoryExtractionJobsQuery> = {},
    opts: { now?: Date } = {},
  ): Promise<MemoryExtractionJobListResponse> {
    const now = opts.now ?? new Date();
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const offset = query.offset ?? DEFAULT_LIST_OFFSET;
    const conditions = [eq(memoryExtractionJobs.companyId, companyId)];

    if (query.status) {
      conditions.push(eq(memoryExtractionJobs.status, query.status));
    }
    if (query.effectiveState === "stuck") {
      conditions.push(eq(memoryExtractionJobs.status, "running"));
      conditions.push(lte(memoryExtractionJobs.leaseExpiresAt, now));
    } else if (query.effectiveState === "running") {
      conditions.push(eq(memoryExtractionJobs.status, "running"));
      conditions.push(or(
        isNull(memoryExtractionJobs.leaseExpiresAt),
        gt(memoryExtractionJobs.leaseExpiresAt, now),
      )!);
    } else if (query.effectiveState) {
      conditions.push(eq(memoryExtractionJobs.status, query.effectiveState));
    }
    if (query.bindingKey) {
      conditions.push(eq(memoryExtractionJobs.bindingKey, query.bindingKey));
    }
    if (query.operationType) {
      conditions.push(eq(memoryExtractionJobs.operationType, query.operationType));
    }
    if (query.agentId) {
      conditions.push(eq(memoryExtractionJobs.sourceAgentId, query.agentId));
    }
    if (query.issueId) {
      conditions.push(eq(memoryExtractionJobs.sourceIssueId, query.issueId));
    }
    if (query.runId) {
      conditions.push(eq(memoryExtractionJobs.sourceHeartbeatRunId, query.runId));
    }
    if (query.submittedAfter) {
      conditions.push(gte(memoryExtractionJobs.submittedAt, query.submittedAfter));
    }
    if (query.submittedBefore) {
      conditions.push(lte(memoryExtractionJobs.submittedAt, query.submittedBefore));
    }

    const rows = await db
      .select()
      .from(memoryExtractionJobs)
      .where(and(...conditions))
      .orderBy(desc(memoryExtractionJobs.submittedAt), desc(memoryExtractionJobs.createdAt))
      .limit(limit + 1)
      .offset(offset);

    const visibleRows = rows.slice(0, limit);
    const retryCounts = await countRetryLineages(
      db,
      companyId,
      visibleRows.map((row) => retryRootIdForJob(row)),
    );

    return {
      jobs: visibleRows.map((row) => {
        const rootId = retryRootIdForJob(row);
        return {
          id: row.id,
          bindingId: row.bindingId,
          bindingKey: row.bindingKey,
          operationType: row.operationType,
          status: row.status,
          effectiveState: effectiveStateForMemoryJob(row, now),
          sourceAgentId: row.sourceAgentId,
          sourceIssueId: row.sourceIssueId,
          sourceProjectId: row.sourceProjectId,
          sourceGoalId: row.sourceGoalId,
          sourceHeartbeatRunId: row.sourceHeartbeatRunId,
          hookKind: row.hookKind,
          providerJobId: row.providerJobId,
          submittedAt: row.submittedAt,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          attributionMode: row.attributionMode,
          costCents: row.costCents,
          resultSummary: row.resultSummary,
          errorCode: row.errorCode,
          error: row.error,
          retryOfJobId: row.retryOfJobId,
          attemptNumber: row.attemptNumber,
          retryCount: Math.max((retryCounts.get(rootId) ?? 1) - 1, 0),
        };
      }),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }

  async function enqueue(input: CreateMemoryJobInput): Promise<MemoryJobRecord> {
    return db
      .insert(memoryExtractionJobs)
      .values({
        companyId: input.companyId,
        bindingId: input.bindingId,
        bindingKey: input.bindingKey,
        operationType: input.operationType,
        sourceKind: input.sourceKind,
        sourceAgentId: input.sourceAgentId ?? null,
        sourceIssueId: input.sourceIssueId ?? null,
        sourceProjectId: input.sourceProjectId ?? null,
        sourceGoalId: input.sourceGoalId ?? null,
        sourceHeartbeatRunId: input.sourceHeartbeatRunId ?? null,
        hookKind: input.hookKind ?? null,
        providerJobId: input.providerJobId ?? null,
        submittedAt: input.submittedAt,
        attributionMode: input.attributionMode ?? "untracked",
        costCents: input.costCents ?? 0,
        resultSummary: input.resultSummary ?? null,
        errorCode: input.errorCode ?? null,
        error: input.error ?? null,
        sourceRefJson: (input.sourceRefJson as Record<string, unknown> | null | undefined) ?? null,
        dispatcherKind: input.dispatcherKind ?? "in_process",
        usageJson: (input.usageJson as Record<string, unknown> | null | undefined) ?? null,
        resultJson: input.resultJson ?? null,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function claimNext(input: ClaimMemoryJobInput): Promise<MemoryJobRecord | null> {
    const now = input.now ?? new Date();
    const dispatcherKind = input.dispatcherKind ?? "in_process";
    const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);

    for (let attempt = 0; attempt < CLAIM_RETRY_ATTEMPTS; attempt++) {
      const conditions = [
        eq(memoryExtractionJobs.status, "queued"),
        eq(memoryExtractionJobs.dispatcherKind, dispatcherKind),
      ];

      if (input.companyId) {
        conditions.push(eq(memoryExtractionJobs.companyId, input.companyId));
      }

      const candidate = await db
        .select()
        .from(memoryExtractionJobs)
        .where(and(...conditions))
        .orderBy(asc(memoryExtractionJobs.submittedAt), asc(memoryExtractionJobs.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!candidate) {
        return null;
      }

      const claimed = await db
        .update(memoryExtractionJobs)
        .set({
          status: "running",
          startedAt: candidate.startedAt ?? now,
          leaseExpiresAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(memoryExtractionJobs.id, candidate.id),
            eq(memoryExtractionJobs.companyId, candidate.companyId),
            eq(memoryExtractionJobs.status, "queued"),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);

      if (claimed) {
        return claimed;
      }
    }

    return null;
  }

  async function updateRunning(input: UpdateRunningMemoryJobInput): Promise<MemoryJobRecord> {
    const now = input.now ?? new Date();
    const updates = withLifecycleUpdates({ updatedAt: now }, input);

    if (hasOwn(input, "leaseDurationMs")) {
      updates.leaseExpiresAt = input.leaseDurationMs === null
        ? null
        : new Date(now.getTime() + (input.leaseDurationMs ?? 0));
    }

    const updated = await db
      .update(memoryExtractionJobs)
      .set(updates)
      .where(
        and(
          eq(memoryExtractionJobs.companyId, input.companyId),
          eq(memoryExtractionJobs.id, input.jobId),
          eq(memoryExtractionJobs.status, "running"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      return updated;
    }

    const existing = await ensureMemoryJobExists(db, input.companyId, input.jobId);
    throw conflict(`Memory job ${existing.id} is not running`);
  }

  async function complete(input: CompleteMemoryJobInput): Promise<MemoryJobRecord> {
    const now = input.now ?? new Date();
    const updated = await db
      .update(memoryExtractionJobs)
      .set(
        withLifecycleUpdates(
          {
            status: "succeeded",
            finishedAt: now,
            leaseExpiresAt: null,
            errorCode: null,
            error: null,
            updatedAt: now,
          },
          input,
        ),
      )
      .where(
        and(
          eq(memoryExtractionJobs.companyId, input.companyId),
          eq(memoryExtractionJobs.id, input.jobId),
          eq(memoryExtractionJobs.status, "running"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      return updated;
    }

    const existing = await ensureMemoryJobExists(db, input.companyId, input.jobId);
    throw conflict(`Memory job ${existing.id} is not running`);
  }

  async function fail(input: FailMemoryJobInput): Promise<MemoryJobRecord> {
    const now = input.now ?? new Date();
    const updated = await db
      .update(memoryExtractionJobs)
      .set(
        withLifecycleUpdates(
          {
            status: "failed",
            finishedAt: now,
            leaseExpiresAt: null,
            updatedAt: now,
          },
          input,
        ),
      )
      .where(
        and(
          eq(memoryExtractionJobs.companyId, input.companyId),
          eq(memoryExtractionJobs.id, input.jobId),
          eq(memoryExtractionJobs.status, "running"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      return updated;
    }

    const existing = await ensureMemoryJobExists(db, input.companyId, input.jobId);
    throw conflict(`Memory job ${existing.id} is not running`);
  }

  async function cancel(input: CancelMemoryJobInput): Promise<MemoryJobRecord> {
    const now = input.now ?? new Date();
    const updated = await db
      .update(memoryExtractionJobs)
      .set(
        withLifecycleUpdates(
          {
            status: "cancelled",
            finishedAt: now,
            leaseExpiresAt: null,
            updatedAt: now,
          },
          input,
        ),
      )
      .where(
        and(
          eq(memoryExtractionJobs.companyId, input.companyId),
          eq(memoryExtractionJobs.id, input.jobId),
          inArray(memoryExtractionJobs.status, ["queued", "running"]),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      return updated;
    }

    const existing = await ensureMemoryJobExists(db, input.companyId, input.jobId);
    throw conflict(`Memory job ${existing.id} cannot be cancelled from status ${existing.status}`);
  }

  async function recoverExpiredLeases(
    input: RecoverExpiredMemoryJobsInput = {},
  ): Promise<RecoverExpiredMemoryJobsResult> {
    const now = input.now ?? new Date();
    const limit = input.limit ?? 100;
    const conditions = [eq(memoryExtractionJobs.status, "running"), lte(memoryExtractionJobs.leaseExpiresAt, now)];

    if (input.companyId) {
      conditions.push(eq(memoryExtractionJobs.companyId, input.companyId));
    }

    const expiredRows = await db
      .select({ id: memoryExtractionJobs.id })
      .from(memoryExtractionJobs)
      .where(and(...conditions))
      .orderBy(asc(memoryExtractionJobs.leaseExpiresAt), asc(memoryExtractionJobs.createdAt))
      .limit(limit);

    const expiredIds = expiredRows.map((row) => row.id);
    if (expiredIds.length === 0) {
      return { recovered: 0, jobIds: [] };
    }

    const updated = await db
      .update(memoryExtractionJobs)
      .set({
        status: "failed",
        finishedAt: now,
        leaseExpiresAt: null,
        updatedAt: now,
        errorCode: input.errorCode ?? DEFAULT_MEMORY_JOB_RECOVERY_ERROR_CODE,
        error: input.error ?? DEFAULT_MEMORY_JOB_RECOVERY_ERROR,
      })
      .where(
        and(
          inArray(memoryExtractionJobs.id, expiredIds),
          eq(memoryExtractionJobs.status, "running"),
        ),
      )
      .returning({ id: memoryExtractionJobs.id });

    return {
      recovered: updated.length,
      jobIds: updated.map((row) => row.id),
    };
  }

  async function rerun(
    companyId: string,
    jobId: string,
    opts: { now?: Date } = {},
  ): Promise<MemoryJobRecord> {
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const sourceJob = await ensureMemoryJobExists(txDb, companyId, jobId);

      if (!rerunEligibleForJob(sourceJob)) {
        throw conflict(`Memory job ${sourceJob.id} cannot be rerun from status ${sourceJob.status}`);
      }

      const retryRootId = retryRootIdForJob(sourceJob);
      await tx.execute(
        sql`select id from ${memoryExtractionJobs} where ${memoryExtractionJobs.companyId} = ${companyId} and ${memoryExtractionJobs.id} = ${retryRootId} for update`,
      );

      const lineageRows = await txDb
        .select({
          attemptNumber: memoryExtractionJobs.attemptNumber,
          status: memoryExtractionJobs.status,
        })
        .from(memoryExtractionJobs)
        .where(
          and(
            eq(memoryExtractionJobs.companyId, companyId),
            or(
              eq(memoryExtractionJobs.id, retryRootId),
              eq(memoryExtractionJobs.retryOfJobId, retryRootId),
            ),
          ),
        );

      const pendingAttempt = lineageRows.find((row) => row.status === "queued" || row.status === "running");
      if (pendingAttempt) {
        throw conflict(`Memory job ${retryRootId} already has a queued or running rerun attempt`);
      }

      const nextAttemptNumber = lineageRows.reduce((maxAttempt, row) => {
        return Math.max(maxAttempt, row.attemptNumber);
      }, 0) + 1;

      return txDb
        .insert(memoryExtractionJobs)
        .values({
          companyId: sourceJob.companyId,
          bindingId: sourceJob.bindingId,
          bindingKey: sourceJob.bindingKey,
          operationType: sourceJob.operationType,
          status: "queued",
          sourceAgentId: sourceJob.sourceAgentId,
          sourceIssueId: sourceJob.sourceIssueId,
          sourceProjectId: sourceJob.sourceProjectId,
          sourceGoalId: sourceJob.sourceGoalId,
          sourceHeartbeatRunId: sourceJob.sourceHeartbeatRunId,
          hookKind: sourceJob.hookKind,
          submittedAt: opts.now,
          attributionMode: sourceJob.attributionMode,
          costCents: 0,
          resultSummary: null,
          errorCode: null,
          error: null,
          sourceKind: sourceJob.sourceKind,
          sourceRefJson: sourceJob.sourceRefJson,
          retryOfJobId: retryRootId,
          attemptNumber: nextAttemptNumber,
          dispatcherKind: sourceJob.dispatcherKind,
          leaseExpiresAt: null,
          providerJobId: null,
          usageJson: null,
          resultJson: null,
          startedAt: null,
          finishedAt: null,
        })
        .returning()
        .then((rows) => rows[0]);
    });
  }

  return {
    getJob,
    getDetail,
    list,
    enqueue,
    claimNext,
    updateRunning,
    complete,
    fail,
    cancel,
    recoverExpiredLeases,
    rerun,
  };
}

export type MemoryJobStore = ReturnType<typeof memoryJobStore>;
export { effectiveStateForMemoryJob, isMemoryJobStuck };
