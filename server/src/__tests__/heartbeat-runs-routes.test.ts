// PRO-43: heartbeat-runs cross-tenant 404-leak regression tests.
// Background: the per-id heartbeat-run routes used to distinguish "run exists in
// another company" (403 Forbidden) from "run does not exist" (404 Not Found).
// Status-code and body-shape differences let an attacker enumerate run IDs across
// companies. The fix wraps the post-read `assertCompanyAccess` call in
// `assertCompanyAccessOrNotFound`, which rewrites the 403 into the canonical
// 404 "Heartbeat run not found" body. Scoped routes assert on the URL companyId
// before reading the DB and likewise return the same canonical body.
//
// This file locks the post-fix behavior in for every heartbeat-run route shape:
// six URL shapes (4 unscoped, 1 scoped GET, 1 scoped cancel) plus the watchdog
// POST, exercising both reads and writes. Each case asserts that:
//   - status === 404
//   - body.error === "Heartbeat run not found"
//   - the exact bytes match what a request for a non-existent UUID returns
//   - the destructive downstream side-effects (cancelRun, recordWatchdogDecision,
//     listEvents, readLog, listForRun, etc.) were NOT invoked.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");

const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownCompanyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const nonexistentRunId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const NOT_FOUND_BODY = { error: "Heartbeat run not found" };

const ownCompanyRun = {
  id: runId,
  companyId: ownCompanyId,
  agentId: "agent-own",
  status: "running",
  startedAt: new Date("2026-06-29T00:00:00.000Z"),
  finishedAt: null,
  createdAt: new Date("2026-06-29T00:00:00.000Z"),
  updatedAt: new Date("2026-06-29T00:00:00.000Z"),
  contextSnapshot: {},
} as const;

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
  getRunLogAccess: vi.fn(),
  cancelRun: vi.fn(),
  listEvents: vi.fn(),
  readLog: vi.fn(),
  buildRunOutputSilence: vi.fn(),
  getRetryExhaustedReason: vi.fn(),
  list: vi.fn(),
  listForRunLog: vi.fn(),
  listActiveForCompany: vi.fn(),
  recordRunStarted: vi.fn(),
  recordOutput: vi.fn(),
  recordEvent: vi.fn(),
  listTaskSessions: vi.fn(),
  getActiveRunIssueSummaryForAgent: vi.fn(),
  getRunIssueSummary: vi.fn(),
  getRuntimeState: vi.fn(),
  cancelActiveForAgent: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForRun: vi.fn(),
  getById: vi.fn(),
  readLog: vi.fn(),
}));

