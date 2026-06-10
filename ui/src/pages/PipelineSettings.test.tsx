// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import type { CompanyUserDirectoryResponse } from "../api/access";
import type { Pipeline } from "../api/pipelines";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { pipelinesApi } from "../api/pipelines";
import { PipelineSettings } from "./PipelineSettings";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({ pipelineId: "pipeline-1" }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makePipeline(): Pipeline {
  return {
    id: "pipeline-1",
    companyId: "company-1",
    name: "Content pipeline",
    description: "Publish useful work",
    status: "active",
    stages: [
      {
        id: "stage-1",
        pipelineId: "pipeline-1",
        name: "Intake",
        kind: "open",
        position: 0,
        config: {
          variables: [
            {
              key: "customer",
              label: "Customer",
              type: "text",
              options: [],
              required: true,
              showInAddForm: true,
            },
          ],
          approval: { required: false, approverType: "any_human", approverId: null },
          disable: { newEntries: false, reason: null },
          whatHappensHere: "Collect requests.",
        },
      },
      {
        id: "stage-2",
        pipelineId: "pipeline-1",
        name: "Review",
        kind: "review",
        position: 1,
        config: { variables: [] },
      },
    ],
    transitions: [{ fromStageId: "stage-1", toStageId: "stage-2", config: {} }],
    guidanceDocuments: [{ id: "guidance-1", pipelineId: "pipeline-1", key: "plain-language", title: "Pipeline guidance", body: "Be clear." }],
  };
}

function renderSettings() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PipelineSettings />
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

describe("PipelineSettings", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.spyOn(pipelinesApi, "get").mockResolvedValue(makePipeline());
    vi.spyOn(pipelinesApi, "updateStage").mockResolvedValue(makePipeline().stages![0]!);
    vi.spyOn(pipelinesApi, "setTransitions").mockResolvedValue({ transitions: [] });
    vi.spyOn(pipelinesApi, "createStage").mockResolvedValue({
      id: "stage-3",
      pipelineId: "pipeline-1",
      name: "New stage",
      kind: "working",
      position: 1,
      config: { variables: [] },
    });
    vi.spyOn(pipelinesApi, "upsertGuidanceDocument").mockResolvedValue({
      id: "guidance-1",
      pipelineId: "pipeline-1",
      key: "plain-language",
      title: "Pipeline guidance",
      body: "Updated.",
    });
    vi.spyOn(pipelinesApi, "remove").mockResolvedValue(makePipeline());
    vi.spyOn(agentsApi, "list").mockResolvedValue([
      { id: "agent-1", name: "QA Agent", role: "QA", status: "active" } as unknown as Agent,
    ]);
    vi.spyOn(accessApi, "listUserDirectory").mockResolvedValue({
      users: [
        {
          principalId: "user-1",
          status: "active",
          user: { id: "user-1", name: "Ada Human", email: "ada@example.com", image: null },
        },
      ],
    } satisfies CompanyUserDirectoryResponse);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders only Stages, Guidance, and Advanced top-level tabs", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    const tabLabels = Array.from(container.querySelectorAll("[data-tab-value]")).map((tab) => tab.textContent);
    expect(tabLabels).toEqual(["Stages", "Guidance", "Advanced"]);
    expect(container.textContent).not.toContain("Automation");

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("renders selected stage sections in the required order", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    const expected = [
      "Basics",
      "Disable",
      "Approval",
      "What happens here",
      "Routine variables",
      "Connections",
      "Advanced identifiers",
    ];
    const headings = Array.from(container.querySelectorAll("h2"))
      .map((heading) => heading.textContent ?? "")
      .filter((heading) => expected.includes(heading));
    expect(headings).toEqual(expected);

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("hides the approval picker until approval is required", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    expect(container.querySelector('[aria-label="Approval picker"]')).toBeNull();
    const switches = Array.from(container.querySelectorAll('[role="switch"]')) as HTMLButtonElement[];
    expect(switches.length).toBeGreaterThanOrEqual(2);

    flushSync(() => {
      switches[1]!.click();
    });

    const picker = container.querySelector<HTMLSelectElement>('[aria-label="Approval picker"]');
    expect(picker).not.toBeNull();
    const options = Array.from(picker!.querySelectorAll("option")).map((option) => option.textContent);
    expect(options).toContain("Any human");
    expect(options).toContain("Ada Human");
    expect(options).toContain("QA Agent");

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("gates permanent delete behind the pipeline name", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    const advancedTab = container.querySelector<HTMLButtonElement>('[data-tab-value="advanced"]')!;
    flushSync(() => {
      advancedTab.click();
    });

    const deleteButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Delete permanently"),
    ) as HTMLButtonElement | undefined;
    expect(deleteButton?.disabled).toBe(true);

    const input = container.querySelector<HTMLInputElement>("input")!;
    flushSync(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input, "Content pipeline");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(deleteButton?.disabled).toBe(false);

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });
});
