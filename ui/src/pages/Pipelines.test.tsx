// @vitest-environment jsdom

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pipeline, PipelineAttentionItem, PipelineCase } from "../api/pipelines";
import { pipelinesApi } from "../api/pipelines";
import { buildReviewQueueRows, PipelinesIndexTable, ReviewQueueStub } from "./Pipelines";

const mockCompany = vi.hoisted(() => ({ selectedCompanyId: "company-1" as string | null }));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: mockCompany.selectedCompanyId }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makePipeline(overrides: Partial<Pipeline>): Pipeline {
  return {
    id: "pipeline-1",
    companyId: "company-1",
    name: "Pipeline",
    description: null,
    status: "active",
    attentionCount: 0,
    inMotionCount: 0,
    openItemCount: 0,
    lastActivityAt: null,
    ...overrides,
  };
}

function connectedPipelines() {
  return [
    makePipeline({
      id: "release",
      name: "Release",
      description: "the launch this work is building toward",
      openItemCount: 1,
      connections: {},
    }),
    makePipeline({
      id: "features",
      name: "Features",
      attentionCount: 1,
      openItemCount: 4,
      connections: { feedsIntoPipelineId: "release" },
    }),
    makePipeline({
      id: "content",
      name: "Content production",
      attentionCount: 2,
      inMotionCount: 3,
      openItemCount: 7,
      connections: { feedsIntoPipelineId: "features" },
    }),
  ];
}

function renderTable({
  pipelines,
  connectionsAvailable,
  search = "",
}: {
  pipelines: Pipeline[];
  connectionsAvailable: boolean;
  search?: string;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness() {
    const [viewMode, setViewMode] = useState<"nested" | "flat">("nested");
    const [query, setQuery] = useState(search);

    return (
      <PipelinesIndexTable
        pipelines={pipelines}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        connectionsAvailable={connectionsAvailable}
        search={query}
        onSearchChange={setQuery}
      />
    );
  }

  flushSync(() => {
    root.render(<Harness />);
  });

  return { container, root };
}

describe("PipelinesIndexTable", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("nests connected pipelines under the work they feed", () => {
    const { container, root } = renderTable({
      pipelines: connectedPipelines(),
      connectionsAvailable: true,
    });

    const content = container.textContent ?? "";
    expect(content.indexOf("Release")).toBeLessThan(content.indexOf("Features"));
    expect(content.indexOf("Features")).toBeLessThan(content.indexOf("Content production"));
    expect(content).toContain("feeds into Release");
    expect(content).toContain("feeds into Features");

    const collapse = container.querySelector<HTMLButtonElement>('button[aria-label="Collapse Release"]');
    expect(collapse).not.toBeNull();

    flushSync(() => {
      root.unmount();
    });
  });

  it("switches between nested and flat views when connection data exists", () => {
    const { container, root } = renderTable({
      pipelines: connectedPipelines(),
      connectionsAvailable: true,
    });

    expect(container.textContent).toContain("feeds into Release");

    const flatButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Flat list"),
    );
    expect(flatButton).toBeTruthy();

    flushSync(() => {
      flatButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).not.toContain("feeds into Release");
    expect(container.textContent).not.toContain("feeds into Features");

    flushSync(() => {
      root.unmount();
    });
  });

  it("disables the nested toggle until the connections field lands", () => {
    const { container, root } = renderTable({
      pipelines: [
        makePipeline({ id: "support", name: "Support knowledge base" }),
        makePipeline({ id: "sales", name: "Sales decks" }),
      ],
      connectionsAvailable: false,
    });

    const nestedButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Nested"),
    ) as HTMLButtonElement | undefined;
    expect(nestedButton?.disabled).toBe(true);
    expect(container.textContent).toContain("Support knowledge base");
    expect(container.textContent).toContain("Sales decks");

    flushSync(() => {
      root.unmount();
    });
  });

  it("renders attention and in-motion copy only when nonzero", () => {
    const { container, root } = renderTable({
      pipelines: [
        makePipeline({
          id: "hiring",
          name: "Hiring pipeline",
          attentionCount: 3,
          inMotionCount: 2,
          openItemCount: 18,
        }),
        makePipeline({
          id: "recap",
          name: "Quarterly board recap",
          attentionCount: 0,
          inMotionCount: 0,
          openItemCount: 0,
          status: "paused",
        }),
      ],
      connectionsAvailable: false,
    });

    const content = container.textContent ?? "";
    expect(content).toContain("3 to review");
    expect(content).toContain("2 in motion");
    expect(content).toContain("18 open");
    expect(content).toContain("Paused");
    expect(content).not.toContain("0 to review");
    expect(content).not.toContain("0 in motion");

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows an empty state when search filters out every pipeline", () => {
    const { container, root } = renderTable({
      pipelines: [makePipeline({ id: "press", name: "Press outreach" })],
      connectionsAvailable: false,
      search: "customer",
    });

    expect(container.textContent).toContain("No pipelines match your search.");

    flushSync(() => {
      root.unmount();
    });
  });
});

