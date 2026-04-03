import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFeedbackTraceShareClientFromConfig } from "../services/feedback-share-client.js";

describe("feedback trace share client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ objectKey: "feedback-traces/test.json" }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to telemetry.paperclip.ing when no backend url is configured", async () => {
    const client = createFeedbackTraceShareClientFromConfig({
      feedbackExportBackendUrl: undefined,
      feedbackExportBackendToken: undefined,
    });

    await client.uploadTraceBundle({
      traceId: "trace-1",
      exportId: "export-1",
      companyId: "company-1",
      issueId: "issue-1",
      issueIdentifier: "PAP-1",
      adapterType: "codex_local",
      captureStatus: "full",
      notes: [],
      envelope: {},
      surface: null,
      paperclipRun: null,
      rawAdapterTrace: null,
      normalizedAdapterTrace: null,
      privacy: null,
      integrity: {},
      files: [],
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://telemetry.paperclip.ing/feedback-traces",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });
});
