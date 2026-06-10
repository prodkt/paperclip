import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import {
  AlertTriangle,
  Check,
  GitBranch,
  Hexagon,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { agentsApi } from "../api/agents";
import { accessApi, type CompanyUserDirectoryEntry } from "../api/access";
import type { Pipeline, PipelineStage, PipelineTransition } from "../api/pipelines";
import { pipelinesApi } from "../api/pipelines";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Link, useNavigate, useParams } from "@/lib/router";

type SettingsTab = "stages" | "guidance" | "advanced";
type VariableType = "text" | "multiline" | "select";
type ApprovalType = "any_human" | "human" | "agent";

type StageConfig = {
  variables?: Array<{
    key: string;
    label: string;
    type?: VariableType;
    options?: string[];
    required?: boolean;
    showInAddForm?: boolean;
  }>;
  disable?: {
    newEntries?: boolean;
    reason?: string | null;
  };
  approval?: {
    required?: boolean;
    approverType?: ApprovalType;
    approverId?: string | null;
  };
  whatHappensHere?: string;
  [key: string]: unknown;
};

type EditorVariable = {
  id: string;
  key: string;
  label: string;
  type: VariableType;
  optionsText: string;
  required: boolean;
  showInAddForm: boolean;
};

const TAB_LABELS: Array<{ id: SettingsTab; label: string }> = [
  { id: "stages", label: "Stages" },
  { id: "guidance", label: "Guidance" },
  { id: "advanced", label: "Advanced" },
];

const PIPELINE_GUIDANCE_KEY = "plain-language";

function stageConfig(stage: PipelineStage | null | undefined): StageConfig {
  const config = stage?.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { variables: [] };
  }
  return config as StageConfig;
}

function stageNewEntriesDisabled(stage: PipelineStage | null | undefined) {
  const config = stageConfig(stage);
  if (config.disable?.newEntries) return true;
  if (typeof config.disabled === "boolean") return config.disabled;
  if (typeof config.newEntriesDisabled === "boolean") return config.newEntriesDisabled;
  return false;
}

function variableRows(stage: PipelineStage | null | undefined): EditorVariable[] {
  return (stageConfig(stage).variables ?? []).map((variable, index) => ({
    id: `${variable.key || "variable"}-${index}`,
    key: variable.key,
    label: variable.label,
    type: variable.type ?? "text",
    optionsText: (variable.options ?? []).join(", "),
    required: Boolean(variable.required),
    showInAddForm: Boolean(variable.showInAddForm),
  }));
}

function cleanVariables(variables: EditorVariable[]) {
  return variables
    .map((variable) => {
      const type = variable.type;
      const options = type === "select"
        ? variable.optionsText
          .split(",")
          .map((option) => option.trim())
          .filter(Boolean)
        : [];
      return {
        key: variable.key.trim(),
        label: variable.label.trim() || variable.key.trim(),
        type,
        options,
        required: variable.required,
        showInAddForm: variable.showInAddForm,
      };
    })
    .filter((variable) => variable.key);
}

function approvalValue(config: StageConfig) {
  const approval = config.approval;
  if (!approval?.required || approval.approverType === "any_human" || !approval.approverType) {
    return "any_human";
  }
  return `${approval.approverType}:${approval.approverId ?? ""}`;
}

function parseApprovalValue(value: string): { approverType: ApprovalType; approverId: string | null } {
  if (value === "any_human") {
    return { approverType: "any_human", approverId: null };
  }
  const [type, id] = value.split(":", 2);
  if (type === "human" || type === "agent") {
    return { approverType: type, approverId: id || null };
  }
  return { approverType: "any_human", approverId: null };
}

function sortedStages(pipeline: Pipeline | null | undefined) {
  return [...(pipeline?.stages ?? [])].sort((left, right) => left.position - right.position);
}

function transitionKey(transition: PipelineTransition) {
  return `${transition.fromStageId}:${transition.toStageId}`;
}

function transitionPayload(transition: PipelineTransition): PipelineTransition {
  return {
    fromStageId: transition.fromStageId,
    toStageId: transition.toStageId,
    config: transition.config ?? {},
  };
}

function humanLabel(entry: CompanyUserDirectoryEntry) {
  return entry.user?.name || entry.user?.email || entry.principalId;
}

