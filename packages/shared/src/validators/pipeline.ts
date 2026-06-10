import { z } from "zod";

const routineVariableLikeNameSchema = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]*$/);

const pipelineStageRunRoutineVariableMapSchema = z.record(
  z.string().trim().min(1).max(120),
  z.string().trim().max(120),
);

export const pipelineStageRunRoutineSchema = z.object({
  routineId: z.string().uuid(),
  variables: pipelineStageRunRoutineVariableMapSchema.optional().default({}),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
  caseFields: pipelineStageRunRoutineVariableMapSchema.optional().default({}),
}).strict();

const pipelineStageOnEnterSchema = z.object({
  run_routine: pipelineStageRunRoutineSchema,
}).strict();

export const pipelineStageDisableConfigSchema = z.object({
  newEntries: z.boolean().optional().default(false),
  reason: z.string().trim().max(1_000).nullable().optional().default(null),
}).strict();

export const pipelineStageApprovalConfigSchema = z.object({
  required: z.boolean().optional().default(false),
  approverType: z.enum(["any_human", "human", "agent"]).optional().default("any_human"),
  approverId: z.string().trim().max(200).nullable().optional().default(null),
}).strict().superRefine((value, ctx) => {
  if (value.required && value.approverType !== "any_human" && !value.approverId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["approverId"],
      message: "A human or agent approver must be selected",
    });
  }
});

export const pipelineStageVariableSchema = z.object({
  key: routineVariableLikeNameSchema,
  label: z.string().trim().max(120),
  type: z.enum(["select", "text", "multiline"]).default("text"),
  options: z.array(z.string().trim().min(1).max(120)).max(50).optional().default([]),
  required: z.boolean().optional().default(false),
  showInAddForm: z.boolean().optional().default(false),
}).superRefine((value, ctx) => {
  if (value.type === "select" && value.options.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["options"],
      message: "Select variables require at least one option",
    });
  }
  if (value.type !== "select" && value.options.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["options"],
      message: "Only select variables can define options",
    });
  }
});

export const pipelineStageConfigSchema = z.object({
  variables: z.array(pipelineStageVariableSchema).default([]),
  onEnter: pipelineStageOnEnterSchema.optional(),
  disable: pipelineStageDisableConfigSchema.optional(),
  approval: pipelineStageApprovalConfigSchema.optional(),
  whatHappensHere: z.string().trim().max(10_000).optional(),
}).passthrough().superRefine((value, ctx) => {
  const keys = new Set<string>();
  value.variables.forEach((variable, index) => {
    if (keys.has(variable.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["variables", index, "key"],
        message: "Pipeline stage variable keys must be unique",
      });
    }
    keys.add(variable.key);
  });
});

export const pipelineStatusSchema = z.enum(["active", "paused", "archived"]);
export const pipelineStageKindSchema = z.enum(["open", "working", "review", "done", "cancelled"]);
export const pipelineCaseIssueLinkRoleSchema = z.enum(["origin", "conversation", "work", "automation"]);

export const createPipelineSchema = z.object({
  name: z.string().trim().min(1).max(180),
  description: z.string().trim().max(5_000).nullable().optional(),
  status: pipelineStatusSchema.optional().default("active"),
}).strict();

export const updatePipelineSchema = createPipelineSchema.partial().strict();

export const pipelineListQuerySchema = z.object({
  includeConnections: z.preprocess((value) => {
    if (value === undefined) return undefined;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return ["1", "true", "yes", "y"].includes(value.toLowerCase());
    return undefined;
  }, z.boolean().optional()),
  includeCounts: z.preprocess((value) => {
    if (value === undefined) return undefined;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return ["1", "true", "yes", "y"].includes(value.toLowerCase());
    return undefined;
  }, z.boolean().optional()),
  q: z.string().trim().max(200).optional(),
}).strict();

export const createPipelineStageSchema = z.object({
  name: z.string().trim().min(1).max(180),
  kind: pipelineStageKindSchema.optional().default("open"),
  position: z.number().int().nonnegative().optional(),
  config: pipelineStageConfigSchema.optional(),
}).strict();

