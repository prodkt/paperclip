import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpenText,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitBranch,
  Hexagon,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type {
  Pipeline,
  PipelineAttentionItem,
  PipelineCase,
  PipelineCaseEvent,
  PipelineConnectionRef,
  PipelineConnections,
  PipelineIntakeForm,
  PipelineIssueLink,
  PipelineStage,
  PipelineTransition,
} from "../api/pipelines";
import { pipelinesApi } from "../api/pipelines";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "../components/EmptyState";
import { IssueChatThread } from "../components/IssueChatThread";
import { PageSkeleton } from "../components/PageSkeleton";
import { hasBlockingShortcutDialog, isKeyboardShortcutTextInputTarget } from "../lib/keyboardShortcuts";
import {
  displayPipelineItemFields,
  formatPipelineItemEvent,
  getPendingTransitionBannerState,
  humanizePipelineItemStatus,
  itemHasChangedNotice,
} from "../lib/pipeline-item-detail";
import { formatLearningEvent } from "../lib/pipeline-learnings";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatNumber, formatShortDate, relativeTime } from "../lib/utils";
import { Link, useNavigate, useParams } from "@/lib/router";

export type PipelineViewMode = "nested" | "flat";

export interface PipelineTableRow {
  pipeline: Pipeline;
  depth: number;
  feedsIntoName: string | null;
  hasChildren: boolean;
  expanded: boolean;
}

function connectionId(ref: PipelineConnectionRef | null | undefined): string | null {
  if (!ref) return null;
  if (typeof ref === "string") return ref;
  return (
    ref.pipelineId ??
    ref.downstreamPipelineId ??
    ref.feedsIntoPipelineId ??
    ref.id ??
    null
  );
}

function connectionListIds(refs: PipelineConnectionRef[] | null | undefined): string[] {
  if (!Array.isArray(refs)) return [];
  return refs.map(connectionId).filter((id): id is string => Boolean(id));
}

function downstreamPipelineIds(connections: PipelineConnections | null | undefined): string[] {
  if (!connections) return [];

  const ids = [
    connections.feedsIntoPipelineId,
    connections.downstreamPipelineId,
    ...(connections.downstreamPipelineIds ?? []),
    ...connectionListIds(connections.feedsInto),
    ...connectionListIds(connections.downstream),
  ];

  return ids.filter((id): id is string => Boolean(id));
}

function hasConnectionsField(pipeline: Pipeline): boolean {
  return Object.prototype.hasOwnProperty.call(pipeline, "connections");
}

function pipelineOpenItemCount(pipeline: Pipeline) {
  return pipeline.openItemCount ?? pipeline.openCaseCount ?? 0;
}

function pipelineAttentionCount(pipeline: Pipeline) {
  return pipeline.attentionCount ?? 0;
}

function pipelineInMotionCount(pipeline: Pipeline) {
  return pipeline.inMotionCount ?? 0;
}

function pipelineActivityTime(pipeline: Pipeline) {
  return pipeline.lastActivityAt ?? pipeline.updatedAt ?? pipeline.createdAt ?? null;
}

function compareByInputOrder(order: Map<string, number>) {
  return (left: Pipeline, right: Pipeline) =>
    (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER);
}

export function pipelinesHaveConnectionData(pipelines: Pipeline[]) {
  return pipelines.some(hasConnectionsField);
}

export function buildPipelineTableRows(
  pipelines: Pipeline[],
  options: {
    viewMode: PipelineViewMode;
    collapsedPipelineIds?: Set<string>;
  },
): PipelineTableRow[] {
  if (options.viewMode === "flat") {
    return pipelines.map((pipeline) => ({
      pipeline,
      depth: 0,
      feedsIntoName: null,
      hasChildren: false,
      expanded: true,
    }));
  }

  const pipelinesById = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline]));
  const inputOrder = new Map(pipelines.map((pipeline, index) => [pipeline.id, index]));
  const parentByChild = new Map<string, string>();

  for (const pipeline of pipelines) {
    const downstreamId = downstreamPipelineIds(pipeline.connections).find((id) => pipelinesById.has(id));
    if (downstreamId && downstreamId !== pipeline.id) {
      parentByChild.set(pipeline.id, downstreamId);
    }
  }

  const childrenByParent = new Map<string, Pipeline[]>();
  for (const [childId, parentId] of parentByChild.entries()) {
    const child = pipelinesById.get(childId);
    if (!child) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(child);
    childrenByParent.set(parentId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort(compareByInputOrder(inputOrder));
  }

  const rows: PipelineTableRow[] = [];
  const visited = new Set<string>();
  const collapsed = options.collapsedPipelineIds ?? new Set<string>();

  function visit(pipeline: Pipeline, depth: number, stack: Set<string>) {
    if (visited.has(pipeline.id) || stack.has(pipeline.id)) return;
    visited.add(pipeline.id);

    const children = childrenByParent.get(pipeline.id) ?? [];
    const parentId = parentByChild.get(pipeline.id);
    rows.push({
      pipeline,
      depth,
      feedsIntoName: parentId ? pipelinesById.get(parentId)?.name ?? null : null,
      hasChildren: children.length > 0,
      expanded: !collapsed.has(pipeline.id),
    });

    if (collapsed.has(pipeline.id)) return;

    const nextStack = new Set(stack);
    nextStack.add(pipeline.id);
    for (const child of children) {
      visit(child, depth + 1, nextStack);
    }
  }

  const roots = pipelines
    .filter((pipeline) => !parentByChild.has(pipeline.id))
    .sort(compareByInputOrder(inputOrder));
  for (const root of roots) visit(root, 0, new Set<string>());
  for (const pipeline of pipelines) visit(pipeline, 0, new Set<string>());

  return rows;
}

function formatOpenItems(count: number) {
  return `${formatNumber(count)} open`;
}

