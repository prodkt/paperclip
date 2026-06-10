import { api } from "./client";

export interface PipelineListItem {
  id: string;
  companyId: string;
  key: string;
  name: string;
  description: string | null;
  projectId: string | null;
  enforceTransitions: boolean;
  archivedAt: Date | string | null;
  stageCount: number;
  openCaseCount: number;
  connections: { upstreamPipelineIds: string[]; downstreamPipelineIds: string[] };
  createdAt: Date | string;
  updatedAt: Date | string;
}

export const pipelinesApi = {
  list: (companyId: string) => api.get<PipelineListItem[]>(`/companies/${companyId}/pipelines`),
};