export const updatePipelineStageSchema = createPipelineStageSchema.partial().strict();

export const pipelineTransitionConfigSchema = z.record(z.unknown()).default({});

export const pipelineTransitionSchema = z.object({
  fromStageId: z.string().uuid(),
  toStageId: z.string().uuid(),
  config: pipelineTransitionConfigSchema,
}).strict();

export const setPipelineTransitionsSchema = z.object({
  transitions: z.array(pipelineTransitionSchema),
  enforceTransitions: z.boolean().optional().default(true),
}).strict().superRefine((value, ctx) => {
  const transitionsByPair = new Map<string, number>();
  value.transitions.forEach((transition, index) => {
    const key = `${transition.fromStageId}:${transition.toStageId}`;
    const indexOfFirst = transitionsByPair.get(key);
    if (indexOfFirst !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transitions", index],
        message: `Duplicate transition from ${transition.fromStageId} to ${transition.toStageId}`,
      });
      return;
    }
    transitionsByPair.set(key, index);
    if (transition.fromStageId === transition.toStageId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transitions", index],
        message: "Transition destination must differ from source",
      });
    }
  });
});

export const createPipelineGuidanceDocumentSchema = z.object({
  title: z.string().trim().min(1).max(180),
  body: z.string().trim().min(1).max(200_000),
}).strict();

export const listPipelineCasesQuerySchema = z.object({
  stageId: z.string().uuid().optional(),
  status: z.string().trim().max(80).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "number") return value;
    if (typeof value === "string") return Number(value);
    return undefined;
  }, z.number().int().positive().max(500).default(100)),
  offset: z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "number") return value;
    if (typeof value === "string") return Number(value);
    return undefined;
  }, z.number().int().min(0).default(0)),
}).strict();

export const listCompanyCaseEventsQuerySchema = z.object({
  pipelineId: z.string().uuid().optional(),
  types: z.string().trim().max(500).optional(),
  limit: z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "number") return value;
    if (typeof value === "string") return Number(value);
    return undefined;
  }, z.number().int().positive().max(500).default(100)),
  offset: z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "number") return value;
    if (typeof value === "string") return Number(value);
    return undefined;
  }, z.number().int().min(0).default(0)),
}).strict();

export const pipelineCaseIngestSchema = z.object({
  title: z.string().trim().min(1).max(300),
  status: z.string().trim().max(80).optional().default("open"),
  stageId: z.string().uuid().optional().nullable(),
  parentCaseId: z.string().uuid().optional().nullable(),
  fields: z.record(z.string(), z.unknown()).optional().default({}),
}).strict().passthrough();

export const pipelineCaseBatchIngestSchema = z.object({
  items: z.array(pipelineCaseIngestSchema).min(1).max(100),
}).strict();

export const updatePipelineCaseSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  status: z.string().trim().max(80).optional(),
  stageId: z.string().uuid().optional().nullable(),
  fields: z.record(z.string(), z.unknown()).optional(),
}).strict().passthrough();

export const transitionCaseSchema = z.object({
  toStageId: z.string().uuid(),
  reason: z.string().trim().max(1_000).optional().nullable().default(null),
}).strict();

export const resolveCaseSuggestionSchema = z.object({
  decision: z.enum(["accept", "decline"]),
  note: z.string().trim().max(2_000).optional().nullable().default(null),
}).strict();

export const reviewCaseSchema = z.object({
  decision: z.enum(["approve", "request_changes", "drop"]),
  note: z.string().trim().max(2_000).optional().nullable().default(null),
}).strict();

export const reviewCasesQuerySchema = z.object({
  pipelineId: z.string().uuid().optional(),
  kind: z.string().trim().max(80).optional(),
  limit: z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "number") return value;
    if (typeof value === "string") return Number(value);
    return undefined;
  }, z.number().int().positive().max(500).default(100)),
  offset: z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "number") return value;
    if (typeof value === "string") return Number(value);
    return undefined;
  }, z.number().int().min(0).default(0)),
}).strict();

