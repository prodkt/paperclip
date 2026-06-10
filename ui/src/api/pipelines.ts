import { api } from "./client";

export type PipelineStatus = "active" | "paused" | "archived";

export type PipelineConnectionRef =
  | string
  | {
      id?: string | null;
      pipelineId?: string | null;
      upstreamPipelineId?: string | null;
      downstreamPipelineId?: string | null;
      feedsIntoPipelineId?: string | null;
      fedByPipelineId?: string | null;
      direction?: string | null;
    };

export interface PipelineConnections {
  feedsIntoPipelineId?: string | null;
  downstreamPipelineId?: string | null;
  upstreamPipelineIds?: string[];
  downstreamPipelineIds?: string[];
  feedsInto?: PipelineConnectionRef[];
  fedBy?: PipelineConnectionRef[];
  upstream?: PipelineConnectionRef[];
  downstream?: PipelineConnectionRef[];
  [key: string]: unknown;
}

export interface Pipeline {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  status: PipelineStatus;
  attentionCount?: number | null;
  inMotionCount?: number | null;
  openItemCount?: number | null;
  openCaseCount?: number | null;
  lastActivityAt?: string | Date | null;
  updatedAt?: string | Date | null;
  createdAt?: string | Date | null;
  connections?: PipelineConnections | null;
  stages?: PipelineStage[];
  transitions?: PipelineTransition[];
  guidanceDocuments?: PipelineGuidanceDocument[];
  caseCount?: number;
}

