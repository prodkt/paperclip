import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";
import {
  MISSION_REQUIRED_DOCUMENT_KEYS,
  appendDecisionLogEntry,
  buildMissionEventEntry,
  buildMissionFindingWaiverEntry,
  isMissionRequiredDocumentKey,
  isValidationReportDocumentKey,
  parseMissionFeaturesDocument,
  parseMissionFindingWaivers,
  parseMissionValidationContractDocument,
  parseMissionValidationReportDocument,
  parseValidationReportRound,
  type MissionFeaturesDocument,
  type MissionFinding,
  type MissionFindingWaiverRecord,
  type MissionRequiredDocumentKey,
  type MissionState,
  type MissionValidationContract,
  type MissionValidationReport,
} from "./mission-documents.js";

export type MissionIssueKind = "mission" | "milestone" | "feature" | "validation" | "fix" | "fix_loop" | "other";
export type MissionStopReason =
  | "approval_required"
  | "budget_incident"
  | "invocation_block"
  | "unresolved_blockers"
  | "missing_assignee"
  | "paused_assignee"
  | "parse_error"
  | "max_validation_rounds";

export interface MissionDocumentChecklistItem {
  key: MissionRequiredDocumentKey;
  present: boolean;
  title: string | null;
}

export interface MissionParseProblem {
  issueId: string;
  key: string;
  message: string;
}

export interface MissionWorkItem {
  id: string;
  title: string;
  status: Issue["status"];
  assigneeAgentId: string | null;
  kind: MissionIssueKind;
  hasUnresolvedBlockers: boolean;
  originKind: string | null;
  originId: string | null;
}

export interface MissionValidationReportProjection {
  issueId: string;
  documentKey: string;
  title: string | null;
  round: number;
  validatorRole: MissionValidationReport["validator_role"];
  summary: string;
  updatedAt: string;
}

export interface MissionFindingProjection extends MissionFinding {
  sourceIssueId: string;
  sourceReportKey: string;
  sourceReportTitle: string | null;
  round: number;
  validatorRole: MissionValidationReport["validator_role"];
  computedStatus: MissionFinding["status"];
  fixIssueId: string | null;
  waiver: MissionFindingWaiverRecord | null;
}

export interface MissionSummary {
  isMission: boolean;
  missionIssueId: string;
  missionIdentifier: string | null;
  state: MissionState | null;
  documentChecklist: MissionDocumentChecklistItem[];
  missingRequiredDocumentKeys: MissionRequiredDocumentKey[];
  parseProblems: MissionParseProblem[];
  validationReports: MissionValidationReportProjection[];
  findings: MissionFindingProjection[];
  workItems: MissionWorkItem[];
  wakeableIssueIds: string[];
  stopReasons: MissionStopReason[];
  nextAction: string;
  openApprovalCount: number;
  openBudgetIncidentCount: number;
  invocationBlockCount: number;
  latestValidationRound: number;
}

export interface MissionAdvanceResult {
  issueId: string;
  outcome: "paused" | "woke_issues" | "created_fixes" | "complete" | "noop";
  stopReason: MissionStopReason | null;
  wokenIssueIds: string[];
  createdFixIssueIds: string[];
  details: Record<string, unknown>;
}

export interface MissionWaiveFindingResult {
  issueId: string;
  findingId: string;
  waived: boolean;
  rationale: string;
}

type PluginIssueOriginKindLike = `plugin:${string}`;

const DEFAULT_MAX_VALIDATION_ROUNDS = 2;
const ACTIVE_AGENT_STATUSES = new Set(["active", "idle", "running"]);
const PAUSED_AGENT_STATUSES = new Set(["paused", "pending_approval", "terminated", "error"]);

function missionOriginPrefix(ctx: PluginContext) {
  return `plugin:${ctx.manifest.id}` as PluginIssueOriginKindLike;
}

