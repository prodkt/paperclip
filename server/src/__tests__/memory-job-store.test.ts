import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  memoryExtractionJobs,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
} from "./helpers/embedded-postgres.js";
import { startMemoryJobTestDatabase } from "./helpers/memory-job-test-db.ts";
import { memoryJobStore } from "../services/memory-job-store.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres memory job store tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function insertCompany(db: ReturnType<typeof createDb>, companyId: string) {
  await db.insert(companies).values({
    id: companyId,
    name: "Paperclip",
    issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
}

describeEmbeddedPostgres("memory job store", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startMemoryJobTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startMemoryJobTestDatabase("paperclip-memory-job-store-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(memoryExtractionJobs);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates rerun attempts against the original lineage without mutating prior attempts", async () => {
    const companyId = randomUUID();
    const store = memoryJobStore(db);
    await insertCompany(db, companyId);

    const original = await store.enqueue({
      companyId,
      bindingId: randomUUID(),
      bindingKey: "primary",
      operationType: "capture",
      sourceKind: "manual",
    });

    await store.cancel({
      companyId,
      jobId: original.id,
      now: new Date("2026-04-21T18:00:00.000Z"),
      resultSummary: "Cancelled by test",
    });

    const firstRetry = await store.rerun(companyId, original.id, {
      now: new Date("2026-04-21T18:01:00.000Z"),
    });

    await store.cancel({
      companyId,
      jobId: firstRetry.id,
      now: new Date("2026-04-21T18:02:00.000Z"),
      resultSummary: "Retry cancelled by test",
    });

    const secondRetry = await store.rerun(companyId, firstRetry.id, {
      now: new Date("2026-04-21T18:03:00.000Z"),
    });

    const originalDetail = await store.getDetail(companyId, original.id);
    const secondRetryDetail = await store.getDetail(companyId, secondRetry.id);

    expect(originalDetail).toMatchObject({
      id: original.id,
      status: "cancelled",
      attemptNumber: 1,
      retryCount: 2,
      rerunEligible: true,
    });
    expect(firstRetry).toMatchObject({
      retryOfJobId: original.id,
      attemptNumber: 2,
      status: "queued",
    });
    expect(secondRetryDetail).toMatchObject({
      id: secondRetry.id,
      retryOfJobId: original.id,
      attemptNumber: 3,
      status: "queued",
      retryCount: 2,
      rerunEligible: false,
    });
  });

  it("rejects reruns when a lineage already has a queued retry", async () => {
    const companyId = randomUUID();
    const store = memoryJobStore(db);
    await insertCompany(db, companyId);

    const original = await store.enqueue({
      companyId,
      bindingId: randomUUID(),
      bindingKey: "primary",
      operationType: "capture",
      sourceKind: "manual",
    });

    await store.cancel({
      companyId,
      jobId: original.id,
      now: new Date("2026-04-21T18:00:00.000Z"),
      resultSummary: "Cancelled by test",
    });

    const firstRetry = await store.rerun(companyId, original.id, {
      now: new Date("2026-04-21T18:01:00.000Z"),
    });

    await expect(store.rerun(companyId, original.id)).rejects.toMatchObject({
      status: 409,
      message: `Memory job ${original.id} already has a queued or running rerun attempt`,
    });

    await store.cancel({
      companyId,
      jobId: firstRetry.id,
      now: new Date("2026-04-21T18:02:00.000Z"),
      resultSummary: "Retry cancelled by test",
    });

    await expect(store.rerun(companyId, original.id)).resolves.toMatchObject({
      retryOfJobId: original.id,
      attemptNumber: 3,
      status: "queued",
    });
  });

  it("derives stuck effective state from expired running leases in list and detail queries", async () => {
    const companyId = randomUUID();
    const now = new Date("2026-04-21T19:00:00.000Z");
    const staleJobId = randomUUID();
    const activeJobId = randomUUID();
    await insertCompany(db, companyId);

    await db.insert(memoryExtractionJobs).values([
      {
        id: staleJobId,
        companyId,
        bindingId: randomUUID(),
        bindingKey: "primary",
        operationType: "capture",
        status: "running",
        sourceKind: "manual",
        startedAt: new Date("2026-04-21T18:40:00.000Z"),
        submittedAt: new Date("2026-04-21T18:39:00.000Z"),
        leaseExpiresAt: new Date("2026-04-21T18:50:00.000Z"),
      },
      {
        id: activeJobId,
        companyId,
        bindingId: randomUUID(),
        bindingKey: "primary",
        operationType: "capture",
        status: "running",
        sourceKind: "manual",
        startedAt: new Date("2026-04-21T18:55:00.000Z"),
        submittedAt: new Date("2026-04-21T18:54:00.000Z"),
        leaseExpiresAt: new Date("2026-04-21T19:05:00.000Z"),
      },
    ]);

    const store = memoryJobStore(db);
    const stuckList = await store.list(companyId, { effectiveState: "stuck" }, { now });
    const runningList = await store.list(companyId, { effectiveState: "running" }, { now });
    const staleDetail = await store.getDetail(companyId, staleJobId, { now });

    expect(stuckList.jobs.map((job) => job.id)).toEqual([staleJobId]);
    expect(runningList.jobs.map((job) => job.id)).toEqual([activeJobId]);
    expect(staleDetail).toMatchObject({
      id: staleJobId,
      status: "running",
      effectiveState: "stuck",
      rerunEligible: false,
    });
  });
});
