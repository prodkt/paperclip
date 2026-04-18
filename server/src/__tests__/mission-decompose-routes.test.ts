import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { conflict } from "../errors.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(async () => ({ adoptedFromRunId: null })),
}));

const mockMissionService = vi.hoisted(() => ({
  decompose: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  agentService: () => ({}),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => ({}),
  instanceSettingsService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  missionService: () => mockMissionService,
  projectService: () => ({}),
  routineService: () => ({}),
  workProductService: () => ({}),
}));

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    title: "Mission issue",
    status: "in_progress",
    assigneeAgentId: agentId,
    createdByAgentId: agentId,
    identifier: "PAP-1541",
    ...overrides,
  };
}

function makeDecomposeResult(overrides: Record<string, unknown> = {}) {
  return {
    issueId,
    milestoneCount: 1,
    featureCount: 1,
    validationCount: 1,
    fixLoopCount: 0,
    createdIssueIds: ["44444444-4444-4444-8444-444444444444"],
    updatedIssueIds: [],
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("mission decompose route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockMissionService.decompose.mockResolvedValue(makeDecomposeResult());
  });

  it("rejects assigned agents that do not own the active checkout run", async () => {
    mockIssueService.assertCheckoutOwner.mockRejectedValueOnce(
      conflict("Issue run ownership conflict", {
        issueId,
        assigneeAgentId: agentId,
        checkoutRunId: "run-1",
        actorRunId: "run-2",
      }),
    );

    const res = await request(await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-2",
    })).post(`/api/issues/${issueId}/mission/decompose`).send({});

    expect(res.status).toBe(409);
    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(issueId, agentId, "run-2");
    expect(mockMissionService.decompose).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("allows the checkout-owning assigned agent to decompose the mission", async () => {
    const res = await request(await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
    })).post(`/api/issues/${issueId}/mission/decompose`).send({});

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(issueId, agentId, "run-1");
    expect(mockMissionService.decompose).toHaveBeenCalledWith(issueId, {
      actor: { agentId, userId: null },
      dryRun: false,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "mission.decomposed",
        companyId,
        actorType: "agent",
        actorId: agentId,
        entityType: "issue",
        entityId: issueId,
      }),
    );
    expect(res.body.createdIssueIds).toEqual(["44444444-4444-4444-8444-444444444444"]);
  });
});