function formatPipelineActivity(value: string | Date | null) {
  if (!value) return "No activity";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "No activity";
  const diffSeconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSeconds < 60) return "just now";
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes} min ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return diffHours === 1 ? "1 hr ago" : `${diffHours} hr ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 14) return "last week";
  if (diffDays < 30) return `${Math.round(diffDays / 7)} weeks ago`;
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

type ReviewQueueKind = "suggestion" | "review" | "headsUp";

export interface ReviewQueueRow {
  id: string;
  caseId: string | null;
  pipelineId: string;
  pipelineName: string;
  title: string;
  prompt: string;
  kind: ReviewQueueKind;
  createdAt: string | Date | null;
  caseItem?: PipelineCase;
}

const REVIEW_QUEUE_SECTION_LABELS: Record<ReviewQueueKind, string> = {
  suggestion: "Suggestions to review",
  review: "Final calls",
  headsUp: "Heads-up",
};

const REVIEW_QUEUE_SECTION_ORDER: ReviewQueueKind[] = ["suggestion", "review", "headsUp"];

function attentionItemKind(item: PipelineAttentionItem): ReviewQueueKind {
  const rawKind = String(item.kind ?? "").toLowerCase();
  if (rawKind.includes("suggest")) return "suggestion";
  if (rawKind.includes("review") || rawKind.includes("final")) return "review";
  return "headsUp";
}

function hasPendingSuggestion(caseItem: PipelineCase) {
  const fields = caseItem.fields ?? {};
  return Boolean(fields.nextSuggestedStageId && !fields.suggestionResolution);
}

function humanizeFieldLabel(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function reviewCasePrompt(caseItem: PipelineCase) {
  const fields = caseItem.fields ?? {};
  if (typeof fields.decision === "string" && fields.decision.trim()) {
    return fields.decision.trim();
  }
  return `Decide whether ${caseItem.title} is ready to move forward.`;
}

function suggestionPrompt(item: PipelineAttentionItem, pipelineName: string) {
  return item.summary ?? `${pipelineName} thinks ${item.title} is ready to move forward.`;
}

function headsUpPrompt(item: PipelineAttentionItem) {
  return item.summary ?? `${item.title} needs a quick look before work continues.`;
}

export function buildReviewQueueRows({
  attentionItems,
  reviewCases,
  pipelines,
}: {
  attentionItems: PipelineAttentionItem[];
  reviewCases: PipelineCase[];
  pipelines: Pipeline[];
}): ReviewQueueRow[] {
  const pipelineNameById = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline.name]));
  const reviewCaseById = new Map(reviewCases.map((caseItem) => [caseItem.id, caseItem]));
  const rows = new Map<string, ReviewQueueRow>();

  for (const item of attentionItems) {
    const caseId = item.caseId ?? item.id ?? null;
    const caseItem = caseId ? reviewCaseById.get(caseId) : undefined;
    const kind = caseItem ? "review" : attentionItemKind(item);
    const pipelineName = pipelineNameById.get(item.pipelineId) ?? "Pipeline";
    rows.set(`${kind}:${caseId ?? item.id}`, {
      id: `${kind}:${caseId ?? item.id}`,
      caseId,
      pipelineId: item.pipelineId,
      pipelineName,
      title: item.title,
      prompt:
        kind === "suggestion"
          ? suggestionPrompt(item, pipelineName)
          : kind === "review" && caseItem
            ? reviewCasePrompt(caseItem)
            : headsUpPrompt(item),
      kind,
      createdAt: item.createdAt ?? caseItem?.lastActivityAt ?? caseItem?.updatedAt ?? null,
      caseItem,
    });
  }

  for (const caseItem of reviewCases) {
    const kind: ReviewQueueKind = hasPendingSuggestion(caseItem) ? "suggestion" : "review";
    const pipelineName = pipelineNameById.get(caseItem.pipelineId) ?? "Pipeline";
    const id = `${kind}:${caseItem.id}`;
    if (rows.has(id)) continue;
    rows.set(id, {
      id,
      caseId: caseItem.id,
      pipelineId: caseItem.pipelineId,
      pipelineName,
      title: caseItem.title,
      prompt:
        kind === "suggestion"
          ? `${pipelineName} thinks ${caseItem.title} is ready to move forward.`
          : reviewCasePrompt(caseItem),
      kind,
      createdAt: caseItem.lastActivityAt ?? caseItem.updatedAt ?? caseItem.createdAt ?? null,
      caseItem,
    });
  }

  return [...rows.values()].sort((left, right) => {
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightTime - leftTime;
  });
}

const LEARNINGS_PAGE_SIZE = 100;
const LEARNING_EVENT_TYPES = "review_decided,transition_forced";

function learningDayKey(value: string | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toISOString().slice(0, 10);
}

function learningDayLabel(value: string | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOfToday - startOfDay) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return formatShortDate(date);
}

function groupLearningEventsByDay(events: PipelineCaseEvent[]) {
  const groups: Array<{ key: string; label: string; events: PipelineCaseEvent[] }> = [];
  for (const event of events) {
    const key = learningDayKey(event.createdAt);
    const existing = groups.find((group) => group.key === key);
    if (existing) {
      existing.events.push(event);
      continue;
    }
    groups.push({ key, label: learningDayLabel(event.createdAt), events: [event] });
  }
  return groups;
}

function PipelineStatusChip({ status }: { status: Pipeline["status"] }) {
  const paused = status === "paused";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold",
        paused
          ? "border-muted-foreground/20 bg-muted text-muted-foreground"
          : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300",
      )}
    >
      {paused ? "Paused" : "Active"}
    </span>
  );
}

interface PipelinesIndexTableProps {
  pipelines: Pipeline[];
  viewMode: PipelineViewMode;
  onViewModeChange: (mode: PipelineViewMode) => void;
  connectionsAvailable: boolean;
  search: string;
  onSearchChange: (search: string) => void;
}

export function PipelinesIndexTable({
  pipelines,
  viewMode,
  onViewModeChange,
  connectionsAvailable,
  search,
  onSearchChange,
}: PipelinesIndexTableProps) {
  const [collapsedPipelineIds, setCollapsedPipelineIds] = useState<Set<string>>(() => new Set());
  const filteredPipelines = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return pipelines;
    return pipelines.filter((pipeline) => pipeline.name.toLowerCase().includes(q));
  }, [pipelines, search]);
  const effectiveViewMode = connectionsAvailable ? viewMode : "flat";
  const rows = useMemo(
    () =>
      buildPipelineTableRows(filteredPipelines, {
        viewMode: effectiveViewMode,
        collapsedPipelineIds,
      }),
    [collapsedPipelineIds, effectiveViewMode, filteredPipelines],
  );

  const togglePipeline = (pipelineId: string) => {
    setCollapsedPipelineIds((current) => {
      const next = new Set(current);
      if (next.has(pipelineId)) next.delete(pipelineId);
      else next.add(pipelineId);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 border-y border-border py-4 lg:flex-row lg:items-center lg:justify-between">
        <label className="relative block w-full max-w-md">
          <span className="sr-only">Search pipelines</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search pipelines"
            className="h-10 pl-9"
          />
        </label>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>View</span>
          <div className="inline-flex overflow-hidden rounded-md border border-border bg-background">
            <button
              type="button"
              className={cn(
                "min-w-20 px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                effectiveViewMode === "nested" && connectionsAvailable
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
              disabled={!connectionsAvailable}
              onClick={() => onViewModeChange("nested")}
            >
              Nested
            </button>
            <button
              type="button"
              className={cn(
                "min-w-20 border-l border-border px-4 py-2 text-sm font-semibold transition-colors",
                effectiveViewMode === "flat"
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
              onClick={() => onViewModeChange("flat")}
            >
              Flat list
            </button>
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={Hexagon} message="No pipelines match your search." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                <th className="py-2 pl-3 pr-4">Name</th>
                <th className="px-4 py-2">Attention</th>
                <th className="px-4 py-2">Open items</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const attentionCount = pipelineAttentionCount(row.pipeline);
                const inMotionCount = pipelineInMotionCount(row.pipeline);
                return (
                  <tr key={row.pipeline.id} className="h-10 border-b border-border/70">
                    <td className="pl-3 pr-4">
                      <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: row.depth * 28 }}>
                        {row.hasChildren ? (
                          <button
                            type="button"
                            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                            aria-label={row.expanded ? `Collapse ${row.pipeline.name}` : `Expand ${row.pipeline.name}`}
                            onClick={() => togglePipeline(row.pipeline.id)}
                          >
                            {row.expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </button>
                        ) : (
                          <span className="h-6 w-6 shrink-0" aria-hidden="true" />
                        )}
                        <div className="min-w-0">
                          <Link
                            to={`/pipelines/${row.pipeline.id}`}
                            className="font-semibold text-foreground hover:underline"
                          >
                            {row.pipeline.name}
                          </Link>
                          {row.feedsIntoName ? (
                            <span className="ml-2 text-muted-foreground">feeds into {row.feedsIntoName}</span>
                          ) : row.pipeline.description ? (
                            <span className="ml-2 text-muted-foreground">- {row.pipeline.description}</span>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 text-sm">
                      <div className="flex items-center gap-3 whitespace-nowrap">
                        {attentionCount > 0 ? (
                          <span className="inline-flex items-center gap-1.5 font-semibold text-red-700 dark:text-red-400">
                            <span className="h-2 w-2 rounded-full bg-red-600" aria-hidden="true" />
                            {formatNumber(attentionCount)} to review
                          </span>
                        ) : null}
                        {inMotionCount > 0 ? (
                          <span className="text-muted-foreground">
                            {formatNumber(inMotionCount)} in motion
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 text-muted-foreground">{formatOpenItems(pipelineOpenItemCount(row.pipeline))}</td>
                    <td className="px-4"><PipelineStatusChip status={row.pipeline.status} /></td>
                    <td className="px-4 text-muted-foreground">{formatPipelineActivity(pipelineActivityTime(row.pipeline))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-4 text-sm text-muted-foreground">
            Showing {formatNumber(rows.length)} of {formatNumber(filteredPipelines.length)}.
          </p>
        </div>
      )}
    </div>
  );
}

const UNASSIGNED_STAGE_ID = "__pipeline_unassigned_stage";
const UNASSIGNED_STAGE_NAME = "Unassigned";

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const next = value.trim();
  return next.length === 0 ? null : next;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
  }
  return false;
}

function asPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return null;
}

function getCaseTitle(caseItem: PipelineCase) {
  const fields = caseItem.fields ?? {};
  const candidateKeys = [
    "title",
    "name",
    "summary",
    "subject",
    "item_title",
    "itemTitle",
    "issueTitle",
    "ticketTitle",
  ] as const;

  for (const key of candidateKeys) {
    const value = asText(fields[key]);
    if (value) return value;
  }
  return asText(caseItem.title) ?? "Untitled item";
}

function isWorkingCase(caseItem: PipelineCase) {
  const fields = caseItem.fields ?? {};
  return (
    asBoolean(caseItem.activeWork) ||
    asBoolean(fields.activeWork) ||
    asBoolean(fields.active_work) ||
    asBoolean(fields.isActiveWork) ||
    asBoolean(fields.working) ||
    asBoolean(fields.isWorking)
  );
}

function getOpenBlockerCount(caseItem: PipelineCase) {
  if (typeof caseItem.openBlockers === "number") return Math.max(0, Math.floor(caseItem.openBlockers));
  if (Array.isArray(caseItem.blockedByCaseIds)) return caseItem.blockedByCaseIds.length;
  const fields = caseItem.fields ?? {};
  const fromFields = asPositiveInteger(fields.openBlockers);
  if (fromFields != null) return fromFields;
  return 0;
}

function hasThisChanged(caseItem: PipelineCase) {
  const fields = caseItem.fields ?? {};
  return (
    asBoolean(caseItem.thisChanged) ||
    asBoolean(fields.thisChanged) ||
    asBoolean(fields["this changed"]) ||
    asBoolean(fields.this_changed) ||
    asBoolean(fields.hasThisChanged)
  );
}

function getChildrenSummaryCount(caseItem: PipelineCase) {
  if (typeof caseItem.childrenSummary === "number") return asPositiveInteger(caseItem.childrenSummary);
  const fields = caseItem.fields ?? {};
  const fromFields = asPositiveInteger(fields.childrenSummary);
  if (fromFields != null) return fromFields;
  if (caseItem.childrenSummary && typeof caseItem.childrenSummary === "object") {
    const candidate = caseItem.childrenSummary as {
      total?: unknown;
      count?: unknown;
      builtFrom?: unknown;
      n?: unknown;
    };
    return (
      asPositiveInteger(candidate.total) ??
      asPositiveInteger(candidate.count) ??
      asPositiveInteger(candidate.builtFrom) ??
      asPositiveInteger(candidate.n)
    );
  }
  return null;
}

function createUnassignedStage(pipelineId: string): PipelineStage {
  return {
    id: UNASSIGNED_STAGE_ID,
    pipelineId,
    name: UNASSIGNED_STAGE_NAME,
    kind: "open",
    position: Number.MAX_SAFE_INTEGER,
    config: {},
  };
}

function isGuardedTransitionAllowed(
  transitions: PipelineTransition[],
  sourceStageId: string | null,
  targetStageId: string,
) {
  if (!transitions.length) return true;
  if (!sourceStageId) return false;
  if (sourceStageId === targetStageId) return true;

  for (const transition of transitions) {
    if (transition.fromStageId === sourceStageId && transition.toStageId === targetStageId) {
      return true;
    }
  }
  return false;
}

function resolvePipelineTargetStageId(
  overId: string,
  columns: Set<string>,
  caseToColumnId: Map<string, string>,
) {
  if (columns.has(overId)) return overId;
  return caseToColumnId.get(overId) ?? null;
}

function PipelineCaseCard({
  caseItem,
  isOverlay = false,
}: {
  caseItem: PipelineCase;
  isOverlay?: boolean;
}) {
  const title = getCaseTitle(caseItem);
  const isWorking = isWorkingCase(caseItem);
  const blockerCount = getOpenBlockerCount(caseItem);
  const hasNeedsAttention = blockerCount > 0;
  const hasChangedNotice = hasThisChanged(caseItem);
  const childrenSummary = getChildrenSummaryCount(caseItem);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: caseItem.id, data: { caseItem } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`rounded-md border bg-card px-3 py-2 text-sm ${
        isDragging && !isOverlay ? "opacity-40" : ""
      } ${isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm"}`}
    >
      <Link
        to={`/pipelines/${caseItem.pipelineId}/items/${caseItem.id}`}
        onClick={(event) => {
          if (isDragging) event.preventDefault();
        }}
        className="block text-inherit no-underline"
      >
        <p className="font-medium leading-snug text-foreground">{title}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {isWorking ? (
            <span className="relative inline-flex items-center rounded-full border border-emerald-400/40 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:border-emerald-300/30 dark:bg-emerald-900/30 dark:text-emerald-300">
              <span className="absolute -left-1 -top-1 h-2 w-2 animate-pulse rounded-full bg-emerald-500"></span>
              Working
            </span>
          ) : null}
          {hasNeedsAttention ? (
            <span className="inline-flex items-center rounded-full border border-amber-400/40 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-300/30 dark:bg-amber-900/25 dark:text-amber-300">
              Needs attention
            </span>
          ) : null}
        {hasChangedNotice ? (
            <span className="inline-flex items-center rounded-full border border-indigo-400/40 bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700 dark:border-indigo-300/30 dark:bg-indigo-900/25 dark:text-indigo-300">
              This changed
            </span>
          ) : null}
        </div>
        {childrenSummary != null ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            Built from {formatNumber(childrenSummary)} items
          </p>
        ) : null}
      </Link>
    </div>
  );
}

