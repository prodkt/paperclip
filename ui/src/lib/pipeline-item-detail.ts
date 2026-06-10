import type { PipelineCase, PipelineCaseEvent, PipelineStage } from "../api/pipelines";

export type PendingTransitionBannerState =
  | { visible: false }
  | {
      visible: true;
      toStageId: string;
      toStageName: string;
      reason: string | null;
    };

export type PipelineItemEventPresentation = {
  sentence: string;
  tone: "neutral" | "positive" | "attention";
};

export type PipelineItemFieldEntry = {
  key: string;
  label: string;
  value: string;
};

const INTERNAL_FIELD_KEYS = new Set([
  "activeWork",
  "blockedByCaseIds",
  "childrenSummary",
  "nextSuggestedStageId",
  "nextSuggestedStageName",
  "nextSuggestedStageReason",
  "review",
  "suggestionResolution",
  "thisChanged",
  "upstreamChanged",
  "upstreamDrift",
  "changeAcknowledgedAt",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stageNameById(stages: PipelineStage[]): Map<string, string> {
  return new Map(stages.map((stage) => [stage.id, stage.name]));
}

function payloadText(event: PipelineCaseEvent, ...keys: string[]): string | null {
  const payload = asRecord(event.payload);
  for (const key of keys) {
    const value = asString(payload[key]);
    if (value) return value;
  }
  return null;
}

function sentenceSubject(event: PipelineCaseEvent, fallbackTitle?: string | null): string {
  return event.caseTitle ?? payloadText(event, "itemTitle", "title") ?? asString(fallbackTitle) ?? "This item";
}

export function humanizePipelineItemStatus(status: string | null | undefined): string {
  const normalized = status?.trim().toLowerCase();
  if (!normalized || normalized === "open") return "Open";
  if (normalized === "done" || normalized === "finished" || normalized === "complete") return "Finished";
  if (normalized === "cancelled" || normalized === "canceled" || normalized === "dropped") return "Removed";
  if (normalized === "in_review" || normalized === "review") return "Needs review";
  if (normalized === "in_progress" || normalized === "working") return "In motion";
  return normalized
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getPendingTransitionBannerState(
  item: PipelineCase | null | undefined,
  stages: PipelineStage[],
): PendingTransitionBannerState {
  if (!item) return { visible: false };
  const fields = asRecord(item.fields);
  if (asRecord(fields.suggestionResolution).decision) return { visible: false };

  const toStageId = asString(fields.nextSuggestedStageId);
  if (!toStageId) return { visible: false };

  return {
    visible: true,
    toStageId,
    toStageName:
      asString(fields.nextSuggestedStageName) ??
      stageNameById(stages).get(toStageId) ??
      "the next stage",
    reason: asString(fields.nextSuggestedStageReason),
  };
}

export function itemHasChangedNotice(item: PipelineCase | null | undefined): boolean {
  if (!item) return false;
  const fields = asRecord(item.fields);
  if (fields.changeAcknowledgedAt) return false;
  return item.thisChanged === true || fields.thisChanged === true || fields.upstreamChanged === true || !!fields.upstreamDrift;
}

function formatReviewDecision(decision: string | null): string {
  if (decision === "request_changes") return "requested changes";
  if (decision === "drop") return "removed this item";
  return "approved this item";
}

export function formatPipelineItemEvent(
  event: PipelineCaseEvent,
  fallbackTitle?: string | null,
): PipelineItemEventPresentation {
  const title = sentenceSubject(event, fallbackTitle);

  if (event.kind === "case.ingested") {
    const stage = event.toStageName ?? payloadText(event, "toStageName", "stageName");
    return {
      tone: "neutral",
      sentence: stage ? `${title} was added to ${stage}.` : `${title} was added.`,
    };
  }

  if (event.kind === "case.updated") {
    return {
      tone: "neutral",
      sentence: `${title} was updated.`,
    };
  }

  if (event.kind === "case.transitioned") {
    const fromStage = event.fromStageName ?? payloadText(event, "fromStageName");
    const toStage = event.toStageName ?? payloadText(event, "toStageName", "stageName", "targetStageName");
    const fromCopy = fromStage ? ` from ${fromStage}` : "";
    const toCopy = toStage ? ` to ${toStage}` : "";
    return {
      tone: "positive",
      sentence: `${title} moved${fromCopy}${toCopy}.`,
    };
  }

  if (event.kind === "case.suggested") {
    const toStage = event.toStageName ?? payloadText(event, "toStageName", "stageName", "targetStageName");
    const reason = payloadText(event, "reason", "note");
    const reasonCopy = reason ? ` ${reason}` : "";
    return {
      tone: "attention",
      sentence: toStage
        ? `An agent suggested moving ${title} to ${toStage}.${reasonCopy}`
        : `An agent suggested moving ${title}.${reasonCopy}`,
    };
  }

  if (event.kind === "case.suggestion_resolved") {
    const decision = payloadText(event, "decision");
    return {
      tone: decision === "accept" ? "positive" : "neutral",
      sentence: decision === "accept"
        ? `You approved the suggestion for ${title}.`
        : `You kept ${title} where it is.`,
    };
  }

  if (event.kind === "case.reviewed") {
    return {
      tone: "neutral",
      sentence: `You ${formatReviewDecision(payloadText(event, "decision"))}.`,
    };
  }

  return {
    tone: "neutral",
    sentence: `${title} changed.`,
  };
}

function humanizeFieldLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatFieldValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const values = value.map(formatFieldValue).filter((entry): entry is string => Boolean(entry));
    return values.length > 0 ? values.join(", ") : null;
  }
  const record = asRecord(value);
  return asString(record.label) ?? asString(record.name) ?? asString(record.title) ?? "Added details";
}

export function displayPipelineItemFields(fields: Record<string, unknown> | null | undefined): PipelineItemFieldEntry[] {
  const record = asRecord(fields);
  return Object.entries(record)
    .filter(([key]) => !INTERNAL_FIELD_KEYS.has(key))
    .map(([key, value]) => ({
      key,
      label: humanizeFieldLabel(key),
      value: formatFieldValue(value),
    }))
    .filter((entry): entry is PipelineItemFieldEntry => Boolean(entry.value));
}
