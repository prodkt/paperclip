import { describe, expect, it, vi } from "vitest";
import { extractPipelineIntakeFormFields, isStageNewEntryDisabled, mapConfiguredFields, triggerStageOnEnter, validateStageRequiredFields } from "./pipelines.js";

describe("pipeline service helpers", () => {
  it("derives intake fields from first stage variables", () => {
    const stageRows = [
      {
        pipelineId: "pipeline-1",
        config: {
          variables: [
            { key: "customer", label: "Customer", type: "text", required: true, options: [], showInAddForm: true },
            { key: "urgency", label: "Urgency", type: "select", options: ["low", "high"], required: false, showInAddForm: true },
            { key: "internal_notes", label: "Internal notes", type: "multiline", required: true, options: [], showInAddForm: false },
          ],
        },
      },
      {
        pipelineId: "pipeline-1",
        config: {
          variables: [
            { key: "ignored", label: "Ignored", type: "text", required: true, options: [], showInAddForm: false },
          ],
        },
      },
    ] as Array<{
      id: string;
      pipelineId: string;
      name: string;
      kind: string;
      position: number;
      config: {
        variables: Array<{
          key: string;
          label: string;
          type: "text" | "select" | "multiline";
          required: boolean;
          options: string[];
          showInAddForm: boolean;
        }>;
      };
      createdAt: Date;
      updatedAt: Date;
    }>;

    expect(extractPipelineIntakeFormFields(stageRows)).toEqual([
      { key: "customer", label: "Customer", type: "text", required: true, options: [] },
      { key: "urgency", label: "Urgency", type: "select", required: false, options: ["low", "high"] },
    ]);
  });

  it("validates required intake fields for pipeline stage variables", () => {
    const variables = [
      { key: "customer", label: "Customer", type: "text" as const, required: true, options: [], showInAddForm: true },
      { key: "notes", label: "Notes", type: "multiline" as const, required: false, options: [], showInAddForm: true },
      { key: "internal_code", label: "Internal code", type: "text" as const, required: true, options: [], showInAddForm: false },
    ];
    expect(() =>
      validateStageRequiredFields({ customer: "Acme" }, variables),
    ).not.toThrow();
    expect(() =>
      validateStageRequiredFields({ notes: "Urgent follow-up" }, variables),
    ).toThrowError(/Missing required field\(s\): customer/);
  });

  it("detects stages that block new entries from config", () => {
    expect(isStageNewEntryDisabled({ variables: [], disable: { newEntries: true } })).toBe(true);
    expect(isStageNewEntryDisabled({ variables: [], disable: { newEntries: false } })).toBe(false);
    expect(isStageNewEntryDisabled({ variables: [], disabled: true })).toBe(true);
  });

  it("maps configured fields and triggers run_routine with resolved payload and actor", async () => {
    const runRoutine = vi.fn().mockResolvedValue({ id: "run-1" });
    const routineSvc = { runRoutine };
    const caseRow = {
      id: "case-1",
      title: "Follow up issue",
      pipelineId: "pipeline-1",
    } as { id: string; title: string; pipelineId: string };
    const stage = {
      id: "stage-1",
      pipelineId: "pipeline-1",
      config: {
        variables: [],
        onEnter: {
          run_routine: {
            routineId: "11111111-1111-4111-8111-111111111111",
            variables: { urgency: "priority" },
            payload: { source: "pipeline" },
            caseFields: { customer: "customer_name" },
          },
        },
      },
    } as {
      id: string;
      pipelineId: string;
      config: { variables: unknown[]; onEnter: { run_routine: Record<string, unknown> } };
    };
    const fields = {
      customer_name: "Acme",
      priority: "high",
      notes: "Escalate quickly",
    };

    await triggerStageOnEnter(null as any, routineSvc as never, stage as never, caseRow as never, fields, {
      actorId: "agent-1",
      actorType: "agent",
    });

    expect(runRoutine).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      {
        source: "api",
        payload: {
          source: "pipeline",
          pipelineId: "pipeline-1",
          caseId: "case-1",
          caseTitle: "Follow up issue",
          customer: "Acme",
        },
        variables: { urgency: "high" },
        caseFields: { customer: "Acme" },
      },
      {
        agentId: "agent-1",
        userId: null,
      },
    );
  });

  it("maps configured fields without unknown entries", () => {
    expect(mapConfiguredFields({ destination: "source" }, { source: "value", other: "ignore" })).toEqual({
      destination: "value",
    });
  });
});