function PipelineBoardColumn({
  stage,
  cases,
  onColumnEmpty,
  isDragTargeted,
  isDragBlocked,
}: {
  stage: PipelineStage;
  cases: PipelineCase[];
  onColumnEmpty?: (stage: PipelineStage) => string;
  isDragTargeted?: boolean;
  isDragBlocked?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });

  const isBlockedDropTarget = !!isDragTargeted && !!isDragBlocked;

  return (
    <div
      key={stage.id}
      aria-label={`${stage.name} column`}
      className={`flex min-w-[260px] max-w-[320px] shrink-0 flex-col rounded-md border border-border ${isBlockedDropTarget ? "ring-1 ring-red-500/45" : ""}`}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-sm font-semibold text-muted-foreground">
        <span>{stage.name}</span>
        <span>{cases.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={`min-h-[160px] flex-1 space-y-2 rounded-b-md px-2 py-2 transition-colors ${
          isBlockedDropTarget ? "bg-red-50 dark:bg-red-950/30" : isOver ? "bg-accent/40" : ""
        }`}
      >
        {isBlockedDropTarget ? (
          <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
            Transition not allowed by guardrails
          </p>
        ) : null}
        <SortableContext items={cases.map((entry) => entry.id)} strategy={verticalListSortingStrategy}>
          {cases.length > 0 ? (
            cases.map((item) => <PipelineCaseCard key={item.id} caseItem={item} />)
          ) : (
            <div className="rounded-md border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
              {onColumnEmpty ? onColumnEmpty(stage) : "Empty"}
            </div>
          )}
        </SortableContext>
      </div>
    </div>
  );
}

