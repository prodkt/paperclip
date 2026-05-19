import type { AdapterBillingType, AdapterExecutionResult, UsageSummary } from "@paperclipai/adapter-utils";
import type { BillingType } from "@paperclipai/shared";

type CostSource = "reported" | "estimated" | "unavailable";

type Rate = {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number | null;
  outputUsdPerMillion: number;
  source: string;
};

export type ResolvedCostProvenance = {
  costUsd: number | null;
  costSource: CostSource;
  costMetadata: Record<string, unknown>;
};

const DEFAULT_OPENAI_MODEL_RATES: Record<string, Rate> = {
  "gpt-5.5": { inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 30, source: "openai_api_pricing_2026-05-19" },
  "gpt-5.5-pro": { inputUsdPerMillion: 30, cachedInputUsdPerMillion: null, outputUsdPerMillion: 180, source: "openai_api_pricing_2026-05-19" },
  "gpt-5.4": { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15, source: "openai_api_pricing_2026-05-19" },
  "gpt-5.4-mini": { inputUsdPerMillion: 0.75, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 4.5, source: "openai_api_pricing_2026-05-19" },
  "gpt-5.4-nano": { inputUsdPerMillion: 0.2, cachedInputUsdPerMillion: 0.02, outputUsdPerMillion: 1.25, source: "openai_api_pricing_2026-05-19" },
  "gpt-5.4-pro": { inputUsdPerMillion: 30, cachedInputUsdPerMillion: null, outputUsdPerMillion: 180, source: "openai_api_pricing_2026-05-19" },
  "gpt-5.3-codex": { inputUsdPerMillion: 1.75, cachedInputUsdPerMillion: 0.175, outputUsdPerMillion: 14, source: "openai_api_pricing_2026-05-19" },
  "gpt-5.2-codex": { inputUsdPerMillion: 1.75, cachedInputUsdPerMillion: 0.175, outputUsdPerMillion: 14, source: "openai_api_pricing_2026-05-19" },
  "gpt-5.2": { inputUsdPerMillion: 1.75, cachedInputUsdPerMillion: 0.175, outputUsdPerMillion: 14, source: "openai_api_pricing_2026-05-19" },
};

let configuredRatesCacheRaw: string | undefined;
let configuredRatesCache: Record<string, Rate> | null = null;

function readConfiguredOpenAiRates(): Record<string, Rate> {
  const raw = process.env.PAPERCLIP_OPENAI_MODEL_RATES_JSON;
  if (configuredRatesCache !== null && configuredRatesCacheRaw === raw) {
    return configuredRatesCache;
  }

  configuredRatesCacheRaw = raw;
  if (!raw?.trim()) {
    configuredRatesCache = {};
    return configuredRatesCache;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rates: Record<string, Rate> = {};
    for (const [model, value] of Object.entries(parsed)) {
      if (!model.trim() || typeof value !== "object" || value == null || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const input = Number(record.inputUsdPerMillion ?? record.input);
      const cachedRaw = record.cachedInputUsdPerMillion ?? record.cachedInput ?? record.cached;
      const cached = cachedRaw == null ? null : Number(cachedRaw);
      const output = Number(record.outputUsdPerMillion ?? record.output);
      if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) continue;
      if (cached != null && (!Number.isFinite(cached) || cached < 0)) continue;
      rates[model.trim().toLowerCase()] = {
        inputUsdPerMillion: input,
        cachedInputUsdPerMillion: cached,
        outputUsdPerMillion: output,
        source: typeof record.source === "string" && record.source.trim() ? record.source.trim() : "env:PAPERCLIP_OPENAI_MODEL_RATES_JSON",
      };
    }
    configuredRatesCache = rates;
    return configuredRatesCache;
  } catch {
    configuredRatesCache = {};
    return configuredRatesCache;
  }
}

function normalizeModelId(model: string | null | undefined): string | null {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return null;
  return normalized.replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

function lookupOpenAiRate(model: string | null | undefined): Rate | null {
  const normalized = normalizeModelId(model);
  if (!normalized) return null;
  const configured = readConfiguredOpenAiRates();
  return configured[normalized] ?? DEFAULT_OPENAI_MODEL_RATES[normalized] ?? null;
}

function normalizeBillingType(value: AdapterBillingType | BillingType | null | undefined): BillingType {
  switch (value) {
    case "api":
    case "metered_api":
      return "metered_api";
    case "subscription":
    case "subscription_included":
      return "subscription_included";
    case "subscription_overage":
      return "subscription_overage";
    case "credits":
      return "credits";
    case "fixed":
      return "fixed";
    default:
      return "unknown";
  }
}

function hasUsage(usage: UsageSummary | null | undefined): usage is UsageSummary {
  return !!usage && (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    (usage.cachedInputTokens ?? 0) > 0 ||
    (usage.reasoningOutputTokens ?? 0) > 0
  );
}

function estimateOpenAiCostUsd(model: string, usage: UsageSummary): { costUsd: number; rate: Rate } | null {
  const rate = lookupOpenAiRate(model);
  if (!rate) return null;

  const cachedInputTokens = Math.max(0, Math.floor(usage.cachedInputTokens ?? 0));
  const uncachedInputTokens = Math.max(0, Math.floor(usage.inputTokens) - cachedInputTokens);
  const cachedInputRate = rate.cachedInputUsdPerMillion ?? rate.inputUsdPerMillion;
  const outputTokens = Math.max(0, Math.floor(usage.outputTokens) + Math.floor(usage.reasoningOutputTokens ?? 0));
  const costUsd =
    (uncachedInputTokens * rate.inputUsdPerMillion / 1_000_000) +
    (cachedInputTokens * cachedInputRate / 1_000_000) +
    (outputTokens * rate.outputUsdPerMillion / 1_000_000);

  return { costUsd, rate };
}

export function resolveCostProvenance(result: Pick<
  AdapterExecutionResult,
  "provider" | "biller" | "model" | "billingType" | "costUsd" | "costSource" | "costMetadata" | "usage"
>): ResolvedCostProvenance {
  if (typeof result.costUsd === "number" && Number.isFinite(result.costUsd) && result.costUsd >= 0) {
    return {
      costUsd: result.costUsd,
      costSource: result.costSource === "estimated" ? "estimated" : "reported",
      costMetadata: {
        ...(result.costMetadata ?? {}),
        costUsd: result.costUsd,
      },
    };
  }

  const provider = result.provider?.trim().toLowerCase();
  const biller = result.biller?.trim().toLowerCase();
  const billingType = normalizeBillingType(result.billingType);
  const model = result.model?.trim();
  if (provider === "openai" && biller === "openai" && billingType === "metered_api" && model && hasUsage(result.usage)) {
    const estimated = estimateOpenAiCostUsd(model, result.usage);
    if (estimated && estimated.costUsd > 0) {
      return {
        costUsd: estimated.costUsd,
        costSource: "estimated",
        costMetadata: {
          ...(result.costMetadata ?? {}),
          estimator: "openai_model_rate_table",
          rateSource: estimated.rate.source,
          inputUsdPerMillion: estimated.rate.inputUsdPerMillion,
          cachedInputUsdPerMillion: estimated.rate.cachedInputUsdPerMillion,
          outputUsdPerMillion: estimated.rate.outputUsdPerMillion,
          reasoningOutputTokens: result.usage.reasoningOutputTokens ?? 0,
        },
      };
    }
  }

  return {
    costUsd: null,
    costSource: "unavailable",
    costMetadata: {
      ...(result.costMetadata ?? {}),
      reason: hasUsage(result.usage) ? "no_reported_cost_or_configured_rate" : "no_token_usage",
    },
  };
}