function kindFromOrigin(originKind: string | null | undefined, ctx: PluginContext): MissionIssueKind {
  const prefix = missionOriginPrefix(ctx);
  if (!originKind) return "other";
  if (originKind === prefix) return "mission";
  if (originKind === `${prefix}:milestone`) return "milestone";
  if (originKind === `${prefix}:feature`) return "feature";
  if (originKind === `${prefix}:validation`) return "validation";
  if (originKind === `${prefix}:fix`) return "fix";
  if (originKind === `${prefix}:fix_loop` || originKind === `${prefix}:fix-loop`) return "fix_loop";
  return "other";
}

function isTerminalStatus(status: Issue["status"]) {
  return status === "done" || status === "cancelled";
}

function isWakeableStatus(status: Issue["status"]) {
  return status === "todo" || status === "in_progress";
}

function isResolvableApprovalStatus(status: string) {
  const normalized = status.trim().toLowerCase();
  return normalized === "approved" || normalized === "denied" || normalized === "cancelled";
}

function buildActorLabel(actor: { actorAgentId?: string | null; actorUserId?: string | null; actorRunId?: string | null }) {
  if (actor.actorUserId) return `user:${actor.actorUserId}`;
  if (actor.actorAgentId) return `agent:${actor.actorAgentId}`;
  if (actor.actorRunId) return `run:${actor.actorRunId}`;
  return "plugin";
}

function stringifyError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function toIsoTimestamp(value: Date | string | null | undefined) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

async function loadRelevantDocuments(ctx: PluginContext, companyId: string, issueId: string) {
  const documents = await ctx.issues.documents.list(issueId, companyId);
  const relevant = documents.filter(
    (document) => isMissionRequiredDocumentKey(document.key) || isValidationReportDocumentKey(document.key),
  );

  const entries = await Promise.all(
    relevant.map(async (document) => ({
      summary: document,
      document: await ctx.issues.documents.get(issueId, document.key, companyId),
    })),
  );

  return entries.filter((entry): entry is { summary: typeof relevant[number]; document: NonNullable<typeof entry.document> } => {
    return entry.document !== null;
  });
}

async function parseMissionDocuments(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  subtreeIssues: Issue[],
) {
  const checklist: MissionDocumentChecklistItem[] = MISSION_REQUIRED_DOCUMENT_KEYS.map((key) => ({
    key,
    present: false,
    title: null,
  }));
  const parseProblems: MissionParseProblem[] = [];
  const validationReports: Array<{
    issueId: string;
    key: string;
    title: string | null;
    updatedAt: string;
    parsed: MissionValidationReport;
  }> = [];

  let validationContract: MissionValidationContract | null = null;
  let featuresDocument: MissionFeaturesDocument | null = null;
  let decisionLogBody = "";

  for (const issue of subtreeIssues) {
    const documents = await loadRelevantDocuments(ctx, companyId, issue.id);
    for (const { summary, document } of documents) {
      if (isMissionRequiredDocumentKey(summary.key) && issue.id === issueId) {
        const item = checklist.find((candidate) => candidate.key === summary.key);
        if (item) {
          item.present = true;
          item.title = summary.title;
        }

        try {
          if (summary.key === "validation-contract") {
            validationContract = parseMissionValidationContractDocument(document.body);
          } else if (summary.key === "features") {
            featuresDocument = parseMissionFeaturesDocument(document.body);
          } else if (summary.key === "decision-log") {
            decisionLogBody = document.body;
          }
        } catch (error) {
          parseProblems.push({
            issueId,
            key: summary.key,
            message: stringifyError(error),
          });
        }
        continue;
      }

      if (!isValidationReportDocumentKey(summary.key)) continue;

      try {
        const round = parseValidationReportRound(summary.key) ?? undefined;
        validationReports.push({
          issueId: issue.id,
          key: summary.key,
          title: summary.title,
          updatedAt: toIsoTimestamp(summary.updatedAt),
          parsed: parseMissionValidationReportDocument(document.body, { round }),
        });
      } catch (error) {
        parseProblems.push({
          issueId: issue.id,
          key: summary.key,
          message: stringifyError(error),
        });
      }
    }
  }

  validationReports.sort((a, b) => a.parsed.round - b.parsed.round);

  return {
    checklist,
    parseProblems,
    validationContract,
    featuresDocument,
    validationReports,
    decisionLogBody,
  };
}