export const bulkReviewCasesSchema = z.object({
  caseIds: z.array(z.string().uuid()).min(1).max(100),
  decision: z.enum(["approve", "request_changes", "drop"]),
  note: z.string().trim().max(2_000).optional().nullable().default(null),
}).strict();

export const createPipelineCaseBlockerSchema = z.object({
  blockedByCaseId: z.string().uuid(),
  reason: z.string().trim().max(1_000).optional().nullable().default(null),
}).strict();

export const createPipelineCaseIssueLinkSchema = z.object({
  issueId: z.string().uuid(),
  role: pipelineCaseIssueLinkRoleSchema,
}).strict();

export const openConversationPayloadSchema = z.object({
  title: z.string().trim().max(300).optional(),
  description: z.string().trim().max(20_000).optional(),
  status: z.string().trim().max(80).optional().default("todo"),
  assigneeAgentId: z.string().uuid().optional().nullable(),
  assigneeUserId: z.string().trim().max(200).optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  role: pipelineCaseIssueLinkRoleSchema.optional().default("conversation"),
}).strict();

export type PipelineStatus = z.infer<typeof pipelineStatusSchema>;
export type PipelineStageKind = z.infer<typeof pipelineStageKindSchema>;
export type PipelineCaseIssueLinkRole = z.infer<typeof pipelineCaseIssueLinkRoleSchema>;
export type CreatePipeline = z.infer<typeof createPipelineSchema>;
export type UpdatePipeline = z.infer<typeof updatePipelineSchema>;
export type PipelineListQuery = z.infer<typeof pipelineListQuerySchema>;
export type CreatePipelineStage = z.infer<typeof createPipelineStageSchema>;
export type UpdatePipelineStage = z.infer<typeof updatePipelineStageSchema>;
export type PipelineTransition = z.infer<typeof pipelineTransitionSchema>;
export type SetPipelineTransitions = z.infer<typeof setPipelineTransitionsSchema>;
export type PipelineGuidanceDocumentUpsert = z.infer<typeof createPipelineGuidanceDocumentSchema>;
export type ListPipelineCasesQuery = z.infer<typeof listPipelineCasesQuerySchema>;
export type ListCompanyCaseEventsQuery = z.infer<typeof listCompanyCaseEventsQuerySchema>;
export type PipelineCaseIngest = z.infer<typeof pipelineCaseIngestSchema>;
export type PipelineCaseBatchIngest = z.infer<typeof pipelineCaseBatchIngestSchema>;
export type UpdatePipelineCase = z.infer<typeof updatePipelineCaseSchema>;
export type TransitionCaseInput = z.infer<typeof transitionCaseSchema>;
export type ResolveSuggestionInput = z.infer<typeof resolveCaseSuggestionSchema>;
export type ReviewCaseInput = z.infer<typeof reviewCaseSchema>;
export type ReviewCasesQuery = z.infer<typeof reviewCasesQuerySchema>;
export type BulkReviewCasesInput = z.infer<typeof bulkReviewCasesSchema>;
export type CreatePipelineCaseBlocker = z.infer<typeof createPipelineCaseBlockerSchema>;
export type CreatePipelineCaseIssueLink = z.infer<typeof createPipelineCaseIssueLinkSchema>;
export type OpenConversationPayload = z.infer<typeof openConversationPayloadSchema>;
export type PipelineCaseTransitionConfig = Record<string, unknown>;
export type PipelineCaseConfig = Record<string, unknown>;
export type PipelineStageConfig = z.infer<typeof pipelineStageConfigSchema>;
export type PipelineStageVariable = z.infer<typeof pipelineStageVariableSchema>;
export type PipelineStageDisableConfig = z.infer<typeof pipelineStageDisableConfigSchema>;
export type PipelineStageApprovalConfig = z.infer<typeof pipelineStageApprovalConfigSchema>;
export type PipelineStageRunRoutineConfig = z.infer<typeof pipelineStageRunRoutineSchema>;
