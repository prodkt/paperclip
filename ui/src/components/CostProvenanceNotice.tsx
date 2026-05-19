import { cn, formatCents, formatTokens } from "@/lib/utils";

export interface CostProvenanceTotals {
  estimatedMeteredCostCents?: number | null;
  estimatedMeteredInputTokens?: number | null;
  estimatedMeteredCachedInputTokens?: number | null;
  estimatedMeteredOutputTokens?: number | null;
  estimatedMeteredEventCount?: number | null;
  unavailableMeteredInputTokens?: number | null;
  unavailableMeteredCachedInputTokens?: number | null;
  unavailableMeteredOutputTokens?: number | null;
  unavailableMeteredEventCount?: number | null;
}

export function estimatedMeteredTokens(totals: CostProvenanceTotals | null | undefined) {
  return (
    (totals?.estimatedMeteredInputTokens ?? 0) +
    (totals?.estimatedMeteredCachedInputTokens ?? 0) +
    (totals?.estimatedMeteredOutputTokens ?? 0)
  );
}

export function unavailableMeteredTokens(totals: CostProvenanceTotals | null | undefined) {
  return (
    (totals?.unavailableMeteredInputTokens ?? 0) +
    (totals?.unavailableMeteredCachedInputTokens ?? 0) +
    (totals?.unavailableMeteredOutputTokens ?? 0)
  );
}

export function hasCostProvenanceWarning(totals: CostProvenanceTotals | null | undefined) {
  return (totals?.estimatedMeteredCostCents ?? 0) > 0 ||
    (totals?.estimatedMeteredEventCount ?? 0) > 0 ||
    unavailableMeteredTokens(totals) > 0 ||
    (totals?.unavailableMeteredEventCount ?? 0) > 0;
}

export function formatCostProvenanceSummary(totals: CostProvenanceTotals | null | undefined) {
  const parts: string[] = [];
  const estimatedCost = totals?.estimatedMeteredCostCents ?? 0;
  const estimatedEvents = totals?.estimatedMeteredEventCount ?? 0;
  const unpricedTokens = unavailableMeteredTokens(totals);
  if (estimatedCost > 0) {
    parts.push(`${formatCents(estimatedCost)} estimated metered API`);
  } else if (estimatedEvents > 0) {
    parts.push(`${estimatedEvents} estimated metered API event${estimatedEvents === 1 ? "" : "s"}`);
  }
  if (unpricedTokens > 0) {
    parts.push(`${formatTokens(unpricedTokens)} unpriced metered API`);
  } else if ((totals?.unavailableMeteredEventCount ?? 0) > 0) {
    parts.push(`${totals?.unavailableMeteredEventCount ?? 0} unpriced metered API event${totals?.unavailableMeteredEventCount === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

export function CostProvenanceNotice({
  totals,
  className,
  compact = false,
}: {
  totals: CostProvenanceTotals | null | undefined;
  className?: string;
  compact?: boolean;
}) {
  if (!hasCostProvenanceWarning(totals)) return null;

  const estimatedCost = totals?.estimatedMeteredCostCents ?? 0;
  const estimatedEvents = totals?.estimatedMeteredEventCount ?? 0;
  const unpricedTokens = unavailableMeteredTokens(totals);
  const unpricedEvents = totals?.unavailableMeteredEventCount ?? 0;

  if (compact) {
    return (
      <div className={cn("text-xs leading-5 text-amber-700 dark:text-amber-300", className)}>
        {formatCostProvenanceSummary(totals)}
      </div>
    );
  }

  return (
    <div className={cn("border border-amber-300/70 bg-amber-50/60 px-3 py-2 text-xs leading-5 text-amber-900 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-200", className)}>
      {estimatedCost > 0 || estimatedEvents > 0 ? (
        <div>
          {estimatedCost > 0 ? `${formatCents(estimatedCost)} is estimated metered API spend` : "Metered API spend is estimated"}
          {estimatedEvents > 0 ? ` across ${estimatedEvents} event${estimatedEvents === 1 ? "" : "s"}` : ""}.
        </div>
      ) : null}
      {unpricedTokens > 0 || unpricedEvents > 0 ? (
        <div>
          {unpricedTokens > 0 ? `${formatTokens(unpricedTokens)} tokens` : `${unpricedEvents} event${unpricedEvents === 1 ? "" : "s"}`} of metered API usage are unpriced and not included in spend.
        </div>
      ) : null}
    </div>
  );
}