function buildFindingFixOriginId(missionIssueId: string, findingId: string) {
  return `${missionIssueId}:fix:${findingId}`;
}

async function buildSummaryInternal(ctx: PluginContext, companyId: string, issueId: string): Promise<{
  mission: Issue;
  summary: MissionSummary;
  validationContract: MissionValidationContract | null;
  featuresDocument: MissionFeaturesDocument | null;
  decisionLogBody: string;
}> {
  const mission = await ctx.issues.get(issueId, companyId);
  if (!mission) {
    throw new Error(`Mission issue not found: ${issueId}`);
  }

  const subtree = await ctx.issues.getSubtree(issueId, companyId, { includeRelations: false });
  const orchestration = await ctx.issues.summaries.getOrchestration({
    issueId,
    companyId,
    includeSubtree: true,
    billingCode: mission.billingCode ?? null,
  });
  const parsedDocuments = await parseMissionDocuments(ctx, companyId, issueId, subtree.issues);
  const waivers = parseMissionFindingWaivers(parsedDocuments.decisionLogBody);

  const issueMap = new Map(subtree.issues.map((issue) => [issue.id, issue]));
  const unresolvedBlockersByIssueId = new Map<string, string[]>();
  for (const [relatedIssueId, relation] of Object.entries(orchestration.relations)) {
    unresolvedBlockersByIssueId.set(
      relatedIssueId,
      relation.blockedBy.filter((blocker) => blocker.status !== "done").map((blocker) => blocker.id),
    );
  }

  const fixIssues = subtree.issues.filter((issue) => kindFromOrigin(issue.originKind, ctx) === "fix");
  const fixIssueByOriginId = new Map(
    fixIssues.map((issue) => [issue.originId ?? buildFindingFixOriginId(issueId, issue.id), issue]),
  );

  const findings: MissionFindingProjection[] = parsedDocuments.validationReports.flatMap((report) =>
    report.parsed.findings.map((finding) => {
      const waiver = waivers.get(finding.id) ?? null;
      const fixIssue = fixIssueByOriginId.get(buildFindingFixOriginId(issueId, finding.id)) ?? null;
      let computedStatus: MissionFinding["status"] = finding.status;
      if (waiver) computedStatus = "waived";
      else if (fixIssue?.status === "done") computedStatus = "resolved";
      else if (fixIssue) computedStatus = "fix_created";

      return {
        ...finding,
        computedStatus,
        sourceIssueId: report.issueId,
        sourceReportKey: report.key,
        sourceReportTitle: report.title,
        round: report.parsed.round,
        validatorRole: report.parsed.validator_role,
        fixIssueId: fixIssue?.id ?? null,
        waiver,
      };
    }),
  );

  const relevantKinds = new Set<MissionIssueKind>(["feature", "validation", "fix", "fix_loop"]);
  const assigneeCache = new Map<string, Awaited<ReturnType<PluginContext["agents"]["get"]>>>();
  const workItems: MissionWorkItem[] = [];
  const wakeableIssueIds: string[] = [];
  let missingAssignee = false;
  let pausedAssignee = false;

  for (const issue of subtree.issues) {
    const kind = kindFromOrigin(issue.originKind, ctx);
    if (!relevantKinds.has(kind)) continue;

    const unresolvedBlockers = unresolvedBlockersByIssueId.get(issue.id) ?? [];
    const item: MissionWorkItem = {
      id: issue.id,
      title: issue.title,
      status: issue.status,
      assigneeAgentId: issue.assigneeAgentId,
      kind,
      hasUnresolvedBlockers: unresolvedBlockers.length > 0,
      originKind: issue.originKind ?? null,
      originId: issue.originId ?? null,
    };
    workItems.push(item);

    if (!isWakeableStatus(issue.status) || item.hasUnresolvedBlockers) continue;
    if (!issue.assigneeAgentId) {
      missingAssignee = true;
      continue;
    }

    if (!assigneeCache.has(issue.assigneeAgentId)) {
      assigneeCache.set(issue.assigneeAgentId, await ctx.agents.get(issue.assigneeAgentId, companyId));
    }
    const assignee = assigneeCache.get(issue.assigneeAgentId) ?? null;
    if (!assignee || PAUSED_AGENT_STATUSES.has(assignee.status)) {
      pausedAssignee = true;
      continue;
    }
    if (!ACTIVE_AGENT_STATUSES.has(assignee.status)) continue;
    wakeableIssueIds.push(issue.id);
  }

  const blockingFindings = findings.filter(
    (finding) => finding.severity === "blocking" && !["resolved", "waived"].includes(finding.computedStatus),
  );
  const activeFeatureOrFixIssues = workItems.filter(
    (item) =>
      (item.kind === "feature" || item.kind === "fix" || item.kind === "fix_loop") &&
      !isTerminalStatus(item.status),
  );
  const activeValidationIssues = workItems.filter((item) => item.kind === "validation" && !isTerminalStatus(item.status));
  const missionBlockers = unresolvedBlockersByIssueId.get(issueId) ?? [];
  const openApprovals = orchestration.approvals.filter((approval) => !isResolvableApprovalStatus(approval.status));

  const stopReasons: MissionStopReason[] = [];
  const missingRequiredDocumentKeys = parsedDocuments.checklist
    .filter((item) => !item.present)
    .map((item) => item.key);

  if (parsedDocuments.parseProblems.length > 0) stopReasons.push("parse_error");
  if (orchestration.openBudgetIncidents.length > 0) stopReasons.push("budget_incident");
  if (orchestration.invocationBlocks.length > 0) stopReasons.push("invocation_block");
  if (openApprovals.length > 0) stopReasons.push("approval_required");
  if (missionBlockers.length > 0) stopReasons.push("unresolved_blockers");
  if (missingAssignee) stopReasons.push("missing_assignee");
  if (pausedAssignee) stopReasons.push("paused_assignee");

  const latestValidationRound = parsedDocuments.validationReports.reduce(
    (max, report) => Math.max(max, report.parsed.round),
    0,
  );

  let state: MissionState | null = null;
  const missionOriginKind = mission.originKind ?? null;
  if (
    missionOriginKind === missionOriginPrefix(ctx) ||
    (missionOriginKind !== null && missionOriginKind.startsWith(`${missionOriginPrefix(ctx)}:`)) ||
    missingRequiredDocumentKeys.length > 0 ||
    parsedDocuments.validationReports.length > 0
  ) {
    if (missingRequiredDocumentKeys.length > 0 || parsedDocuments.parseProblems.length > 0) state = "draft";
    else if (blockingFindings.length > 0 && fixIssues.some((issue) => !isTerminalStatus(issue.status))) state = "fixing";
    else if (activeValidationIssues.length > 0) state = "validating";
    else if (stopReasons.length > 0) state = "paused";
    else if (
      parsedDocuments.validationReports.length > 0 &&
      blockingFindings.length === 0 &&
      activeFeatureOrFixIssues.length === 0 &&
      activeValidationIssues.length === 0
    ) {
      state = "complete";
    } else if (activeFeatureOrFixIssues.length > 0 || wakeableIssueIds.length > 0) {
      state = "working";
    } else {
      state = "ready";
    }
  }

  const nextAction = (() => {
    if (state === null) return "Initialize this issue as a mission before advancing it.";
    if (missingRequiredDocumentKeys.length > 0) return "Complete the required mission documents before advancing.";
    if (parsedDocuments.parseProblems.length > 0) return "Repair invalid mission documents before advancing.";
    if (orchestration.openBudgetIncidents.length > 0) return "Resolve open budget incidents before advancing mission work.";
    if (orchestration.invocationBlocks.length > 0) return "Resolve invocation blocks before advancing mission work.";
    if (openApprovals.length > 0) return "Resolve linked approvals before advancing mission work.";
    if (missionBlockers.length > 0) return "Resolve root mission blockers before advancing mission work.";
    if (missingAssignee) return "Assign all wakeable mission issues before advancing.";
    if (pausedAssignee) return "Resume or reassign paused mission assignees before advancing.";
    if (blockingFindings.length > 0) return "Advance the mission to create or wake bounded fix issues.";
    if (activeValidationIssues.length > 0) return "Wake assigned validation issues and review their findings.";
    if (wakeableIssueIds.length > 0) return "Wake the next assigned mission issues.";
    if (state === "complete") return "Record the final mission report and close the root issue when ready.";
    return "Decompose the mission into milestone, feature, and validation issues.";
  })();

  return {
    mission,
    summary: {
      isMission: state !== null,
      missionIssueId: mission.id,
      missionIdentifier: mission.identifier,
      state,
      documentChecklist: parsedDocuments.checklist,
      missingRequiredDocumentKeys,
      parseProblems: parsedDocuments.parseProblems,
      validationReports: parsedDocuments.validationReports.map((report) => ({
        issueId: report.issueId,
        documentKey: report.key,
        title: report.title,
        round: report.parsed.round,
        validatorRole: report.parsed.validator_role,
        summary: report.parsed.summary,
        updatedAt: report.updatedAt,
      })),
      findings,
      workItems,
      wakeableIssueIds: unique(wakeableIssueIds),
      stopReasons: unique(stopReasons),
      nextAction,
      openApprovalCount: openApprovals.length,
      openBudgetIncidentCount: orchestration.openBudgetIncidents.length,
      invocationBlockCount: orchestration.invocationBlocks.length,
      latestValidationRound,
    },
    validationContract: parsedDocuments.validationContract,
    featuresDocument: parsedDocuments.featuresDocument,
    decisionLogBody: parsedDocuments.decisionLogBody,
  };
}