export interface PipelineStage {
  id: string;
  pipelineId: string;
  name: string;
  kind: "open" | "working" | "review" | "done" | "cancelled" | string;
  position: number;
  config?: Record<string, unknown> | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface PipelineTransition {
  fromStageId: string;
  toStageId: string;
  config?: Record<string, unknown> | null;
}

export interface PipelineGuidanceDocument {
  id: string;
  pipelineId: string;
  key: string;
  title: string;
  body: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface PipelineCase {
  id: string;
  pipelineId: string;
  stageId: string | null;
  parentCaseId?: string | null;
  title: string;
  activeWork?: boolean | number | null;
  status?: string | null;
  fields?: Record<string, unknown> | null;
  openBlockers?: number | null;
  blockedByCaseIds?: string[] | null;
  thisChanged?: boolean | null;
  childrenSummary?: number | Record<string, unknown> | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  lastActivityAt?: string | Date | null;
}

export interface PipelineCaseEvent {
  id: string;
  companyId: string;
  pipelineId: string;
  caseId: string;
  kind: string;
  summary?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: string | Date;
  caseTitle?: string | null;
  pipelineName?: string | null;
  fromStageName?: string | null;
  toStageName?: string | null;
}

export interface PipelineBlocker {
  id: string;
  caseId: string;
  blockedByCaseId: string;
  reason?: string | null;
  resolvedAt?: string | Date | null;
  createdAt?: string | Date;
}

export interface PipelineIssueLink {
  id: string;
  caseId: string;
  issueId: string;
  role: "origin" | "conversation" | "work" | "automation" | string;
  createdAt?: string | Date;
}

export interface PipelineAttentionItem {
  id: string;
  pipelineId: string;
  caseId?: string | null;
  kind: string;
  title: string;
  summary?: string | null;
  createdAt?: string | Date;
}

export interface PipelineIntakeForm {
  pipelineId: string;
  stageId: string | null;
  stageName?: string | null;
  newEntriesDisabled?: boolean;
  disabledReason?: string | null;
  fields: Array<{
    key: string;
    label: string;
    type: string;
    required?: boolean;
    options?: string[];
  }>;
}

export interface ListPipelinesOptions {
  includeConnections?: boolean;
  includeCounts?: boolean;
  q?: string;
}

export interface ListCasesOptions {
  stageId?: string;
  status?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface ReviewCasesOptions {
  pipelineId?: string;
  kind?: string;
  limit?: number;
  offset?: number;
}

export interface ListCompanyCaseEventsOptions {
  pipelineId?: string;
  types?: string;
  limit?: number;
  offset?: number;
}

function queryString(filters: object) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const pipelinesApi = {
  list: (companyId: string, options: ListPipelinesOptions = {}) =>
    api.get<Pipeline[]>(`/companies/${companyId}/pipelines${queryString(options)}`),
  get: (pipelineId: string) => api.get<Pipeline>(`/pipelines/${pipelineId}`),
  create: (companyId: string, data: { name: string; description?: string | null }) =>
    api.post<Pipeline>(`/companies/${companyId}/pipelines`, data),
  update: (pipelineId: string, data: Partial<Pick<Pipeline, "name" | "description" | "status">>) =>
    api.patch<Pipeline>(`/pipelines/${pipelineId}`, data),
  remove: (pipelineId: string) => api.delete<Pipeline>(`/pipelines/${pipelineId}`),

  listStages: (pipelineId: string) =>
    api.get<PipelineStage[]>(`/pipelines/${pipelineId}/stages`),
  createStage: (pipelineId: string, data: Partial<PipelineStage>) =>
    api.post<PipelineStage>(`/pipelines/${pipelineId}/stages`, data),
  updateStage: (pipelineId: string, stageId: string, data: Partial<PipelineStage>) =>
    api.patch<PipelineStage>(`/pipelines/${pipelineId}/stages/${stageId}`, data),
  deleteStage: (pipelineId: string, stageId: string) =>
    api.delete<PipelineStage>(`/pipelines/${pipelineId}/stages/${stageId}`),
  setTransitions: (pipelineId: string, data: { transitions: PipelineTransition[]; enforceTransitions?: boolean }) =>
    api.put<{ transitions: PipelineTransition[] }>(`/pipelines/${pipelineId}/transitions`, data),

  listGuidanceDocuments: (pipelineId: string) =>
    api.get<PipelineGuidanceDocument[]>(`/pipelines/${pipelineId}/guidance-documents`),
  getGuidanceDocument: (pipelineId: string, key: string) =>
    api.get<PipelineGuidanceDocument>(`/pipelines/${pipelineId}/guidance-documents/${key}`),
  upsertGuidanceDocument: (
    pipelineId: string,
    key: string,
    data: Pick<PipelineGuidanceDocument, "title" | "body">,
  ) =>
    api.put<PipelineGuidanceDocument>(`/pipelines/${pipelineId}/guidance-documents/${key}`, data),
  deleteGuidanceDocument: (pipelineId: string, key: string) =>
    api.delete<PipelineGuidanceDocument>(`/pipelines/${pipelineId}/guidance-documents/${key}`),

  listCases: (pipelineId: string, options: ListCasesOptions = {}) =>
    api.get<PipelineCase[]>(`/pipelines/${pipelineId}/cases${queryString(options)}`),
  getCase: (caseId: string) => api.get<PipelineCase>(`/cases/${caseId}`),
  updateCase: (caseId: string, data: Partial<PipelineCase>) =>
    api.patch<PipelineCase>(`/cases/${caseId}`, data),
  ingestCase: (pipelineId: string, data: Record<string, unknown>) =>
    api.post<PipelineCase>(`/pipelines/${pipelineId}/cases/ingest`, data),
  ingestCasesBatch: (pipelineId: string, data: { items: Record<string, unknown>[] }) =>
    api.post<{ cases: PipelineCase[] }>(`/pipelines/${pipelineId}/cases/batch`, data),
  transitionCase: (caseId: string, data: { toStageId: string; reason?: string | null }) =>
    api.post<PipelineCase>(`/cases/${caseId}/transition`, data),
  suggestTransition: (caseId: string, data: { toStageId: string; reason?: string | null }) =>
    api.post<PipelineCase>(`/cases/${caseId}/suggest-transition`, data),
  resolveSuggestion: (caseId: string, data: { decision: "accept" | "decline"; note?: string | null }) =>
    api.post<PipelineCase>(`/cases/${caseId}/resolve-suggestion`, data),

  listReviewCases: (companyId: string, options: ReviewCasesOptions = {}) =>
    api.get<PipelineCase[]>(`/companies/${companyId}/review-cases${queryString(options)}`),
  reviewCase: (caseId: string, data: { decision: "approve" | "request_changes" | "drop"; note?: string | null }) =>
    api.post<PipelineCase>(`/cases/${caseId}/review`, data),
  bulkReviewCases: (
    companyId: string,
    data: { caseIds: string[]; decision: "approve" | "request_changes" | "drop"; note?: string | null },
  ) =>
    api.post<{ cases: PipelineCase[] }>(`/companies/${companyId}/review-cases/bulk`, data),

  listBlockers: (caseId: string) => api.get<PipelineBlocker[]>(`/cases/${caseId}/blockers`),
  createBlocker: (caseId: string, data: { blockedByCaseId: string; reason?: string | null }) =>
    api.post<PipelineBlocker>(`/cases/${caseId}/blockers`, data),
  resolveBlocker: (caseId: string, blockerId: string) =>
    api.post<PipelineBlocker>(`/cases/${caseId}/blockers/${blockerId}/resolve`, {}),

  listIssueLinks: (caseId: string) => api.get<PipelineIssueLink[]>(`/cases/${caseId}/issue-links`),
  createIssueLink: (caseId: string, data: { issueId: string; role: PipelineIssueLink["role"] }) =>
    api.post<PipelineIssueLink>(`/cases/${caseId}/issue-links`, data),
  deleteIssueLink: (caseId: string, linkId: string) =>
    api.delete<PipelineIssueLink>(`/cases/${caseId}/issue-links/${linkId}`),
  openConversation: (caseId: string, data: Record<string, unknown> = {}) =>
    api.post<PipelineIssueLink>(`/cases/${caseId}/open-conversation`, data),

  listEvents: (pipelineId: string) =>
    api.get<PipelineCaseEvent[]>(`/pipelines/${pipelineId}/events`),
  listCaseEvents: (caseId: string) => api.get<PipelineCaseEvent[]>(`/cases/${caseId}/events`),
  getIntakeForm: (pipelineId: string) =>
    api.get<PipelineIntakeForm>(`/pipelines/${pipelineId}/intake-form`),
  listAttention: (companyId: string) =>
    api.get<PipelineAttentionItem[]>(`/companies/${companyId}/pipelines-attention`),
  listCompanyCaseEvents: (companyId: string, options: ListCompanyCaseEventsOptions = {}) =>
    api.get<PipelineCaseEvent[]>(`/companies/${companyId}/case-events${queryString(options)}`),
  listChildren: (caseId: string) => api.get<PipelineCase[]>(`/cases/${caseId}/children`),
};