function NewPipelineDialog({
  open,
  onOpenChange,
  onSubmit,
  pending,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: { name: string; description: string }) => void;
  pending: boolean;
  error: string | null;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
    }
  }, [open]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;
    onSubmit({ name: trimmedName, description: description.trim() });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New pipeline</DialogTitle>
            <DialogDescription>Name the pipeline and add a short description.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Name</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            </label>
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Description</span>
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
              />
            </label>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? "Creating..." : "Create pipeline"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PipelineAddItemDialog({
  open,
  onOpenChange,
  intakeForm,
  onSubmit,
  pending,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  intakeForm: PipelineIntakeForm | null;
  onSubmit: (data: { items: Array<{ title: string; fields: Record<string, unknown> }> }) => void;
  pending: boolean;
  error: string | null;
}) {
  type DraftItem = { id: string; title: string; fields: Record<string, string> };
  const createDraftItem = () => {
    const initialFields: Record<string, string> = {};
    for (const field of intakeForm?.fields ?? []) {
      initialFields[field.key] = "";
    }
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title: "",
      fields: initialFields,
    };
  };
  const [items, setItems] = useState<DraftItem[]>(() => [createDraftItem()]);

  useEffect(() => {
    if (!open) return;
    setItems([createDraftItem()]);
  }, [intakeForm, open]);

  const updateItem = (itemId: string, patch: Partial<DraftItem>) => {
    setItems((current) =>
      current.map((item) => item.id === itemId ? { ...item, ...patch } : item),
    );
  };

  const updateItemField = (itemId: string, key: string, value: string) => {
    setItems((current) =>
      current.map((item) =>
        item.id === itemId ? { ...item, fields: { ...item.fields, [key]: value } } : item,
      ),
    );
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextItems = items
      .map((item) => {
        const nextFields: Record<string, unknown> = {};
        for (const field of intakeForm?.fields ?? []) {
          const value = item.fields[field.key]?.trim() ?? "";
          if (value || field.required) {
            nextFields[field.key] = value;
          }
        }
        return { title: item.title.trim(), fields: nextFields };
      })
      .filter((item) => item.title.length > 0);
    if (nextItems.length === 0) return;
    onSubmit({ items: nextItems });
  };

  const submitCount = items.filter((item) => item.title.trim()).length;
  const fieldSource = intakeForm?.stageName ?? "the first stage";

  const renderFieldControl = (item: DraftItem, field: PipelineIntakeForm["fields"][number]) => {
    if (field.type === "multiline") {
      return (
        <Textarea
          value={item.fields[field.key] ?? ""}
          onChange={(event) => updateItemField(item.id, field.key, event.target.value)}
          required={field.required}
          rows={2}
        />
      );
    }
    if (field.type === "select") {
      return (
        <select
          value={item.fields[field.key] ?? ""}
          onChange={(event) => updateItemField(item.id, field.key, event.target.value)}
          required={field.required}
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">Select...</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      );
    }
    return (
      <Input
        value={item.fields[field.key] ?? ""}
        onChange={(event) => updateItemField(item.id, field.key, event.target.value)}
        required={field.required}
      />
    );
  };

  const addAnotherItem = () => {
    setItems((current) => [...current, createDraftItem()]);
  };

  const removeItem = (itemId: string) => {
    setItems((current) => {
      if (current.length === 1) {
        return [createDraftItem()];
      }
      return current.filter((item) => item.id !== itemId);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Add items</DialogTitle>
            <DialogDescription>
              New items enter {fieldSource}. These fields come from Pipeline settings.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            {items.map((item, index) => (
              <section key={item.id} className="space-y-3 rounded-md border border-border p-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-foreground">Item {index + 1}</h3>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove item ${index + 1}`}
                    onClick={() => removeItem(item.id)}
                    disabled={pending}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <label className="block space-y-1.5 text-sm font-medium">
                  <span>Title</span>
                  <Input
                    value={item.title}
                    onChange={(event) => updateItem(item.id, { title: event.target.value })}
                    required
                    autoFocus={index === 0}
                  />
                </label>
                <div className="grid gap-3 md:grid-cols-2">
                  {(intakeForm?.fields ?? []).map((field) => (
                    <label key={field.key} className="block space-y-1.5 text-sm font-medium">
                      <span>
                        {field.label}
                        {field.required ? <span className="text-destructive"> *</span> : null}
                      </span>
                      {renderFieldControl(item, field)}
                    </label>
                  ))}
                </div>
              </section>
            ))}
            <Button type="button" variant="outline" onClick={addAnotherItem} disabled={pending}>
              <Plus className="h-4 w-4" />
              Add another item
            </Button>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || submitCount === 0}>
              {pending ? "Adding..." : `Submit ${formatNumber(submitCount)} item${submitCount === 1 ? "" : "s"}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Pipelines() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<PipelineViewMode>("nested");
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Pipelines" }]);
  }, [setBreadcrumbs]);

  const pipelinesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.pipelines.list(selectedCompanyId) : ["pipelines", "none"],
    queryFn: () =>
      pipelinesApi.list(selectedCompanyId!, {
        includeConnections: true,
        includeCounts: true,
      }),
    enabled: !!selectedCompanyId,
  });

  const createPipeline = useMutation({
    mutationFn: (data: { name: string; description: string }) =>
      pipelinesApi.create(selectedCompanyId!, {
        name: data.name,
        description: data.description || null,
      }),
    onSuccess: async (pipeline) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.list(selectedCompanyId!) });
      setNewPipelineOpen(false);
      navigate(`/pipelines/${pipeline.id}/settings`);
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a company to view pipelines." />;
  }

  if (pipelinesQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const pipelines = pipelinesQuery.data ?? [];
  const connectionsAvailable = pipelinesHaveConnectionData(pipelines);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-foreground">Pipelines</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatNumber(pipelines.length)} pipeline{pipelines.length === 1 ? "" : "s"}. Connected ones are grouped under the work they feed.
          </p>
        </div>
        <Button onClick={() => setNewPipelineOpen(true)}>
          <Plus className="h-4 w-4" />
          New pipeline
        </Button>
      </div>

      {pipelinesQuery.error ? (
        <p className="text-sm text-destructive">{pipelinesQuery.error.message}</p>
      ) : null}

      {pipelines.length === 0 && !pipelinesQuery.error ? (
        <EmptyState
          icon={Hexagon}
          message="No pipelines yet."
          action="New pipeline"
          onAction={() => setNewPipelineOpen(true)}
        />
      ) : (
        <PipelinesIndexTable
          pipelines={pipelines}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          connectionsAvailable={connectionsAvailable}
          search={search}
          onSearchChange={setSearch}
        />
      )}

      <NewPipelineDialog
        open={newPipelineOpen}
        onOpenChange={setNewPipelineOpen}
        onSubmit={(data) => createPipeline.mutate(data)}
        pending={createPipeline.isPending}
        error={createPipeline.error ? createPipeline.error.message : null}
      />
    </div>
  );
}

export function PipelineBoardStub() {
  const { pipelineId } = useParams<{ pipelineId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [activeOverId, setActiveOverId] = useState<string | null>(null);
  const [addItemOpen, setAddItemOpen] = useState(false);
  const [pendingMove, setPendingMove] = useState<{
    caseId: string;
    itemTitle: string;
    sourceName: string;
    targetStageId: string;
    targetName: string;
    allowed: boolean;
  } | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const hasBoardContext = !!selectedCompanyId && !!pipelineId;

  const pipelineQuery = useQuery({
    queryKey: pipelineId ? queryKeys.pipelines.detail(pipelineId) : ["pipelines", "detail", "none"],
    queryFn: () => pipelinesApi.get(pipelineId!),
    enabled: hasBoardContext,
  });

  const casesQuery = useQuery({
    queryKey: pipelineId ? queryKeys.pipelines.cases(pipelineId) : ["pipelines", "cases", "none"],
    queryFn: () => pipelinesApi.listCases(pipelineId!),
    enabled: hasBoardContext,
  });

  const intakeFormQuery = useQuery({
    queryKey: pipelineId ? queryKeys.pipelines.intakeForm(pipelineId) : ["pipelines", "intake-form", "none"],
    queryFn: () => pipelinesApi.getIntakeForm(pipelineId!),
    enabled: hasBoardContext,
  });

  const pipeline = pipelineQuery.data;
  const cases = casesQuery.data ?? [];

  const orderedStages = useMemo(() => {
    if (!pipeline?.stages) return [] as PipelineStage[];
    return [...pipeline.stages].sort((left, right) => left.position - right.position);
  }, [pipeline?.stages]);

  const stageIds = useMemo(() => new Set(orderedStages.map((stage) => stage.id)), [orderedStages]);

  const boardColumns = useMemo(() => {
    const byStage = new Map<string, PipelineCase[]>();
    const caseToColumn = new Map<string, string>();
    const caseById = new Map<string, PipelineCase>();

    for (const stage of orderedStages) {
      byStage.set(stage.id, []);
    }

    const unassigned: PipelineCase[] = [];
    for (const caseItem of cases) {
      const stageId = caseItem.stageId && stageIds.has(caseItem.stageId) ? caseItem.stageId : UNASSIGNED_STAGE_ID;
      if (stageId === UNASSIGNED_STAGE_ID) {
        unassigned.push(caseItem);
      }
      if (stageId !== UNASSIGNED_STAGE_ID) {
        byStage.get(stageId)!.push(caseItem);
      }
      caseToColumn.set(caseItem.id, stageId);
      caseById.set(caseItem.id, caseItem);
    }

    const columns = [...orderedStages];
    if (unassigned.length > 0) {
      if (!pipelineId) return { columns, byStage, caseToColumn, caseById };
      byStage.set(UNASSIGNED_STAGE_ID, unassigned);
      columns.push(createUnassignedStage(pipelineId));
    }

    return { columns, byStage, caseToColumn, caseById };
  }, [orderedStages, cases, stageIds, pipelineId]);

  const transitions = pipeline?.transitions ?? [];
  const transitionsEnabled = transitions.length > 0;
  const columnsById = useMemo(() => new Set(boardColumns.columns.map((stage) => stage.id)), [boardColumns.columns]);

  const stageNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const stage of boardColumns.columns) {
      map.set(stage.id, stage.name);
    }
    return map;
  }, [boardColumns.columns]);

  const transitionCase = useMutation({
    mutationFn: ({ caseId, toStageId, reason }: { caseId: string; toStageId: string; reason?: string | null }) =>
      pipelinesApi.transitionCase(caseId, { toStageId, reason }),
    onSuccess: async () => {
      setPendingMove(null);
      setOverrideReason("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId!) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(pipelineId!) });
    },
    onError: (error) => {
      pushToast({
        title: "Move blocked",
        body: error instanceof Error ? error.message : "Unable to move item",
        tone: "error",
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(pipelineId!) });
    },
  });

  const addItem = useMutation({
    mutationFn: (data: { items: Array<{ title: string; fields: Record<string, unknown> }> }) =>
      pipelinesApi.ingestCasesBatch(pipelineId!, {
        items: data.items.map((item) => ({
          title: item.title,
          fields: item.fields,
        })),
      }),
    onSuccess: async () => {
      setAddItemOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId!) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(pipelineId!) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.intakeForm(pipelineId!) });
    },
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function handleDragStart(event: DragStartEvent) {
    setActiveCaseId(event.active.id as string);
    setActiveOverId(null);
  }

  function handleDragOver(event: DragOverEvent) {
    setActiveOverId(event.over ? String(event.over.id) : null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveCaseId(null);
    setActiveOverId(null);
    const { active, over } = event;
    if (!over || !pipelineId) return;

    const activeCaseIdValue = active.id as string;
    const activeCase = boardColumns.caseById.get(activeCaseIdValue);
    if (!activeCase) return;

    const sourceStageId = boardColumns.caseToColumn.get(activeCaseIdValue) ?? null;
    const targetStageId = resolvePipelineTargetStageId(
      over.id as string,
      columnsById,
      boardColumns.caseToColumn,
    );

    if (!targetStageId || sourceStageId === targetStageId) return;

    const sourceName = stageNameById.get(sourceStageId ?? "") ?? "Unassigned";
    const targetName = stageNameById.get(targetStageId) ?? UNASSIGNED_STAGE_NAME;
    setPendingMove({
      caseId: activeCase.id,
      itemTitle: getCaseTitle(activeCase),
      sourceName,
      targetStageId,
      targetName,
      allowed: isGuardedTransitionAllowed(transitions, sourceStageId, targetStageId),
    });
  }

  useEffect(() => {
    if (!pipeline) return;
    setBreadcrumbs([
      { label: "Pipelines", href: "/pipelines" },
      { label: pipeline.name, href: `/pipelines/${pipeline.id}` },
    ]);
  }, [pipeline, setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a company to view pipeline boards." />;
  }

  if (!pipelineId) {
    return <EmptyState icon={Hexagon} message="No pipeline selected." />;
  }

  if (pipelineQuery.isLoading || casesQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (pipelineQuery.error) {
    return <p className="text-sm text-destructive">{pipelineQuery.error.message}</p>;
  }

  if (casesQuery.error) {
    return <p className="text-sm text-destructive">{casesQuery.error.message}</p>;
  }

  if (!pipeline) {
    return <EmptyState icon={Hexagon} message="Pipeline not found." />;
  }

  if (orderedStages.length === 0) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-foreground">{pipeline.name}</h1>
          <p className="text-sm text-muted-foreground">No stages are configured for this pipeline.</p>
        </div>
        <EmptyState
          icon={Hexagon}
          message="Add stages in pipeline settings to enable board view."
          action="Open settings"
          onAction={() => navigate(`/pipelines/${pipeline.id}/settings`)}
        />
      </div>
    );
  }

  const activeCase = activeCaseId ? boardColumns.caseById.get(activeCaseId) ?? null : null;
  const intakeForm = intakeFormQuery.data ?? null;
  const newEntriesDisabled = Boolean(intakeForm?.newEntriesDisabled);
  const addItemDisabled = !intakeForm?.stageId || newEntriesDisabled || intakeFormQuery.isLoading;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-foreground">{pipeline.name}</h1>
          {pipeline.description ? <p className="mt-1 text-sm text-muted-foreground">{pipeline.description}</p> : null}
          <p className="mt-1 text-xs text-muted-foreground">{cases.length} total item{cases.length === 1 ? "" : "s"}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setAddItemOpen(true)}
            disabled={addItemDisabled}
            title={newEntriesDisabled ? "New entries are disabled for the first stage" : undefined}
          >
            <Plus className="h-4 w-4" />
            Add items
          </Button>
          <Button variant="outline" onClick={() => navigate(`/pipelines/${pipeline.id}/settings`)}>
            Settings
          </Button>
        </div>
      </div>

      {newEntriesDisabled ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-300/30 dark:bg-amber-400/10 dark:text-amber-200">
          New entries are disabled for {intakeForm?.stageName ?? "the first stage"}. Existing items remain visible.
          {intakeForm?.disabledReason ? ` ${intakeForm.disabledReason}` : ""}
        </p>
      ) : null}

      {transitionsEnabled ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-300/30 dark:bg-amber-400/10 dark:text-amber-200">
          Drag is guarded by pipeline transition rules.
        </p>
      ) : null}

        <DndContext
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          sensors={sensors}
        >
        <div className="overflow-x-auto">
          <div className="flex items-start gap-3 pb-3">
            {boardColumns.columns.map((stage) => {
              const items = boardColumns.byStage.get(stage.id) ?? [];
              const activeSourceStageId = activeCaseId ? boardColumns.caseToColumn.get(activeCaseId) ?? null : null;
              const activeTargetStageId = activeOverId
                ? resolvePipelineTargetStageId(activeOverId, columnsById, boardColumns.caseToColumn)
                : null;
              const isDragTargeted = activeTargetStageId === stage.id;
              const isDragBlocked = isDragTargeted
                ? !isGuardedTransitionAllowed(
                    transitions,
                    activeSourceStageId,
                    stage.id,
                  )
                : false;
              return (
                <PipelineBoardColumn
                  key={stage.id}
                  stage={stage}
                  cases={items}
                  isDragTargeted={isDragTargeted}
                  isDragBlocked={isDragBlocked}
                  onColumnEmpty={(columnStage) =>
                    columnStage.id === UNASSIGNED_STAGE_ID
                      ? "Unassigned items"
                      : "Drop items here"
                  }
                />
              );
            })}
          </div>
        </div>

        <DragOverlay>
          {activeCase ? <PipelineCaseCard caseItem={activeCase} isOverlay /> : null}
        </DragOverlay>
      </DndContext>

      <PipelineAddItemDialog
        open={addItemOpen}
        onOpenChange={setAddItemOpen}
        intakeForm={intakeForm}
        onSubmit={(data) => addItem.mutate(data)}
        pending={addItem.isPending}
        error={addItem.error ? addItem.error.message : null}
      />

      <Dialog
        open={Boolean(pendingMove)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingMove(null);
            setOverrideReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingMove?.allowed ? `Move ${pendingMove.itemTitle}?` : "This skips the normal flow"}
            </DialogTitle>
            <DialogDescription>
              {pendingMove?.allowed
                ? `Move ${pendingMove.itemTitle} to ${pendingMove.targetName} yourself? Usually the agent suggests this when it is ready.`
                : pendingMove
                  ? `${pendingMove.itemTitle} would jump from ${pendingMove.sourceName} to ${pendingMove.targetName}. Add a reason before overriding.`
                  : "Review this move before continuing."}
            </DialogDescription>
          </DialogHeader>
          {pendingMove && !pendingMove.allowed ? (
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Reason</span>
              <Textarea
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                rows={3}
                placeholder="Explain why this item should skip the normal flow."
                autoFocus
              />
            </label>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={transitionCase.isPending}
              onClick={() => {
                setPendingMove(null);
                setOverrideReason("");
              }}
            >
              Cancel
            </Button>
            {pendingMove?.allowed ? (
              <Button
                type="button"
                disabled={transitionCase.isPending}
                onClick={() =>
                  transitionCase.mutate({
                    caseId: pendingMove.caseId,
                    toStageId: pendingMove.targetStageId,
                  })
                }
              >
                Move it
              </Button>
            ) : pendingMove ? (
              <Button
                type="button"
                variant="destructive"
                disabled={transitionCase.isPending || !overrideReason.trim()}
                onClick={() =>
                  transitionCase.mutate({
                    caseId: pendingMove.caseId,
                    toStageId: pendingMove.targetStageId,
                    reason: overrideReason.trim(),
                  })
                }
              >
                Override and move
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StubPage({ title }: { title: string }) {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: title }]);
  }, [setBreadcrumbs, title]);

  return (
    <div className="py-10">
      <h1 className="text-2xl font-semibold tracking-normal">{title}</h1>
    </div>
  );
}