export async function buildMissionSummary(ctx: PluginContext, companyId: string, issueId: string) {
  const { summary } = await buildSummaryInternal(ctx, companyId, issueId);
  return summary;
}

async function appendDecisionLog(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  entry: { marker: string; body: string },
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await ctx.issues.documents.get(issueId, "decision-log", companyId);
    const existingBody = existing?.body ?? "";
    const nextBody = appendDecisionLogEntry(existingBody, entry);
    if (nextBody === existingBody.trim()) return nextBody;

    try {
      await ctx.issues.documents.upsert({
        issueId,
        companyId,
        key: "decision-log",
        title: "Decision Log",
        body: nextBody,
        changeSummary: "Recorded mission decision",
        baseRevisionId: existing?.latestRevisionId ?? null,
      });
      return nextBody;
    } catch (error) {
      const message = stringifyError(error);
      if (attempt === 0 && message.includes("updated by someone else")) continue;
      throw error;
    }
  }

  throw new Error("Unable to append mission decision log entry");
}

async function ensureFixIssue(
  ctx: PluginContext,
  input: {
    companyId: string;
    mission: Issue;
    featuresDocument: MissionFeaturesDocument | null;
    finding: MissionFindingProjection;
    actor: { actorAgentId?: string | null; actorUserId?: string | null; actorRunId?: string | null };
  },
) {
  const originKind = `${missionOriginPrefix(ctx)}:fix` as PluginIssueOriginKindLike;
  const originId = buildFindingFixOriginId(input.mission.id, input.finding.id);
  const existing = await ctx.issues.list({
    companyId: input.companyId,
    originKind,
    originId,
  });
  if (existing[0]) return existing[0];

  let parentId = input.mission.id;
  const milestoneId = input.featuresDocument?.milestones.find((milestone) =>
    milestone.features.some((feature) => feature.claimed_assertion_ids.includes(input.finding.assertion_id ?? "")),
  )?.id;
  if (milestoneId) {
    const milestoneIssues = await ctx.issues.list({
      companyId: input.companyId,
        originKind: `${missionOriginPrefix(ctx)}:milestone` as PluginIssueOriginKindLike,
    });
    const milestoneIssue = milestoneIssues.find((issue) => issue.originId?.includes(milestoneId));
    if (milestoneIssue) parentId = milestoneIssue.id;
  }

  return ctx.issues.create({
    companyId: input.companyId,
    projectId: input.mission.projectId ?? undefined,
    goalId: input.mission.goalId ?? undefined,
    parentId,
    inheritExecutionWorkspaceFromIssueId: input.mission.id,
    title: `Fix ${input.finding.id}: ${input.finding.title}`,
    description: [
      `# Fix ${input.finding.id}`,
      "",
      `Source report: ${input.finding.sourceReportKey}`,
      `Assertion: ${input.finding.assertion_id ?? "none"}`,
      "",
      "## Expected",
      input.finding.expected,
      "",
      "## Actual",
      input.finding.actual,
      "",
      "## Reproduction",
      ...input.finding.repro_steps.map((step) => `- ${step}`),
      "",
      "## Evidence",
      ...input.finding.evidence.map((evidence) => `- ${evidence}`),
      "",
      "## Recommended Scope",
      input.finding.recommended_fix_scope ?? "Fix the bounded behavior described above and leave validation evidence.",
    ].join("\n"),
    status: "todo",
    priority: "high",
    assigneeAgentId: input.mission.assigneeAgentId ?? undefined,
    billingCode: input.mission.billingCode ?? `mission:${input.mission.id}`,
    originKind,
    originId,
    actor: input.actor,
  });
}

