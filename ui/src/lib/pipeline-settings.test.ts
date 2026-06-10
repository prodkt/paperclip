import { describe, expect, it } from "vitest";
import { pipelineStageConfigSchema } from "@paperclipai/shared";

describe("pipeline settings stage config", () => {
  it("accepts disable and approval settings stored in stage config", () => {
    const parsed = pipelineStageConfigSchema.safeParse({
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
      disable: {
        newEntries: true,
        reason: "Pause intake while the team clears the queue.",
      },
      approval: {
        required: true,
        approverType: "agent",
        approverId: "agent-1",
      },
      whatHappensHere: "Triage every incoming item before work starts.",
    });

    expect(parsed.success).toBe(true);
  });

  it("requires a concrete approver when approval targets a human or agent", () => {
    const parsed = pipelineStageConfigSchema.safeParse({
      variables: [],
      approval: {
        required: true,
        approverType: "human",
        approverId: null,
      },
    });

    expect(parsed.success).toBe(false);
  });
});