export function PipelineItemStub() {
  const { pipelineId, caseId } = useParams<{ pipelineId: string; caseId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const pipelineQuery = useQuery({
    queryKey: pipelineId ? queryKeys.pipelines.detail(pipelineId) : ["pipelines", "detail", "none"],
    queryFn: () => pipelinesApi.get(pipelineId!),
    enabled: !!selectedCompanyId && !!pipelineId,
  });

  const itemQuery = useQuery({
    queryKey: caseId ? queryKeys.pipelines.caseDetail(caseId) : ["pipelines", "case", "none"],
    queryFn: () => pipelinesApi.getCase(caseId!),
    enabled: !!selectedCompanyId && !!caseId,
  });

  const eventsQuery = useQuery({
    queryKey: caseId ? queryKeys.pipelines.caseEvents(caseId) : ["pipelines", "case", "none", "events"],
    queryFn: () => pipelinesApi.listCaseEvents(caseId!),
    enabled: !!selectedCompanyId && !!caseId,
  });

  const childrenQuery = useQuery({
    queryKey: caseId ? queryKeys.pipelines.caseChildren(caseId) : ["pipelines", "case", "none", "children"],
    queryFn: () => pipelinesApi.listChildren(caseId!),
    enabled: !!selectedCompanyId && !!caseId,
  });

  const issueLinksQuery = useQuery({
    queryKey: caseId ? queryKeys.pipelines.caseIssueLinks(caseId) : ["pipelines", "case", "none", "issue-links"],
    queryFn: () => pipelinesApi.listIssueLinks(caseId!),
    enabled: !!selectedCompanyId && !!caseId,
  });

  const pipeline = pipelineQuery.data ?? null;
  const item = itemQuery.data ?? null;
  const stages = useMemo(() => [...(pipeline?.stages ?? [])].sort((left, right) => left.position - right.position), [pipeline?.stages]);
  const currentStage = stages.find((stage) => stage.id === item?.stageId) ?? null;
  const pendingSuggestion = getPendingTransitionBannerState(item, stages);
  const fieldEntries = displayPipelineItemFields(item?.fields ?? null);
  const children = childrenQuery.data ?? [];
  const events = eventsQuery.data ?? [];
  const workLink = (issueLinksQuery.data ?? []).find((link) => link.role === "work" || link.role === "conversation")
    ?? (issueLinksQuery.data ?? [])[0]
    ?? null;

  useEffect(() => {
    if (!pipeline || !item) return;
    setBreadcrumbs([
      { label: "Pipelines", href: "/pipelines" },
      { label: pipeline.name, href: `/pipelines/${pipeline.id}` },
      { label: getCaseTitle(item) },
    ]);
  }, [item, pipeline, setBreadcrumbs]);

  const resolveSuggestion = useMutation({
    mutationFn: (decision: "accept" | "decline") =>
      pipelinesApi.resolveSuggestion(caseId!, {
        decision,
        note: decision === "accept" ? "Accepted from the item page." : "Kept in the current stage.",
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseDetail(caseId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseEvents(caseId!) }),
        pipelineId
          ? queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(pipelineId) })
          : Promise.resolve(),
      ]);
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a company to view this item." />;
  }

  if (!pipelineId || !caseId) {
    return <EmptyState icon={Hexagon} message="No item selected." />;
  }

  if (pipelineQuery.isLoading || itemQuery.isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (pipelineQuery.error || itemQuery.error) {
    return <p className="text-sm text-destructive">Could not load this item.</p>;
  }

  if (!pipeline || !item) {
    return <EmptyState icon={Hexagon} message="Item not found." />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link to={`/pipelines/${pipeline.id}`} className="text-sm text-muted-foreground hover:text-foreground">
            Back to board
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-normal text-foreground">{getCaseTitle(item)}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-full border border-border px-2 py-0.5 font-semibold text-muted-foreground">
              {currentStage?.name ?? "No stage"}
            </span>
            <span className="rounded-full border border-border px-2 py-0.5 text-muted-foreground">
              {humanizePipelineItemStatus(item.status)}
            </span>
            {itemHasChangedNotice(item) ? (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 font-semibold text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300">
                This changed
              </span>
            ) : null}
          </div>
        </div>
        {workLink ? (
          <Button asChild variant="outline">
            <Link to={`/issues/${workLink.issueId}`}>
              <ExternalLink className="h-4 w-4" />
              Open full view
            </Link>
          </Button>
        ) : null}
      </div>

      {pendingSuggestion.visible ? (
        <section className="rounded-md border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/70 dark:bg-amber-950/30">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Agent suggests moving this item</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Move to <span className="font-semibold text-foreground">{pendingSuggestion.toStageName}</span>
                {pendingSuggestion.reason ? ` - ${pendingSuggestion.reason}` : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={resolveSuggestion.isPending}
                onClick={() => resolveSuggestion.mutate("decline")}
              >
                Decline
              </Button>
              <Button
                type="button"
                disabled={resolveSuggestion.isPending}
                onClick={() => resolveSuggestion.mutate("accept")}
              >
                Accept
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Item details</h2>
        {fieldEntries.length > 0 ? (
          <div className="divide-y divide-border rounded-md border border-border">
            {fieldEntries.map((field) => (
              <div key={field.key} className="grid gap-2 px-3 py-2 text-sm sm:grid-cols-[180px_1fr]">
                <span className="text-muted-foreground">{field.label}</span>
                <span className="text-foreground">{field.value}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-md border border-border px-3 py-3 text-sm text-muted-foreground">
            No details have been added yet.
          </p>
        )}
      </section>

      {children.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Built from {formatNumber(children.length)} items</h2>
          <div className="divide-y divide-border rounded-md border border-border">
            {children.map((child) => (
              <Link
                key={child.id}
                to={`/pipelines/${child.pipelineId}/items/${child.id}`}
                className="grid min-h-10 grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 text-sm hover:bg-accent/40"
              >
                <span className="font-medium text-foreground">{getCaseTitle(child)}</span>
                <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                  {humanizePipelineItemStatus(child.status)}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Activity</h2>
        {events.length > 0 ? (
          <div className="divide-y divide-border rounded-md border border-border">
            {events.slice(0, 8).map((event) => {
              const presentation = formatPipelineItemEvent(event, item.title);
              return (
                <div key={event.id} className="px-3 py-2 text-sm text-foreground">
                  {presentation.sentence}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="rounded-md border border-border px-3 py-3 text-sm text-muted-foreground">
            No activity yet.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Activity & conversation</h2>
        {workLink ? (
          <p className="rounded-md border border-border px-3 py-3 text-sm text-muted-foreground">
            A work conversation is linked to this item. Open the full view to continue the thread.
          </p>
        ) : (
          <p className="rounded-md border border-border px-3 py-3 text-sm text-muted-foreground">
            No work conversation is linked yet.
          </p>
        )}
      </section>
    </div>
  );
}

function ReviewQueueStatusChip({ failed }: { failed: boolean }) {
  if (!failed) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300">
      <AlertTriangle className="h-3 w-3" />
      Needs attention
    </span>
  );
}

function reviewQueueFieldEntries(caseItem: PipelineCase | undefined) {
  const fields = caseItem?.fields ?? {};
  const hidden = new Set([
    "nextSuggestedStageId",
    "nextSuggestedStageReason",
    "suggestionResolution",
    "review",
  ]);
  return Object.entries(fields)
    .filter(([key, value]) => !hidden.has(key) && ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 6);
}

function ReviewQueueDetailDialog({
  row,
  open,
  pending,
  onOpenChange,
  onApprove,
  onRequestChanges,
}: {
  row: ReviewQueueRow | null;
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onApprove: (note: string) => void;
  onRequestChanges: (note: string) => void;
}) {
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open) setNote("");
  }, [open]);

  const fields = reviewQueueFieldEntries(row?.caseItem);
  const trimmedNote = note.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{row?.title ?? "Review item"}</DialogTitle>
          <DialogDescription>
            {row ? `${row.pipelineName} is waiting for your decision.` : "Review the item and decide what happens next."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">What is being decided</p>
            <p className="text-sm text-foreground">{row?.prompt}</p>
          </section>

          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Item preview</p>
            {fields.length > 0 ? (
              <div className="divide-y divide-border rounded-md border border-border">
                {fields.map(([key, value]) => (
                  <div key={key} className="grid grid-cols-[160px_1fr] gap-3 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">{humanizeFieldLabel(key)}</span>
                    <span className="text-foreground">{String(value)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-md border border-border px-3 py-3 text-sm text-muted-foreground">
                No preview details yet.
              </p>
            )}
          </section>

          <label className="block space-y-1.5 text-sm font-medium">
            <span>Note</span>
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              placeholder="Required when requesting changes."
            />
          </label>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="outline" onClick={() => onRequestChanges(trimmedNote)} disabled={pending || !trimmedNote}>
            Request changes
          </Button>
          <Button type="button" onClick={() => onApprove(trimmedNote)} disabled={pending}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewQueueSection({
  title,
  rows,
  activeRowId,
  failedRowIds,
  selectedRowIds,
  pendingRowIds,
  showSelection,
  onActivate,
  onToggleSelected,
  onApprove,
  onDecline,
  onRequestChanges,
  onOpen,
}: {
  title: string;
  rows: ReviewQueueRow[];
  activeRowId: string | null;
  failedRowIds: Set<string>;
  selectedRowIds: Set<string>;
  pendingRowIds: Set<string>;
  showSelection: boolean;
  onActivate: (rowId: string) => void;
  onToggleSelected: (rowId: string) => void;
  onApprove: (row: ReviewQueueRow) => void;
  onDecline: (row: ReviewQueueRow) => void;
  onRequestChanges: (row: ReviewQueueRow) => void;
  onOpen: (row: ReviewQueueRow) => void;
}) {
  if (rows.length === 0) return null;

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between border-b border-border pb-2">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <span className="text-xs text-muted-foreground">{formatNumber(rows.length)} item{rows.length === 1 ? "" : "s"}</span>
      </div>
      <div className="divide-y divide-border">
        {rows.map((row) => {
          const pending = pendingRowIds.has(row.id);
          const failed = failedRowIds.has(row.id);
          const selected = selectedRowIds.has(row.id);
          const active = activeRowId === row.id;
          const selectable = row.kind !== "headsUp" && Boolean(row.caseId);

          return (
            <div
              key={row.id}
              role="button"
              tabIndex={0}
              aria-current={active ? "true" : undefined}
              className={cn(
                "grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-2 py-2 text-sm outline-none transition-colors",
                active ? "bg-accent/60" : "hover:bg-accent/40",
              )}
              onMouseEnter={() => onActivate(row.id)}
              onFocus={() => onActivate(row.id)}
              onClick={() => onOpen(row)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onOpen(row);
              }}
            >
              <div className="flex min-w-0 items-center gap-3">
                {showSelection ? (
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.title}`}
                    checked={selected}
                    disabled={!selectable || pending}
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => onToggleSelected(row.id)}
                    className="h-4 w-4 rounded border-border"
                  />
                ) : null}
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate font-semibold text-foreground">{row.title}</p>
                    <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                      {row.pipelineName}
                    </span>
                    <ReviewQueueStatusChip failed={failed} />
                  </div>
                  <p className="truncate text-muted-foreground">{row.prompt}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="hidden whitespace-nowrap text-xs text-muted-foreground sm:inline">
                  {row.createdAt ? relativeTime(row.createdAt) : "recently"}
                </span>
                {row.kind === "suggestion" ? (
                  <>
                    <Button type="button" size="sm" disabled={pending || !row.caseId} onClick={(event) => {
                      event.stopPropagation();
                      onApprove(row);
                    }}>
                      Approve
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={pending || !row.caseId} onClick={(event) => {
                      event.stopPropagation();
                      onDecline(row);
                    }}>
                      Not yet
                    </Button>
                  </>
                ) : row.kind === "review" ? (
                  <>
                    <Button type="button" size="sm" disabled={pending || !row.caseId} onClick={(event) => {
                      event.stopPropagation();
                      onApprove(row);
                    }}>
                      Approve
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={pending || !row.caseId} onClick={(event) => {
                      event.stopPropagation();
                      onRequestChanges(row);
                    }}>
                      Request changes
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function ReviewQueueStub() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(() => new Set());
  const [hiddenRowIds, setHiddenRowIds] = useState<Set<string>>(() => new Set());
  const [failedRowIds, setFailedRowIds] = useState<Set<string>>(() => new Set());
  const [pendingRowIds, setPendingRowIds] = useState<Set<string>>(() => new Set());
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [detailRow, setDetailRow] = useState<ReviewQueueRow | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Review queue" }]);
  }, [setBreadcrumbs]);

  const pipelinesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.pipelines.list(selectedCompanyId) : ["pipelines", "none"],
    queryFn: () => pipelinesApi.list(selectedCompanyId!, { includeCounts: true }),
    enabled: !!selectedCompanyId,
  });

  const attentionQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.pipelines.attention(selectedCompanyId) : ["pipelines", "attention", "none"],
    queryFn: () => pipelinesApi.listAttention(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const reviewCasesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.pipelines.reviewCases(selectedCompanyId) : ["pipelines", "review-cases", "none"],
    queryFn: () => pipelinesApi.listReviewCases(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const rows = useMemo(
    () =>
      buildReviewQueueRows({
        attentionItems: attentionQuery.data ?? [],
        reviewCases: reviewCasesQuery.data ?? [],
        pipelines: pipelinesQuery.data ?? [],
      }),
    [attentionQuery.data, pipelinesQuery.data, reviewCasesQuery.data],
  );

  const visibleRows = rows.filter((row) => !hiddenRowIds.has(row.id));
  const actionableRows = visibleRows.filter((row) => row.kind !== "headsUp" && row.caseId);
  const selectedRows = visibleRows.filter((row) => selectedRowIds.has(row.id) && row.kind !== "headsUp" && row.caseId);
  const groupedRows = REVIEW_QUEUE_SECTION_ORDER.map((kind) => ({
    kind,
    rows: visibleRows.filter((row) => row.kind === kind),
  }));

  useEffect(() => {
    if (visibleRows.length === 0) {
      setActiveRowId(null);
      return;
    }
    if (!activeRowId || !visibleRows.some((row) => row.id === activeRowId)) {
      setActiveRowId(visibleRows[0].id);
    }
  }, [activeRowId, visibleRows]);

  const invalidateReviewQueue = async () => {
    if (!selectedCompanyId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.attention(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.reviewCases(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.list(selectedCompanyId) }),
    ]);
  };

  const decideRow = useMutation({
    mutationFn: async ({ row, decision, note }: { row: ReviewQueueRow; decision: "approve" | "decline" | "request_changes"; note?: string }) => {
      if (!row.caseId) throw new Error("This item is not ready for a decision.");
      if (row.kind === "suggestion") {
        await pipelinesApi.resolveSuggestion(row.caseId, {
          decision: decision === "decline" ? "decline" : "accept",
          note: note || null,
        });
        return;
      }
      await pipelinesApi.reviewCase(row.caseId, {
        decision: decision === "request_changes" ? "request_changes" : "approve",
        note: note || null,
      });
    },
    onMutate: ({ row }) => {
      setPendingRowIds((current) => new Set(current).add(row.id));
      setHiddenRowIds((current) => new Set(current).add(row.id));
      setFailedRowIds((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
      setSelectedRowIds((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
    },
    onError: (_error, { row }) => {
      setHiddenRowIds((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
      setFailedRowIds((current) => new Set(current).add(row.id));
    },
    onSettled: async (_data, _error, { row }) => {
      setPendingRowIds((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
      await invalidateReviewQueue();
    },
  });

  const bulkApprove = useMutation({
    mutationFn: async (targetRows: ReviewQueueRow[]) => {
      if (!selectedCompanyId) throw new Error("Select a company first.");
      const reviewIds = targetRows
        .filter((row) => row.kind === "review" && row.caseId)
        .map((row) => row.caseId!);
      const suggestionRows = targetRows.filter((row) => row.kind === "suggestion" && row.caseId);
      await Promise.all([
        reviewIds.length > 0
          ? pipelinesApi.bulkReviewCases(selectedCompanyId, { caseIds: reviewIds, decision: "approve" })
          : Promise.resolve(),
        ...suggestionRows.map((row) =>
          pipelinesApi.resolveSuggestion(row.caseId!, { decision: "accept" }),
        ),
      ]);
    },
    onMutate: (targetRows) => {
      const ids = targetRows.map((row) => row.id);
      setPendingRowIds((current) => new Set([...current, ...ids]));
      setHiddenRowIds((current) => new Set([...current, ...ids]));
      setSelectedRowIds(new Set());
      setFailedRowIds((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
    },
    onError: (_error, targetRows) => {
      const ids = targetRows.map((row) => row.id);
      setHiddenRowIds((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
      setFailedRowIds((current) => new Set([...current, ...ids]));
    },
    onSettled: async (_data, _error, targetRows) => {
      const ids = targetRows.map((row) => row.id);
      setPendingRowIds((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
      await invalidateReviewQueue();
    },
  });

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        hasBlockingShortcutDialog() ||
        isKeyboardShortcutTextInputTarget(event.target) ||
        visibleRows.length === 0
      ) {
        return;
      }

      const currentIndex = Math.max(0, visibleRows.findIndex((row) => row.id === activeRowId));
      const key = event.key.toLowerCase();
      if (event.key === "ArrowDown" || key === "j") {
        event.preventDefault();
        setActiveRowId(visibleRows[Math.min(visibleRows.length - 1, currentIndex + 1)].id);
        return;
      }
      if (event.key === "ArrowUp" || key === "k") {
        event.preventDefault();
        setActiveRowId(visibleRows[Math.max(0, currentIndex - 1)].id);
        return;
      }

      const activeRow = visibleRows[currentIndex];
      if (!activeRow) return;
      if (event.key === "Enter") {
        event.preventDefault();
        setDetailRow(activeRow);
        return;
      }
      if (key === "a" && activeRow.kind !== "headsUp" && activeRow.caseId) {
        event.preventDefault();
        decideRow.mutate({ row: activeRow, decision: "approve" });
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeRowId, decideRow, visibleRows]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a company to view the review queue." />;
  }

  if (pipelinesQuery.isLoading || attentionQuery.isLoading || reviewCasesQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const selectedCount = selectedRows.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-foreground">Review queue</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Needs your attention ({formatNumber(visibleRows.length)})
          </p>
        </div>
        <Button
          type="button"
          disabled={selectedCount === 0 || bulkApprove.isPending}
          onClick={() => bulkApprove.mutate(selectedRows)}
        >
          {bulkApprove.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Approve {formatNumber(selectedCount)} item{selectedCount === 1 ? "" : "s"}
        </Button>
      </div>

      {attentionQuery.error || reviewCasesQuery.error ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">Some items need attention. Try again in a moment.</p>
      ) : null}

      {visibleRows.length === 0 ? (
        <EmptyState icon={Check} message="Nothing needs you right now." />
      ) : (
        <div className="space-y-6">
          {groupedRows.map((group) => (
            <ReviewQueueSection
              key={group.kind}
              title={REVIEW_QUEUE_SECTION_LABELS[group.kind]}
              rows={group.rows}
              activeRowId={activeRowId}
              failedRowIds={failedRowIds}
              selectedRowIds={selectedRowIds}
              pendingRowIds={pendingRowIds}
              showSelection={actionableRows.length > 1}
              onActivate={setActiveRowId}
              onToggleSelected={(rowId) => {
                setSelectedRowIds((current) => {
                  const next = new Set(current);
                  if (next.has(rowId)) next.delete(rowId);
                  else next.add(rowId);
                  return next;
                });
              }}
              onApprove={(row) => decideRow.mutate({ row, decision: "approve" })}
              onDecline={(row) => decideRow.mutate({ row, decision: "decline" })}
              onRequestChanges={(row) => setDetailRow(row)}
              onOpen={(row) => setDetailRow(row)}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Shortcuts: <span className="font-semibold">j</span>/<span className="font-semibold">k</span> or arrow keys move, <span className="font-semibold">Enter</span> opens, <span className="font-semibold">a</span> approves.
      </p>

      <ReviewQueueDetailDialog
        row={detailRow}
        open={Boolean(detailRow)}
        pending={decideRow.isPending}
        onOpenChange={(open) => {
          if (!open) setDetailRow(null);
        }}
        onApprove={(note) => {
          if (!detailRow) return;
          decideRow.mutate({ row: detailRow, decision: "approve", note });
          setDetailRow(null);
        }}
        onRequestChanges={(note) => {
          if (!detailRow) return;
          decideRow.mutate({ row: detailRow, decision: "request_changes", note });
          setDetailRow(null);
        }}
      />
    </div>
  );
}

export function LearningsStub() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [pipelineFilter, setPipelineFilter] = useState("all");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setBreadcrumbs([{ label: "Learnings" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    setOffset(0);
  }, [pipelineFilter]);

  const pipelinesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.pipelines.list(selectedCompanyId) : ["pipelines", "none"],
    queryFn: () => pipelinesApi.list(selectedCompanyId!, { includeCounts: true }),
    enabled: !!selectedCompanyId,
  });

  const learningsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.pipelines.learnings(selectedCompanyId, pipelineFilter, offset)
      : ["pipelines", "none", "learnings"],
    queryFn: () =>
      pipelinesApi.listCompanyCaseEvents(selectedCompanyId!, {
        types: LEARNING_EVENT_TYPES,
        pipelineId: pipelineFilter === "all" ? undefined : pipelineFilter,
        limit: LEARNINGS_PAGE_SIZE,
        offset,
      }),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={BookOpenText} message="Select a company to view learnings." />;
  }

  if (learningsQuery.isLoading && !learningsQuery.data) {
    return <PageSkeleton variant="list" />;
  }

  const pipelines = pipelinesQuery.data ?? [];
  const events = learningsQuery.data ?? [];
  const groups = groupLearningEventsByDay(events);
  const selectedPipelineName = pipelineFilter === "all"
    ? "All pipelines"
    : pipelines.find((pipeline) => pipeline.id === pipelineFilter)?.name ?? "Selected pipeline";
  const firstVisible = events.length === 0 ? 0 : offset + 1;
  const lastVisible = offset + events.length;
  const canGoPrevious = offset > 0;
  const canGoNext = events.length === LEARNINGS_PAGE_SIZE;

  return (
    <div className="space-y-6">
      <div className="border-b border-border pb-5">
        <h1 className="text-2xl font-semibold tracking-normal text-foreground">Learnings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Patterns from review decisions and hand moves, in plain words.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-muted-foreground">Pipeline</span>
          <Select value={pipelineFilter} onValueChange={setPipelineFilter} disabled={pipelinesQuery.isLoading}>
            <SelectTrigger className="h-9 w-[220px]" aria-label="Filter learnings by pipeline">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All pipelines</SelectItem>
              {pipelines.map((pipeline) => (
                <SelectItem key={pipeline.id} value={pipeline.id}>{pipeline.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-sm text-muted-foreground">
          {learningsQuery.isFetching
            ? "Refreshing..."
            : events.length > 0
              ? `${selectedPipelineName} · ${formatNumber(firstVisible)}-${formatNumber(lastVisible)}`
              : selectedPipelineName}
        </p>
      </div>

      {learningsQuery.error ? (
        <p className="text-sm text-destructive">Could not load learnings.</p>
      ) : groups.length === 0 ? (
        <EmptyState icon={BookOpenText} message="No learnings yet." />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.key} className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                {group.label}
              </h2>
              <div className="overflow-hidden rounded-md border border-border">
                {group.events.map((event) => {
                  const presentation = formatLearningEvent(event);
                  const forcedMove = presentation.kind === "forced_move";
                  return (
                    <div
                      key={event.id}
                      className={cn(
                        "grid min-h-11 grid-cols-[6rem_1fr] items-center gap-3 border-b border-border/70 px-3 py-2 text-sm last:border-b-0",
                        forcedMove && "border-l-2 border-l-amber-400 bg-amber-50/50 dark:bg-amber-400/10",
                      )}
                    >
                      <span className="text-xs text-muted-foreground" title={new Date(event.createdAt).toLocaleString()}>
                        {relativeTime(event.createdAt)}
                      </span>
                      <div className="min-w-0">
                        <Link
                          to={`/pipelines/${event.pipelineId}/items/${event.caseId}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {presentation.sentence}
                        </Link>
                        {event.pipelineName ? (
                          <span className="ml-2 text-muted-foreground">{event.pipelineName}</span>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          disabled={!canGoPrevious}
          onClick={() => setOffset((current) => Math.max(0, current - LEARNINGS_PAGE_SIZE))}
        >
          Previous
        </Button>
        <span className="text-sm text-muted-foreground">
          {events.length > 0 ? `${formatNumber(firstVisible)}-${formatNumber(lastVisible)}` : "No rows"}
        </span>
        <Button
          type="button"
          variant="outline"
          disabled={!canGoNext}
          onClick={() => setOffset((current) => current + LEARNINGS_PAGE_SIZE)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