export async function advanceMission(
  ctx: PluginContext,
  input: {
    companyId: string;
    issueId: string;
    maxValidationRounds?: number;
    actorAgentId?: string | null;
    actorUserId?: string | null;
    actorRunId?: string | null;
  },
): Promise<MissionAdvanceResult> {
  const actor = {
    actorAgentId: input.actorAgentId ?? null,
    actorUserId: input.actorUserId ?? null,
    actorRunId: input.actorRunId ?? null,
  };
  const actorLabel = buildActorLabel(actor);
  const { mission, summary, featuresDocument } = await buildSummaryInternal(
    ctx,
    input.companyId,
    input.issueId,
  );

  if (!summary.isMission) {
    throw new Error("Issue is not initialized as a mission");
  }

  const stopReason =
    summary.stopReasons[0] ??
    (summary.latestValidationRound >= (input.maxValidationRounds ?? DEFAULT_MAX_VALIDATION_ROUNDS) &&
    summary.findings.some(
      (finding) => finding.severity === "blocking" && !["resolved", "waived"].includes(finding.computedStatus),
    )
      ? "max_validation_rounds"
      : null);

  if (stopReason) {
    const result: MissionAdvanceResult = {
      issueId: input.issueId,
      outcome: "paused",
      stopReason,
      wokenIssueIds: [],
      createdFixIssueIds: [],
      details: {
        stopReasons: summary.stopReasons,
        latestValidationRound: summary.latestValidationRound,
      },
    };

    await appendDecisionLog(
      ctx,
      input.companyId,
      input.issueId,
      buildMissionEventEntry({
        markerKey: `advance:paused:${stopReason}:${summary.latestValidationRound}`,
        title: `Advance Paused ${summary.missionIdentifier ?? input.issueId}`,
        lines: [
          `Outcome: paused`,
          `Stop reason: ${stopReason}`,
          `Actor: ${actorLabel}`,
          `At: ${new Date().toISOString()}`,
        ],
      }),
    );
    await ctx.state.set({ scopeKind: "issue", scopeId: input.issueId, stateKey: "last-advance-result" }, result);
    return result;
  }

  const createdFixIssues: Issue[] = [];
  for (const finding of summary.findings) {
    if (finding.severity !== "blocking" || ["resolved", "waived"].includes(finding.computedStatus)) continue;
    const fixIssue = await ensureFixIssue(ctx, {
      companyId: input.companyId,
      mission,
      featuresDocument,
      finding,
      actor,
    });
    createdFixIssues.push(fixIssue);
  }

  if (createdFixIssues.length > 0) {
    await appendDecisionLog(
      ctx,
      input.companyId,
      input.issueId,
      buildMissionEventEntry({
        markerKey: `advance:fixes:${createdFixIssues.map((issue) => issue.id).join(",")}`,
        title: `Advance Created Fixes ${summary.missionIdentifier ?? input.issueId}`,
        lines: [
          `Outcome: created fixes`,
          `Actor: ${actorLabel}`,
          `Created issue ids: ${createdFixIssues.map((issue) => issue.id).join(", ")}`,
          `At: ${new Date().toISOString()}`,
        ],
      }),
    );
  }

  const wakeableIssueIds = unique([...summary.wakeableIssueIds, ...createdFixIssues.map((issue) => issue.id)]);
  if (wakeableIssueIds.length > 0) {
    const wakeups = await ctx.issues.requestWakeups(wakeableIssueIds, input.companyId, {
      reason: "mission_advance",
      contextSource: "missions.advance",
      idempotencyKeyPrefix: `mission:${input.issueId}:advance`,
      ...actor,
    });
    const wokenIssueIds = wakeups.filter((result) => result.queued).map((result) => result.issueId);
    const result: MissionAdvanceResult = {
      issueId: input.issueId,
      outcome: "woke_issues",
      stopReason: null,
      wokenIssueIds,
      createdFixIssueIds: createdFixIssues.map((issue) => issue.id),
      details: {
        requestedIssueIds: wakeableIssueIds,
      },
    };

    await appendDecisionLog(
      ctx,
      input.companyId,
      input.issueId,
      buildMissionEventEntry({
        markerKey: `advance:wakeup:${wokenIssueIds.join(",")}`,
        title: `Advance Woke Issues ${summary.missionIdentifier ?? input.issueId}`,
        lines: [
          `Outcome: woke issues`,
          `Actor: ${actorLabel}`,
          `Wakeups: ${wokenIssueIds.join(", ")}`,
          `At: ${new Date().toISOString()}`,
        ],
      }),
    );
    await ctx.state.set({ scopeKind: "issue", scopeId: input.issueId, stateKey: "last-advance-result" }, result);
    return result;
  }

  if (
    summary.validationReports.length > 0 &&
    summary.findings.every((finding) => ["resolved", "waived"].includes(finding.computedStatus))
  ) {
    const result: MissionAdvanceResult = {
      issueId: input.issueId,
      outcome: "complete",
      stopReason: null,
      wokenIssueIds: [],
      createdFixIssueIds: createdFixIssues.map((issue) => issue.id),
      details: {
        latestValidationRound: summary.latestValidationRound,
      },
    };
    await ctx.state.set({ scopeKind: "issue", scopeId: input.issueId, stateKey: "last-advance-result" }, result);
    return result;
  }

  const result: MissionAdvanceResult = {
    issueId: input.issueId,
    outcome: createdFixIssues.length > 0 ? "created_fixes" : "noop",
    stopReason: null,
    wokenIssueIds: [],
    createdFixIssueIds: createdFixIssues.map((issue) => issue.id),
    details: {
      nextAction: summary.nextAction,
    },
  };
  await ctx.state.set({ scopeKind: "issue", scopeId: input.issueId, stateKey: "last-advance-result" }, result);
  return result;
}

