// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCostProvenanceSummary, hasCostProvenanceWarning } from "../components/CostProvenanceNotice";
import { Costs } from "./Costs";

const mockCostsApi = vi.hoisted(() => ({
  summary: vi.fn(),
  byAgent: vi.fn(),
  byProject: vi.fn(),
  byAgentModel: vi.fn(),
  byProvider: vi.fn(),
  byBiller: vi.fn(),
  financeSummary: vi.fn(),
  financeByBiller: vi.fn(),
  financeByKind: vi.fn(),
  financeEvents: vi.fn(),
  windowSpend: vi.fn(),
  quotaWindows: vi.fn(),
}));

const mockBudgetsApi = vi.hoisted(() => ({
  overview: vi.fn(),
  upsertPolicy: vi.fn(),
  resolveIncident: vi.fn(),
}));

vi.mock("../api/costs", () => ({
  costsApi: mockCostsApi,
}));

vi.mock("../api/budgets", () => ({
  budgetsApi: mockBudgetsApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../hooks/useDateRange", () => ({
  PRESET_KEYS: ["mtd"],
  PRESET_LABELS: { mtd: "MTD" },
  useDateRange: () => ({
    preset: "mtd",
    setPreset: vi.fn(),
    customFrom: "",
    setCustomFrom: vi.fn(),
    customTo: "",
    setCustomTo: vi.fn(),
    from: "2026-05-01T00:00:00.000Z",
    to: "2026-05-31T23:59:59.999Z",
    customReady: true,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const provenance = {
  estimatedMeteredCostCents: 250,
  estimatedMeteredInputTokens: 100,
  estimatedMeteredCachedInputTokens: 10,
  estimatedMeteredOutputTokens: 20,
  estimatedMeteredEventCount: 1,
  unavailableMeteredInputTokens: 1_000,
  unavailableMeteredCachedInputTokens: 100,
  unavailableMeteredOutputTokens: 200,
  unavailableMeteredEventCount: 1,
};

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Costs", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    mockBudgetsApi.overview.mockResolvedValue({
      companyId: "company-1",
      policies: [],
      activeIncidents: [],
      pausedAgentCount: 0,
      pausedProjectCount: 0,
      pendingApprovalCount: 0,
    });
    mockCostsApi.summary.mockResolvedValue({
      companyId: "company-1",
      spendCents: 250,
      budgetCents: 0,
      utilizationPercent: 0,
      ...provenance,
    });
    mockCostsApi.byAgent.mockResolvedValue([
      {
        agentId: "agent-1",
        agentName: "CodexCoder",
        agentStatus: "active",
        costCents: 250,
        inputTokens: 1_100,
        cachedInputTokens: 110,
        outputTokens: 220,
        apiRunCount: 2,
        subscriptionRunCount: 0,
        subscriptionCachedInputTokens: 0,
        subscriptionInputTokens: 0,
        subscriptionOutputTokens: 0,
        ...provenance,
      },
    ]);
    mockCostsApi.byProject.mockResolvedValue([]);
    mockCostsApi.byAgentModel.mockResolvedValue([
      {
        agentId: "agent-1",
        agentName: "CodexCoder",
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5.5",
        costCents: 250,
        inputTokens: 1_100,
        cachedInputTokens: 110,
        outputTokens: 220,
        ...provenance,
      },
    ]);
    mockCostsApi.financeSummary.mockResolvedValue({
      debitCents: 0,
      creditCents: 0,
      netCents: 0,
      estimatedDebitCents: 0,
      eventCount: 0,
    });
    mockCostsApi.financeByBiller.mockResolvedValue([]);
    mockCostsApi.financeByKind.mockResolvedValue([]);
    mockCostsApi.financeEvents.mockResolvedValue([]);
    mockCostsApi.byProvider.mockResolvedValue([]);
    mockCostsApi.byBiller.mockResolvedValue([]);
    mockCostsApi.windowSpend.mockResolvedValue([]);
    mockCostsApi.quotaWindows.mockResolvedValue([]);
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("warns when metered API spend is estimated or unpriced", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Costs />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("$2.50 is estimated metered API spend");
    expect(container.textContent).toContain("1.3k tokens of metered API usage are unpriced");
    expect(container.textContent).toContain("$2.50 estimated metered API");
    expect(container.textContent).toContain("1.3k unpriced metered API");
  });

  it("warns for estimated metered events even when spend rounds to zero cents", () => {
    const zeroCentEstimated = {
      estimatedMeteredCostCents: 0,
      estimatedMeteredInputTokens: 1,
      estimatedMeteredCachedInputTokens: 0,
      estimatedMeteredOutputTokens: 1,
      estimatedMeteredEventCount: 1,
    };

    expect(hasCostProvenanceWarning(zeroCentEstimated)).toBe(true);
    expect(formatCostProvenanceSummary(zeroCentEstimated)).toBe("1 estimated metered API event");
  });
});
