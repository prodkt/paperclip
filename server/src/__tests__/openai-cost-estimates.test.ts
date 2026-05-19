import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCostProvenance } from "../services/openai-cost-estimates.ts";

describe("resolveCostProvenance", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps provider-reported costs as reported", () => {
    expect(
      resolveCostProvenance({
        provider: "openai",
        biller: "openai",
        model: "gpt-5.5",
        billingType: "metered_api",
        costUsd: 1.23,
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
        costSource: "reported",
        costMetadata: { providerCostField: "total_cost_usd" },
      }),
    ).toEqual({
      costUsd: 1.23,
      costSource: "reported",
      costMetadata: {
        providerCostField: "total_cost_usd",
        costUsd: 1.23,
      },
    });
  });

  it("keeps provider-reported zero costs as reported", () => {
    expect(
      resolveCostProvenance({
        provider: "openai",
        biller: "openai",
        model: "gpt-5.5",
        billingType: "metered_api",
        costUsd: 0,
        usage: { inputTokens: 1_000_000, outputTokens: 10_000, cachedInputTokens: 0 },
        costSource: "reported",
      }),
    ).toEqual({
      costUsd: 0,
      costSource: "reported",
      costMetadata: {
        costUsd: 0,
      },
    });
  });

  it("estimates direct OpenAI metered API cost from the maintained rate table", () => {
    const resolved = resolveCostProvenance({
      provider: "openai",
      biller: "openai",
      model: "gpt-5.5",
      billingType: "metered_api",
      costUsd: null,
      usage: {
        inputTokens: 1_000_000,
        cachedInputTokens: 100_000,
        outputTokens: 10_000,
        reasoningOutputTokens: 5_000,
      },
    });

    expect(resolved.costSource).toBe("estimated");
    expect(resolved.costUsd).toBeCloseTo(5, 6);
    expect(resolved.costMetadata).toMatchObject({
      estimator: "openai_model_rate_table",
      inputUsdPerMillion: 5,
      cachedInputUsdPerMillion: 0.5,
      outputUsdPerMillion: 30,
      reasoningOutputTokens: 5_000,
    });
  });

  it("uses configured model rates for unknown OpenAI models", () => {
    vi.stubEnv(
      "PAPERCLIP_OPENAI_MODEL_RATES_JSON",
      JSON.stringify({
        "gpt-test-codex": {
          inputUsdPerMillion: 2,
          cachedInputUsdPerMillion: 0.2,
          outputUsdPerMillion: 10,
          source: "test-rate-card",
        },
      }),
    );

    const resolved = resolveCostProvenance({
      provider: "openai",
      biller: "openai",
      model: "gpt-test-codex",
      billingType: "metered_api",
      costUsd: null,
      usage: { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000 },
    });

    expect(resolved.costSource).toBe("estimated");
    expect(resolved.costUsd).toBeCloseTo(2.1, 6);
    expect(resolved.costMetadata.rateSource).toBe("test-rate-card");
  });

  it("refreshes the configured model rate cache when the env changes in-process", () => {
    vi.stubEnv(
      "PAPERCLIP_OPENAI_MODEL_RATES_JSON",
      JSON.stringify({
        "gpt-cache-test": {
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 1,
          source: "first-rate-card",
        },
      }),
    );

    expect(
      resolveCostProvenance({
        provider: "openai",
        biller: "openai",
        model: "gpt-cache-test",
        billingType: "metered_api",
        costUsd: null,
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
      }).costMetadata.rateSource,
    ).toBe("first-rate-card");

    vi.stubEnv(
      "PAPERCLIP_OPENAI_MODEL_RATES_JSON",
      JSON.stringify({
        "gpt-cache-test": {
          inputUsdPerMillion: 2,
          outputUsdPerMillion: 1,
          source: "second-rate-card",
        },
      }),
    );

    const resolved = resolveCostProvenance({
      provider: "openai",
      biller: "openai",
      model: "gpt-cache-test",
      billingType: "metered_api",
      costUsd: null,
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    });

    expect(resolved.costUsd).toBe(2);
    expect(resolved.costMetadata.rateSource).toBe("second-rate-card");
  });

  it("marks unpriced metered usage unavailable when no reported cost or rate exists", () => {
    expect(
      resolveCostProvenance({
        provider: "openai",
        biller: "openai",
        model: "gpt-unknown-future",
        billingType: "metered_api",
        costUsd: null,
        usage: { inputTokens: 10_000, outputTokens: 1_000 },
      }),
    ).toMatchObject({
      costUsd: null,
      costSource: "unavailable",
      costMetadata: { reason: "no_reported_cost_or_configured_rate" },
    });
  });
});