export async function waiveMissionFinding(
  ctx: PluginContext,
  input: {
    companyId: string;
    issueId: string;
    findingId: string;
    rationale: string;
    actorAgentId?: string | null;
    actorUserId?: string | null;
    actorRunId?: string | null;
  },
): Promise<MissionWaiveFindingResult> {
  const actor = {
    actorAgentId: input.actorAgentId ?? null,
    actorUserId: input.actorUserId ?? null,
    actorRunId: input.actorRunId ?? null,
  };
  const actorLabel = buildActorLabel(actor);
  const { summary } = await buildSummaryInternal(ctx, input.companyId, input.issueId);
  const finding = summary.findings.find((candidate) => candidate.id === input.findingId);
  if (!finding) {
    throw new Error(`Mission finding not found: ${input.findingId}`);
  }

  const createdAt = new Date().toISOString();
  const waiverEntry = buildMissionFindingWaiverEntry({
    findingId: input.findingId,
    rationale: input.rationale,
    actorLabel,
    createdAt,
  });
  await appendDecisionLog(ctx, input.companyId, input.issueId, waiverEntry);
  await ctx.state.set(
    { scopeKind: "issue", scopeId: input.issueId, stateKey: `waiver:${input.findingId}` },
    {
      findingId: input.findingId,
      rationale: input.rationale,
      actorLabel,
      createdAt,
    },
  );

  return {
    issueId: input.issueId,
    findingId: input.findingId,
    waived: true,
    rationale: input.rationale,
  };
}