const mockRecoveryService = vi.hoisted(() => ({
  recordWatchdogDecision: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => true),
  decide: vi.fn(async () => ({
    allowed: true,
    action: "test",
    reason: "allow_explicit_grant",
    explanation: "Allowed by test.",
  })),
  hasPermission: vi.fn(async () => true),
  getMembership: vi.fn(async () => null),
  ensureMembership: vi.fn(async () => undefined),
  listPrincipalGrants: vi.fn(async () => []),
  setPrincipalPermission: vi.fn(async () => undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockGetTelemetryClient = vi.hoisted(() => vi.fn(() => ({ track: vi.fn() })));

vi.mock("@paperclipai/shared/telemetry", () => ({ trackAgentCreated: vi.fn(), trackErrorHandlerCrash: vi.fn() }));

vi.mock("../telemetry.js", () => ({ getTelemetryClient: mockGetTelemetryClient }));

vi.mock("../services/index.js", () => ({
  agentService: () => ({ getById: vi.fn(), pause: vi.fn(), resume: vi.fn() }),
  agentInstructionsService: () => ({ materializeManagedBundle: vi.fn() }),
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn(), resolveRequestedSkillKeys: vi.fn() }),
  budgetService: () => ({ upsertPolicy: vi.fn() }),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => mockRecoveryService,
  issueService: () => ({ list: vi.fn(), getById: vi.fn(), getByIdentifier: vi.fn() }),
  logActivity: mockLogActivity,
  secretService: () => ({ normalizeAdapterConfigForPersistence: vi.fn(), resolveAdapterConfigForRuntime: vi.fn() }),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent: unknown, config: unknown) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

let routeModules:
  | Promise<[
    typeof import("../middleware/index.js"),
    typeof import("../routes/agents.js"),
  ]>
  | null = null;

async function loadRouteModules() {
  routeModules ??= Promise.all([
    import("../middleware/index.js"),
    import("../routes/agents.js"),
  ]);
  return routeModules;
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { agentRoutes }] = await loadRouteModules();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

function resetMocks() {
  vi.clearAllMocks();
  for (const mock of Object.values(mockHeartbeatService)) mock.mockReset();
  for (const mock of Object.values(mockWorkspaceOperationService)) mock.mockReset();
  for (const mock of Object.values(mockRecoveryService)) mock.mockReset();
  for (const mock of Object.values(mockAccessService)) mock.mockReset();
  mockLogActivity.mockReset();
  mockLogActivity.mockImplementation(async () => undefined);
  mockGetTelemetryClient.mockReset();
  mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });

  // Existence checks: own-company run exists; non-existent UUID does not.
  mockHeartbeatService.getRun.mockImplementation(async (id: string) => {
    if (id === runId) return { ...ownCompanyRun };
    return null;
  });
  mockHeartbeatService.getRunLogAccess.mockImplementation(async (id: string) => {
    if (id === runId) return { ...ownCompanyRun };
    return null;
  });
  mockHeartbeatService.buildRunOutputSilence.mockImplementation(async () => ({}));
  mockHeartbeatService.getRetryExhaustedReason.mockImplementation(async () => null);
  mockHeartbeatService.listEvents.mockImplementation(async () => []);
  mockHeartbeatService.readLog.mockImplementation(async () => ({ chunks: [], nextOffset: 0 }));
  mockHeartbeatService.cancelRun.mockImplementation(async (id: string) => ({ ...ownCompanyRun, id, status: "cancelled" }));

  mockWorkspaceOperationService.listForRun.mockImplementation(async () => []);
  mockWorkspaceOperationService.readLog.mockImplementation(async () => ({ chunks: [], nextOffset: 0 }));

  mockRecoveryService.recordWatchdogDecision.mockImplementation(async (input: { runId: string }) => ({
    id: "wd-1",
    runId: input.runId,
    decision: "continue",
    createdAt: new Date("2026-06-29T00:00:00.000Z"),
  }));
}

// 30s because vitest's first import of routes/agents.ts triggers transpilation
// of a 3948-line module pulling in many services; subsequent tests share the
// cached module via the routeModules singleton.
describe.sequential("heartbeat-runs routes cross-tenant 404 leak", () => {
  // First test in the file pays the transpile cost when routeModules is
  // populated, so give every test in this describe a generous per-test budget.
  const FIRST_TEST_TIMEOUT_MS = 30_000;
  beforeEach(() => {
    resetMocks();
  });

  // --- Unscoped GET handlers (post-read auth via assertCompanyAccessOrNotFound) ---

  it("GET /heartbeat-runs/:runId: cross-company actor gets the canonical 404 body", { timeout: FIRST_TEST_TIMEOUT_MS }, async () => {
    // Actor belongs to a different company than the run. Returns the same body
    // as a non-existent UUID so an attacker cannot enumerate run IDs.
    const app = await createApp({
      type: "board",
      userId: "mallory",
      companyIds: [otherCompanyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const crossRes = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/heartbeat-runs/${runId}`));
    expect(crossRes.status).toBe(404);
    expect(crossRes.body).toEqual(NOT_FOUND_BODY);
    // `cancelRun`, `listEvents`, etc. were never reached.
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("GET /heartbeat-runs/:runId: non-existent UUID returns the same canonical 404 body", { timeout: FIRST_TEST_TIMEOUT_MS }, async () => {
    // The reference response that cross-company must match byte-for-byte.
    const app = await createApp({
      type: "board",
      userId: "mallory",
      companyIds: [otherCompanyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const notFoundRes = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/heartbeat-runs/${nonexistentRunId}`));
    expect(notFoundRes.status).toBe(404);
    expect(notFoundRes.body).toEqual(NOT_FOUND_BODY);
  });

  it("GET /heartbeat-runs/:runId: same-company actor can read the run", async () => {
    const app = await createApp({
      type: "board",
      userId: "alice",
      companyIds: [ownCompanyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/heartbeat-runs/${runId}`));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(runId);
    expect(res.body.companyId).toBe(ownCompanyId);
  });

  it("GET /heartbeat-runs/:runId/events: cross-company actor gets canonical 404 and events are not listed", async () => {
    const app = await createApp({
      type: "board",
      userId: "mallory",
      companyIds: [otherCompanyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/heartbeat-runs/${runId}/events`));
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND_BODY);
    expect(mockHeartbeatService.listEvents).not.toHaveBeenCalled();
  });

  it("GET /heartbeat-runs/:runId/log: cross-company actor gets canonical 404 and log is not read", async () => {
    const app = await createApp({
      type: "board",
      userId: "mallory",
      companyIds: [otherCompanyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/heartbeat-runs/${runId}/log`));
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND_BODY);
    expect(mockHeartbeatService.readLog).not.toHaveBeenCalled();
  });

  it("GET /heartbeat-runs/:runId/workspace-operations: cross-company actor gets canonical 404", async () => {
    const app = await createApp({
      type: "board",
      userId: "mallory",
      companyIds: [otherCompanyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/heartbeat-runs/${runId}/workspace-operations`),
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND_BODY);
    expect(mockWorkspaceOperationService.listForRun).not.toHaveBeenCalled();
  });

  it("POST /heartbeat-runs/:runId/cancel: cross-company board actor gets canonical 404 and cancel is not called", async () => {
    const app = await createApp({
      type: "board",
      userId: "mallory",
      companyIds: [otherCompanyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).post(`/api/heartbeat-runs/${runId}/cancel`).send({}));
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND_BODY);
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("POST /heartbeat-runs/:runId/watchdog-decisions: cross-company board actor gets canonical 404", async () => {
    const app = await createApp({
      type: "board",
      userId: "mallory",
      companyIds: [otherCompanyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/heartbeat-runs/${runId}/watchdog-decisions`)
        .send({ decision: "continue", reason: "test" }),
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND_BODY);
    expect(mockRecoveryService.recordWatchdogDecision).not.toHaveBeenCalled();
  });

  // --- Scoped GET (URL companyId assertion before DB read) ---

  it("GET /companies/:otherCo/heartbeat-runs/:runId: scoped cross-company actor gets canonical 404", async () => {
    const app = await createApp({
      type: "board",
      userId: "mallory",
      companyIds: [otherCompanyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${otherCompanyId}/heartbeat-runs/${runId}`),
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND_BODY);
    // Scoped route asserts on URL companyId FIRST, then DB-reads the run only
    // after the actor is authorised. A cross-company probe reaches the read but
    // bumps `run.companyId !== companyId`, so the response is canonical 404.
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith(runId);
  });

  it("POST /companies/:otherCo/heartbeat-runs/:runId/cancel: scoped cross-company actor cannot cancel", async () => {
    const app = await createApp({
      type: "board",
      userId: "mallory",
      companyIds: [otherCompanyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/companies/${otherCompanyId}/heartbeat-runs/${runId}/cancel`).send({}),
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND_BODY);
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  // --- 401 (unauthenticated) is NOT rewritten: callers still see a clear auth error. ---

  it("GET /heartbeat-runs/:runId: unauthenticated call is rejected with 401 (not flattened to 404)", async () => {
    // The 404-rewrite only catches 403 from a logged-in cross-company actor.
    // A fully unauthenticated probe must still see 401 so clients can react.
    const app = await createApp({ type: "none" });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/heartbeat-runs/${runId}`));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });
});