function makeCase(overrides: Partial<PipelineCase>): PipelineCase {
  return {
    id: "item-1",
    pipelineId: "pipeline-1",
    stageId: "stage-1",
    title: "Launch blog post",
    status: "open",
    fields: {},
    createdAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T10:00:00.000Z",
    lastActivityAt: "2026-06-10T10:00:00.000Z",
    ...overrides,
  };
}

function renderReviewQueue() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ReviewQueueStub />
      </QueryClientProvider>,
    );
  });

  return { container, root, queryClient };
}

async function flushQueries() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ReviewQueue", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mockCompany.selectedCompanyId = "company-1";
    vi.spyOn(pipelinesApi, "list").mockResolvedValue([
      makePipeline({ id: "pipeline-1", name: "Content production" }),
    ]);
    vi.spyOn(pipelinesApi, "listAttention").mockResolvedValue([]);
    vi.spyOn(pipelinesApi, "listReviewCases").mockResolvedValue([]);
    vi.spyOn(pipelinesApi, "reviewCase").mockResolvedValue(makeCase({ id: "review-1" }));
    vi.spyOn(pipelinesApi, "resolveSuggestion").mockResolvedValue(makeCase({ id: "suggestion-1" }));
    vi.spyOn(pipelinesApi, "bulkReviewCases").mockResolvedValue({ cases: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("groups attention and review rows into the daily triage sections", () => {
    const rows = buildReviewQueueRows({
      pipelines: [makePipeline({ id: "pipeline-1", name: "Content production" })],
      reviewCases: [makeCase({ id: "review-1", title: "Final launch post" })],
      attentionItems: [
        {
          id: "suggestion-1",
          pipelineId: "pipeline-1",
          caseId: "suggestion-1",
          kind: "suggestion",
          title: "Draft launch post",
          summary: "Drafting agent thinks Draft launch post is ready to move forward.",
          createdAt: "2026-06-10T11:00:00.000Z",
        } satisfies PipelineAttentionItem,
        {
          id: "heads-up-1",
          pipelineId: "pipeline-1",
          kind: "drift",
          title: "Launch tweet",
          summary: "Launch tweet changed upstream.",
          createdAt: "2026-06-10T09:00:00.000Z",
        } satisfies PipelineAttentionItem,
      ],
    });

    expect(rows.map((row) => row.kind)).toEqual(["suggestion", "review", "headsUp"]);
    expect(rows.find((row) => row.kind === "review")?.pipelineName).toBe("Content production");
    expect(rows.map((row) => row.prompt).join(" ")).not.toMatch(/\bcase\b/i);
  });

  it("approves a final-review row through the review endpoint", async () => {
    vi.mocked(pipelinesApi.listReviewCases).mockResolvedValue([
      makeCase({ id: "review-1", title: "Final launch post" }),
    ]);
    const { container, root, queryClient } = renderReviewQueue();

    await flushQueries();

    expect(container.textContent).toContain("Final calls");
    const approveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Approve",
    );
    expect(approveButton).toBeTruthy();

    approveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushQueries();

    expect(pipelinesApi.reviewCase).toHaveBeenCalledWith("review-1", {
      decision: "approve",
      note: null,
    });

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });
});