function agentLabel(agent: Agent) {
  return agent.name || agent.role || agent.id;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 border-t border-border pt-5">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

export function PipelineSettings() {
  const { pipelineId } = useParams<{ pipelineId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<SettingsTab>("stages");
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [stageName, setStageName] = useState("");
  const [stageKind, setStageKind] = useState("open");
  const [newEntriesDisabled, setNewEntriesDisabled] = useState(false);
  const [disableReason, setDisableReason] = useState("");
  const [approvalRequired, setApprovalRequired] = useState(false);
  const [selectedApproval, setSelectedApproval] = useState("any_human");
  const [whatHappensHere, setWhatHappensHere] = useState("");
  const [variables, setVariables] = useState<EditorVariable[]>([]);
  const [transitionTargets, setTransitionTargets] = useState<Set<string>>(() => new Set());
  const [guidanceBody, setGuidanceBody] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");

  const pipelineQuery = useQuery({
    queryKey: pipelineId ? queryKeys.pipelines.detail(pipelineId) : ["pipelines", "detail", "none"],
    queryFn: () => pipelinesApi.get(pipelineId!),
    enabled: !!pipelineId && !!selectedCompanyId,
  });

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const usersQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.access.companyUserDirectory(selectedCompanyId) : ["access", "users", "none"],
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const pipeline = pipelineQuery.data ?? null;
  const stages = useMemo(() => sortedStages(pipeline), [pipeline]);
  const selectedStage = stages.find((stage) => stage.id === selectedStageId) ?? stages[0] ?? null;
  const guidanceDocument = pipeline?.guidanceDocuments?.find((doc) => doc.key === PIPELINE_GUIDANCE_KEY)
    ?? pipeline?.guidanceDocuments?.[0]
    ?? null;

  useEffect(() => {
    if (!pipeline) return;
    setBreadcrumbs([
      { label: "Pipelines", href: "/pipelines" },
      { label: pipeline.name, href: `/pipelines/${pipeline.id}` },
      { label: "Settings" },
    ]);
  }, [pipeline, setBreadcrumbs]);

  useEffect(() => {
    if (!selectedStageId && stages[0]) {
      setSelectedStageId(stages[0].id);
    }
  }, [selectedStageId, stages]);

  useEffect(() => {
    if (!selectedStage) return;
    const config = stageConfig(selectedStage);
    setStageName(selectedStage.name);
    setStageKind(selectedStage.kind);
    setNewEntriesDisabled(stageNewEntriesDisabled(selectedStage));
    setDisableReason(config.disable?.reason ?? "");
    setApprovalRequired(Boolean(config.approval?.required));
    setSelectedApproval(approvalValue(config));
    setWhatHappensHere(config.whatHappensHere ?? "");
    setVariables(variableRows(selectedStage));
    setTransitionTargets(
      new Set(
        (pipeline?.transitions ?? [])
          .filter((transition) => transition.fromStageId === selectedStage.id)
          .map((transition) => transition.toStageId),
      ),
    );
  }, [pipeline?.transitions, selectedStage]);

  useEffect(() => {
    setGuidanceBody(guidanceDocument?.body ?? "");
  }, [guidanceDocument?.body]);

  const refreshPipeline = async () => {
    if (!pipelineId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.intakeForm(pipelineId) });
  };

  const saveStage = useMutation({
    mutationFn: async () => {
      if (!pipelineId || !selectedStage || !pipeline) return null;
      const parsedApproval = parseApprovalValue(selectedApproval);
      const config: StageConfig = {
        ...stageConfig(selectedStage),
        variables: cleanVariables(variables),
        disable: {
          newEntries: newEntriesDisabled,
          reason: disableReason.trim() || null,
        },
        approval: {
          required: approvalRequired,
          approverType: approvalRequired ? parsedApproval.approverType : "any_human",
          approverId: approvalRequired ? parsedApproval.approverId : null,
        },
        whatHappensHere: whatHappensHere.trim(),
      };

      const existingTransitions = pipeline.transitions ?? [];
      const selectedTransitionKeys = new Set(
        [...transitionTargets].map((targetId) => `${selectedStage.id}:${targetId}`),
      );
      const nextTransitions = [
        ...existingTransitions
          .filter((transition) => transition.fromStageId !== selectedStage.id)
          .map(transitionPayload),
        ...[...transitionTargets].map((targetId) => ({
          fromStageId: selectedStage.id,
          toStageId: targetId,
          config:
            existingTransitions.find((transition) => transitionKey(transition) === `${selectedStage.id}:${targetId}`)
              ?.config ?? {},
        })),
      ].filter((transition, index, all) => {
        if (transition.fromStageId === transition.toStageId) return false;
        const key = transitionKey(transition);
        return selectedTransitionKeys.has(key) || all.findIndex((item) => transitionKey(item) === key) === index;
      });

      await pipelinesApi.updateStage(pipelineId, selectedStage.id, {
        name: stageName.trim(),
        kind: stageKind,
        config,
      });
      await pipelinesApi.setTransitions(pipelineId, { transitions: nextTransitions });
      return null;
    },
    onSuccess: async () => {
      await refreshPipeline();
      pushToast({ title: "Stage saved", tone: "success" });
    },
  });

  const addStage = useMutation({
    mutationFn: async (afterStage: PipelineStage | null) => {
      if (!pipelineId || !pipeline) return null;
      const insertPosition = afterStage ? afterStage.position + 1 : stages.length;
      const nextStage = afterStage
        ? stages.find((stage) => stage.position > afterStage.position) ?? null
        : null;
      const created = await pipelinesApi.createStage(pipelineId, {
        name: "New stage",
        kind: "working",
        position: insertPosition,
        config: { variables: [] },
      });
      if (afterStage) {
        const existingTransitions = pipeline.transitions ?? [];
        const nextTransitions = existingTransitions
          .filter(
            (transition) => !(nextStage && transition.fromStageId === afterStage.id && transition.toStageId === nextStage.id),
          )
          .map(transitionPayload);
        nextTransitions.push({ fromStageId: afterStage.id, toStageId: created.id, config: {} });
        if (nextStage) {
          nextTransitions.push({ fromStageId: created.id, toStageId: nextStage.id, config: {} });
        }
        await pipelinesApi.setTransitions(pipelineId, { transitions: nextTransitions });
      }
      return created;
    },
    onSuccess: async (created) => {
      await refreshPipeline();
      if (created) {
        setSelectedStageId(created.id);
      }
      pushToast({ title: "Stage added", tone: "success" });
    },
  });

  const saveGuidance = useMutation({
    mutationFn: () =>
      pipelinesApi.upsertGuidanceDocument(pipelineId!, PIPELINE_GUIDANCE_KEY, {
        title: "Pipeline guidance",
        body: guidanceBody.trim(),
      }),
    onSuccess: async () => {
      await refreshPipeline();
      pushToast({ title: "Guidance saved", tone: "success" });
    },
  });

  const deletePipeline = useMutation({
    mutationFn: () => pipelinesApi.remove(pipelineId!),
    onSuccess: async () => {
      if (selectedCompanyId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.list(selectedCompanyId) });
      }
      navigate("/pipelines");
    },
  });

  const addVariable = () => {
    const nextIndex = variables.length + 1;
    setVariables((current) => [
      ...current,
      {
        id: `new-${Date.now()}`,
        key: `field_${nextIndex}`,
        label: `Field ${nextIndex}`,
        type: "text",
        optionsText: "",
        required: false,
        showInAddForm: true,
      },
    ]);
  };

  const updateVariable = (id: string, patch: Partial<EditorVariable>) => {
    setVariables((current) =>
      current.map((variable) => variable.id === id ? { ...variable, ...patch } : variable),
    );
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a company to edit pipeline settings." />;
  }

  if (!pipelineId) {
    return <EmptyState icon={Hexagon} message="No pipeline selected." />;
  }

  if (pipelineQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (pipelineQuery.error) {
    return <p className="text-sm text-destructive">{pipelineQuery.error.message}</p>;
  }

  if (!pipeline) {
    return <EmptyState icon={Hexagon} message="Pipeline not found." />;
  }

  const deleteEnabled = deleteConfirmation === pipeline.name && !deletePipeline.isPending;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link to={`/pipelines/${pipeline.id}`} className="text-sm text-muted-foreground hover:text-foreground">
            Back to board
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-normal text-foreground">{pipeline.name} settings</h1>
          {pipeline.description ? <p className="mt-1 text-sm text-muted-foreground">{pipeline.description}</p> : null}
        </div>
      </div>

      <div className="flex border-b border-border" role="tablist" aria-label="Pipeline settings tabs">
        {TAB_LABELS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-tab-value={tab.id}
            aria-selected={activeTab === tab.id}
            className={cn(
              "border-b-2 px-4 py-2 text-sm font-semibold",
              activeTab === tab.id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "stages" ? (
        <div className="space-y-6">
          {stages.length === 0 ? (
            <EmptyState
              icon={GitBranch}
              message="No stages configured."
              action="Add first stage"
              onAction={() => addStage.mutate(null)}
            />
          ) : (
            <div className="overflow-x-auto border-y border-border py-4">
              <div className="flex min-w-max items-center gap-2">
                {stages.map((stage, index) => (
                  <div key={stage.id} className="flex items-center gap-2">
                    <button
                      type="button"
                      className={cn(
                        "min-h-20 w-48 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                        selectedStage?.id === stage.id
                          ? "border-foreground bg-accent/50"
                          : "border-border hover:bg-accent/40",
                      )}
                      onClick={() => setSelectedStageId(stage.id)}
                    >
                      <span className="block font-semibold text-foreground">{stage.name}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">Position {stage.position}</span>
                      {stageNewEntriesDisabled(stage) ? (
                        <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                          <AlertTriangle className="h-3 w-3" />
                          New entries disabled
                        </span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      aria-label={`Insert stage after ${stage.name}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                      onClick={() => addStage.mutate(stage)}
                      disabled={addStage.isPending}
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                    {index === stages.length - 1 ? null : (
                      <span className="h-px w-8 bg-border" aria-hidden="true" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {selectedStage ? (
            <form
              className="space-y-5"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                saveStage.mutate();
              }}
            >
              <Section title="Basics">
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
                  <label className="block space-y-1.5 text-sm font-medium">
                    <span>Name</span>
                    <Input value={stageName} onChange={(event) => setStageName(event.target.value)} required />
                  </label>
                  <label className="block space-y-1.5 text-sm font-medium">
                    <span>Kind</span>
                    <select
                      value={stageKind}
                      onChange={(event) => setStageKind(event.target.value)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="open">Open</option>
                      <option value="working">Working</option>
                      <option value="review">Review</option>
                      <option value="done">Done</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </label>
                </div>
              </Section>

              <Section title="Disable">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium">Block new entry</div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Existing items stay visible on the board.
                    </p>
                  </div>
                  <ToggleSwitch checked={newEntriesDisabled} onCheckedChange={setNewEntriesDisabled} />
                </div>
                {newEntriesDisabled ? (
                  <label className="block space-y-1.5 text-sm font-medium">
                    <span>Reason</span>
                    <Textarea
                      value={disableReason}
                      onChange={(event) => setDisableReason(event.target.value)}
                      rows={2}
                    />
                  </label>
                ) : null}
              </Section>

              <Section title="Approval">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium">Require approval</div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Approval routing is recorded on the stage configuration.
                    </p>
                  </div>
                  <ToggleSwitch checked={approvalRequired} onCheckedChange={setApprovalRequired} />
                </div>
                {approvalRequired ? (
                  <label className="block max-w-md space-y-1.5 text-sm font-medium">
                    <span>Approver</span>
                    <select
                      aria-label="Approval picker"
                      value={selectedApproval}
                      onChange={(event) => setSelectedApproval(event.target.value)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="any_human">Any human</option>
                      <optgroup label="Humans">
                        {(usersQuery.data?.users ?? []).map((user) => (
                          <option key={user.principalId} value={`human:${user.principalId}`}>
                            {humanLabel(user)}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Agents">
                        {(agentsQuery.data ?? []).map((agent) => (
                          <option key={agent.id} value={`agent:${agent.id}`}>
                            {agentLabel(agent)}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </label>
                ) : null}
              </Section>

              <Section title="What happens here">
                <Textarea
                  value={whatHappensHere}
                  onChange={(event) => setWhatHappensHere(event.target.value)}
                  rows={4}
                  placeholder="Describe the work that should happen in this stage."
                />
              </Section>

              <Section title="Routine variables">
                <div className="space-y-3">
                  {variables.map((variable) => (
                    <div key={variable.id} className="grid gap-2 border-b border-border pb-3 md:grid-cols-[160px_1fr_140px_1fr_auto]">
                      <Input
                        aria-label="Variable key"
                        value={variable.key}
                        onChange={(event) => updateVariable(variable.id, { key: event.target.value })}
                        placeholder="field_key"
                      />
                      <Input
                        aria-label="Variable label"
                        value={variable.label}
                        onChange={(event) => updateVariable(variable.id, { label: event.target.value })}
                        placeholder="Field label"
                      />
                      <select
                        aria-label="Variable type"
                        value={variable.type}
                        onChange={(event) => updateVariable(variable.id, { type: event.target.value as VariableType })}
                        className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                      >
                        <option value="text">Text</option>
                        <option value="multiline">Multiline</option>
                        <option value="select">Select</option>
                      </select>
                      <Input
                        aria-label="Variable options"
                        value={variable.optionsText}
                        onChange={(event) => updateVariable(variable.id, { optionsText: event.target.value })}
                        placeholder="Options, comma separated"
                        disabled={variable.type !== "select"}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${variable.label || variable.key}`}
                        onClick={() => setVariables((current) => current.filter((item) => item.id !== variable.id))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                      <label className="flex items-center gap-2 text-sm text-muted-foreground md:col-span-2">
                        <input
                          type="checkbox"
                          checked={variable.required}
                          onChange={(event) => updateVariable(variable.id, { required: event.target.checked })}
                        />
                        Required
                      </label>
                      <label className="flex items-center gap-2 text-sm text-muted-foreground md:col-span-3">
                        <input
                          type="checkbox"
                          checked={variable.showInAddForm}
                          onChange={(event) => updateVariable(variable.id, { showInAddForm: event.target.checked })}
                        />
                        Show in Add-items form
                      </label>
                    </div>
                  ))}
                  <Button type="button" variant="outline" onClick={addVariable}>
                    <Plus className="h-4 w-4" />
                    Add variable
                  </Button>
                </div>
              </Section>

              <Section title="Connections">
                <div className="grid gap-2 sm:grid-cols-2">
                  {stages.filter((stage) => stage.id !== selectedStage.id).map((stage) => (
                    <label key={stage.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        checked={transitionTargets.has(stage.id)}
                        onChange={(event) => {
                          setTransitionTargets((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(stage.id);
                            else next.delete(stage.id);
                            return next;
                          });
                        }}
                      />
                      {selectedStage.name} can move to {stage.name}
                    </label>
                  ))}
                </div>
              </Section>

              <Section title="Advanced identifiers">
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">Pipeline ID</dt>
                    <dd className="font-mono text-xs">{pipeline.id}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Stage ID</dt>
                    <dd className="font-mono text-xs">{selectedStage.id}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Position</dt>
                    <dd>{selectedStage.position}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Kind</dt>
                    <dd>{selectedStage.kind}</dd>
                  </div>
                </dl>
              </Section>

              {saveStage.error ? <p className="text-sm text-destructive">{saveStage.error.message}</p> : null}
              <Button type="submit" disabled={saveStage.isPending || !stageName.trim()}>
                {saveStage.isPending ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
                {saveStage.isPending ? "Saving..." : "Save stage"}
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}

      {activeTab === "guidance" ? (
        <form
          className="max-w-3xl space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            saveGuidance.mutate();
          }}
        >
          <div>
            <h2 className="text-lg font-semibold text-foreground">Pipeline guidance</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Plain-language instructions agents and operators can use when handling this pipeline.
            </p>
          </div>
          <Textarea
            value={guidanceBody}
            onChange={(event) => setGuidanceBody(event.target.value)}
            rows={12}
            placeholder="Write guidance for how work should enter, move through, and leave this pipeline."
          />
          {saveGuidance.error ? <p className="text-sm text-destructive">{saveGuidance.error.message}</p> : null}
          <Button type="submit" disabled={saveGuidance.isPending || !guidanceBody.trim()}>
            <Save className="h-4 w-4" />
            {saveGuidance.isPending ? "Saving..." : "Save guidance"}
          </Button>
        </form>
      ) : null}

      {activeTab === "advanced" ? (
        <div className="max-w-2xl space-y-4">
          <div className="rounded-md border border-destructive/30 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" />
              <div className="min-w-0 flex-1 space-y-3">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">Danger zone</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Delete permanently removes this pipeline, its stages, guidance, and pipeline items.
                  </p>
                </div>
                <label className="block space-y-1.5 text-sm font-medium">
                  <span>Type {pipeline.name} to confirm</span>
                  <Input
                    value={deleteConfirmation}
                    onChange={(event) => setDeleteConfirmation(event.target.value)}
                    autoComplete="off"
                  />
                </label>
                {deletePipeline.error ? <p className="text-sm text-destructive">{deletePipeline.error.message}</p> : null}
                <Button
                  type="button"
                  variant="destructive"
                  disabled={!deleteEnabled}
                  onClick={() => deletePipeline.mutate()}
                >
                  <Trash2 className="h-4 w-4" />
                  {deletePipeline.isPending ? "Deleting..." : "Delete permanently"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
