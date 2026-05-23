import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginApiRequestInput,
  type PaperclipPlugin,
  type AgentSession,
  type PluginManagedAgentResolution,
  type PluginManagedProjectResolution,
  type PluginManagedSkillResolution,
} from "@paperclipai/plugin-sdk";
import {
  PLUGIN_ID,
  TRIAGE_ASSISTANT_AGENT_KEY,
  TRIAGE_MANAGED_SKILL_KEYS,
  TRIAGE_PROJECT_KEY,
} from "./manifest.js";
import {
  createPostgresTriageStore,
  createTriageService,
  formatTriageError,
  type TriageStore,
} from "./triage.js";

type ManagedResourceHealth = {
  status: "needs_company" | "missing" | "ready";
  checkedAt: string;
  agent: ManagedAgentHealth | null;
  project: ManagedProjectHealth | null;
  skills: ManagedSkillHealth[];
};

type ManagedAgentHealth = {
  resourceKey: string;
  status: PluginManagedAgentResolution["status"];
  agentId: string | null;
  name: string | null;
  agentStatus: string | null;
  adapterType: string | null;
};

type ManagedProjectHealth = {
  resourceKey: string;
  status: PluginManagedProjectResolution["status"];
  projectId: string | null;
  name: string | null;
  projectStatus: string | null;
};

type ManagedSkillHealth = {
  resourceKey: string;
  status: PluginManagedSkillResolution["status"];
  skillId: string | null;
  name: string | null;
  key: string | null;
};

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requireCompanyId(params: Record<string, unknown>): string {
  const companyId = stringField(params.companyId);
  if (!companyId) {
    throw new Error("companyId is required");
  }
  return companyId;
}

async function requireKnownCompany(ctx: PluginContext, companyId: string): Promise<void> {
  const company = await ctx.companies.get(companyId);
  if (!company) {
    throw new Error(`Company not found: ${companyId}`);
  }
}

function summarizeAgent(resolution: PluginManagedAgentResolution): ManagedAgentHealth {
  return {
    resourceKey: resolution.resourceKey,
    status: resolution.status,
    agentId: resolution.agentId,
    name: resolution.agent?.name ?? null,
    agentStatus: resolution.agent?.status ?? null,
    adapterType: resolution.agent?.adapterType ?? null,
  };
}

function summarizeProject(resolution: PluginManagedProjectResolution): ManagedProjectHealth {
  return {
    resourceKey: resolution.resourceKey,
    status: resolution.status,
    projectId: resolution.projectId,
    name: resolution.project?.name ?? null,
    projectStatus: resolution.project?.status ?? null,
  };
}

function summarizeSkill(resolution: PluginManagedSkillResolution): ManagedSkillHealth {
  return {
    resourceKey: resolution.resourceKey,
    status: resolution.status,
    skillId: resolution.skillId,
    name: resolution.skill?.name ?? null,
    key: resolution.skill?.key ?? null,
  };
}

async function managedResourceHealth(
  ctx: PluginContext,
  companyId: string,
  mode: "inspect" | "reconcile",
): Promise<ManagedResourceHealth> {
  const projectResolution = mode === "reconcile"
    ? await ctx.projects.managed.reconcile(TRIAGE_PROJECT_KEY, companyId)
    : await ctx.projects.managed.get(TRIAGE_PROJECT_KEY, companyId);
  const skillResolutions = await Promise.all(
    TRIAGE_MANAGED_SKILL_KEYS.map((skillKey) =>
      mode === "reconcile"
        ? ctx.skills.managed.reconcile(skillKey, companyId)
        : ctx.skills.managed.get(skillKey, companyId),
    ),
  );
  const agentResolution = mode === "reconcile"
    ? await ctx.agents.managed.reconcile(TRIAGE_ASSISTANT_AGENT_KEY, companyId)
    : await ctx.agents.managed.get(TRIAGE_ASSISTANT_AGENT_KEY, companyId);

  const agent = summarizeAgent(agentResolution);
  const project = summarizeProject(projectResolution);
  const skills = skillResolutions.map(summarizeSkill);
  const missing = [
    agent.status === "missing",
    project.status === "missing",
    ...skills.map((skill) => skill.status === "missing"),
  ].some(Boolean);

  return {
    status: missing ? "missing" : "ready",
    checkedAt: new Date().toISOString(),
    agent,
    project,
    skills,
  };
}

function actionActor(ctx: PluginContext, params: Record<string, unknown>) {
  const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : null;
  const actorAgentId = typeof params.actorAgentId === "string" ? params.actorAgentId : null;
  const actorType = typeof params.actorType === "string" ? params.actorType : null;

  if (actorType === "user" && actorUserId) {
    return {
      actorType,
      actorId: actorUserId,
      actorRunId: typeof params.actorRunId === "string" ? params.actorRunId : null,
    };
  }

  if (actorType === "agent" && actorAgentId) {
    return {
      actorType,
      actorId: actorAgentId,
      actorRunId: typeof params.actorRunId === "string" ? params.actorRunId : null,
    };
  }

  return {
    actorType: "plugin-action",
    actorId: ctx.manifest.id,
    actorRunId: typeof params.actorRunId === "string" ? params.actorRunId : null,
  };
}

async function ensureQueueChatIssue(
  ctx: PluginContext,
  service: ReturnType<typeof createTriageService>,
  params: Record<string, unknown>,
  actor?: { actorType?: string | null; actorId?: string | null; actorRunId?: string | null },
) {
  const companyId = requireCompanyId(params);
  const ensured = await service.ensureQueueChat(params);
  let hiddenIssueId = ensured.chat.hiddenIssueId;
  const existingIssue = hiddenIssueId ? await ctx.issues.get(hiddenIssueId, companyId) : null;
  if (!existingIssue) {
    const project = await ctx.projects.managed.reconcile(TRIAGE_PROJECT_KEY, companyId);
    const issueActor = actor?.actorType === "user"
      ? { actorUserId: actor.actorId ?? undefined, actorRunId: actor.actorRunId ?? undefined }
      : actor?.actorType === "agent"
        ? { actorAgentId: actor.actorId ?? undefined, actorRunId: actor.actorRunId ?? undefined }
        : undefined;
    const issue = await ctx.issues.create({
      companyId,
      projectId: project.projectId ?? undefined,
      title: ensured.chat.title ?? `Triage chat: ${ensured.queue.title}`,
      description: [
        `Hidden queue chat for Paperclip Triage queue \`${ensured.queue.queueKey}\`.`,
        "",
        "This issue stores assistant conversation audit context for the queue and is created by the triage plugin.",
      ].join("\n"),
      status: "in_review",
      priority: "low",
      surfaceVisibility: "plugin_operation",
      originKind: `plugin:${PLUGIN_ID}:operation:queue-chat`,
      originId: `queue-chat:${ensured.queue.id}`,
      actor: issueActor,
    });
    hiddenIssueId = issue.id;
    ensured.chat = await service.updateQueueChat({
      companyId,
      chatId: ensured.chat.id,
      hiddenIssueId,
      metadata: {
        ...ensured.chat.metadata,
        hiddenIssueIdentifier: issue.identifier,
      },
    });
  }
  return { ...ensured, hiddenIssueId };
}

async function activeSessionForChat(
  ctx: PluginContext,
  companyId: string,
  agentId: string,
  chatMetadata: Record<string, unknown>,
): Promise<AgentSession | null> {
  const activeSessionId = typeof chatMetadata.activeSessionId === "string" ? chatMetadata.activeSessionId : null;
  if (!activeSessionId) return null;
  const sessions = await ctx.agents.sessions.list(agentId, companyId);
  return sessions.find((session) => session.sessionId === activeSessionId) ?? null;
}

export function createTriagePlugin(options: {
  createStore?: (ctx: PluginContext) => TriageStore;
} = {}): PaperclipPlugin {
  const createStore = options.createStore ?? createPostgresTriageStore;
  let service: ReturnType<typeof createTriageService> | null = null;
  let activeCtx: PluginContext | null = null;

  function getService() {
    if (!service) throw new Error("Paperclip Triage service is not ready");
    return service;
  }

  async function handleApiRequest(input: PluginApiRequestInput) {
    if (input.routeKey !== "items.ingest") {
      return {
        status: 404,
        body: { error: { code: "unknown_route", message: `Unknown triage route: ${input.routeKey}` } },
      };
    }

    const body = input.body && typeof input.body === "object" && !Array.isArray(input.body)
      ? input.body as Record<string, unknown>
      : {};
    const bodyCompanyId = stringField(body.companyId);
    if (bodyCompanyId && bodyCompanyId !== input.companyId) {
      return {
        status: 403,
        body: {
          error: {
            code: "company_scope_mismatch",
            message: "Request companyId does not match the resolved plugin route company",
          },
        },
      };
    }

    try {
      if (activeCtx) await requireKnownCompany(activeCtx, input.companyId);
      const result = await getService().ingestItem(
        {
          ...body,
          companyId: input.companyId,
          queueKey: input.params.queueKey,
        },
        {
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          actorRunId: input.actor.runId ?? null,
        },
      );
      return {
        status: result.createdItem ? 201 : 200,
        body: result,
      };
    } catch (error) {
      return formatTriageError(error);
    }
  }

  return definePlugin({
  async setup(ctx) {
    activeCtx = ctx;
    service = createTriageService(createStore(ctx));

    ctx.data.register("managed-resource-health", async (params: Record<string, unknown>) => {
      const companyId = stringField(params.companyId);
      if (!companyId) {
        return {
          status: "needs_company",
          checkedAt: new Date().toISOString(),
          agent: null,
          project: null,
          skills: [],
        } satisfies ManagedResourceHealth;
      }

      return managedResourceHealth(ctx, companyId, "inspect");
    });

    ctx.data.register("queues", async (params: Record<string, unknown>) => {
      return getService().listQueues(params);
    });

    ctx.data.register("queue", async (params: Record<string, unknown>) => {
      return getService().getQueue(params);
    });

    ctx.data.register("queue-items", async (params: Record<string, unknown>) => {
      return getService().listItems(params);
    });

    ctx.data.register("queue-item", async (params: Record<string, unknown>) => {
      return getService().getItem(params);
    });

    ctx.data.register("assistant-context", async (params: Record<string, unknown>) => {
      return getService().getAssistantContext(params);
    });

    ctx.data.register("queue-guidance", async (params: Record<string, unknown>) => {
      return getService().listGuidanceDocs(params);
    });

    ctx.data.register("guidance-proposals", async (params: Record<string, unknown>) => {
      return getService().listGuidanceProposals(params);
    });

    ctx.data.register("item-events", async (params: Record<string, unknown>) => {
      return getService().listItemEvents(params);
    });

    ctx.data.register("queue-transition-actions", async (params: Record<string, unknown>) => {
      return getService().listTransitionActions(params);
    });

    ctx.actions.register("reconcile-managed-resources", async (params: Record<string, unknown>) => {
      const companyId = requireCompanyId(params);
      const result = await managedResourceHealth(ctx, companyId, "reconcile");
      ctx.logger.info("Reconciled Paperclip Triage managed resources", {
        companyId,
        agentStatus: result.agent?.status,
        projectStatus: result.project?.status,
        skillStatuses: result.skills.map((skill) => `${skill.resourceKey}:${skill.status}`),
      });
      return result;
    });

    ctx.actions.register("create-queue", async (params: Record<string, unknown>) => {
      await requireKnownCompany(ctx, requireCompanyId(params));
      return getService().createQueue(params);
    });

    ctx.actions.register("update-queue", async (params: Record<string, unknown>) => {
      await requireKnownCompany(ctx, requireCompanyId(params));
      return getService().updateQueue(params);
    });

    ctx.actions.register("archive-queue", async (params: Record<string, unknown>) => {
      await requireKnownCompany(ctx, requireCompanyId(params));
      return getService().archiveQueue(params);
    });

    ctx.actions.register("ingest-item", async (params: Record<string, unknown>) => {
      await requireKnownCompany(ctx, requireCompanyId(params));
      return getService().ingestItem(params, { actorType: "plugin-action", actorId: ctx.manifest.id });
    });

    ctx.actions.register("create-or-update-item", async (params: Record<string, unknown>) => {
      await requireKnownCompany(ctx, requireCompanyId(params));
      return getService().ingestItem(params, { actorType: "plugin-action", actorId: ctx.manifest.id });
    });

    ctx.actions.register("update-item", async (params: Record<string, unknown>) => {
      await requireKnownCompany(ctx, requireCompanyId(params));
      return getService().updateItem(params);
    });

    ctx.actions.register("update-item-content", async (params: Record<string, unknown>) => {
      await requireKnownCompany(ctx, requireCompanyId(params));
      return getService().updateItemContent(params, actionActor(ctx, params));
    });

    ctx.actions.register("archive-item", async (params: Record<string, unknown>) => {
      await requireKnownCompany(ctx, requireCompanyId(params));
      return getService().archiveItem(params);
    });

    ctx.actions.register("upsert-transition-action", async (params: Record<string, unknown>) => {
      await requireKnownCompany(ctx, requireCompanyId(params));
      return getService().upsertTransitionAction(params);
    });

    ctx.actions.register("transition-item", async (params: Record<string, unknown>) => {
      await requireKnownCompany(ctx, requireCompanyId(params));
      return getService().transitionItem(params, ctx, actionActor(ctx, params));
    });

    ctx.actions.register("ensure-queue-chat", async (params: Record<string, unknown>) => {
      await requireKnownCompany(ctx, requireCompanyId(params));
      return ensureQueueChatIssue(ctx, getService(), params, actionActor(ctx, params));
    });

    ctx.actions.register("send-assistant-message", async (params: Record<string, unknown>) => {
      const companyId = requireCompanyId(params);
      await requireKnownCompany(ctx, companyId);
      const message = stringField(params.message);
      if (!message) {
        throw new Error("message is required");
      }

      const context = await getService().getAssistantContext(params);
      const actor = actionActor(ctx, params);
      const chat = await ensureQueueChatIssue(ctx, getService(), params, actor);
      const agentResolution = await ctx.agents.managed.reconcile(TRIAGE_ASSISTANT_AGENT_KEY, companyId);
      if (!agentResolution.agentId) {
        throw new Error("Triage Assistant managed agent is missing");
      }
      if (agentResolution.agent?.status === "paused") {
        await ctx.agents.resume(agentResolution.agentId, companyId);
      }
      const existingSession = await activeSessionForChat(
        ctx,
        companyId,
        agentResolution.agentId,
        chat.chat.metadata,
      );
      const session = existingSession ??
        await ctx.agents.sessions.create(agentResolution.agentId, companyId, {
          taskKey: `plugin:${PLUGIN_ID}:session:triage-queue-chat:${chat.queue.id}`,
          reason: "triage_queue_chat",
        });
      const run = await ctx.agents.sessions.sendMessage(session.sessionId, companyId, {
        prompt: context.prompt,
        reason: `triage:${chat.queue.queueKey}`,
      });
      const updatedChat = await getService().updateQueueChat({
        companyId,
        chatId: chat.chat.id,
        metadata: {
          ...chat.chat.metadata,
          activeSessionId: session.sessionId,
          lastRunId: run.runId,
          lastItemId: context.item.id,
        },
      });
      if (chat.hiddenIssueId) {
        const commentAuthor = actor.actorType === "user"
          ? { authorUserId: actor.actorId ?? undefined }
          : actor.actorType === "agent"
            ? { authorAgentId: actor.actorId ?? undefined }
            : undefined;
        await ctx.issues.createComment(
          chat.hiddenIssueId,
          [`User message for item \`${context.item.title}\`:`, "", message].join("\n"),
          companyId,
          commentAuthor,
        );
      }
      return {
        queue: context.queue,
        item: context.item,
        guidanceDocs: context.guidanceDocs,
        chat: updatedChat,
        hiddenIssueId: chat.hiddenIssueId,
        session,
        runId: run.runId,
        prompt: context.prompt,
      };
    });

    ctx.actions.register("generate-guidance-proposal", async (params: Record<string, unknown>) => {
      await requireKnownCompany(ctx, requireCompanyId(params));
      return getService().createGuidanceProposal(params, actionActor(ctx, params));
    });

    ctx.actions.register("revise-guidance-proposal", async (params: Record<string, unknown>) => {
      await requireKnownCompany(ctx, requireCompanyId(params));
      return getService().reviseGuidanceProposal(params, actionActor(ctx, params));
    });

    ctx.actions.register("reject-guidance-proposal", async (params: Record<string, unknown>) => {
      await requireKnownCompany(ctx, requireCompanyId(params));
      return getService().rejectGuidanceProposal(params, actionActor(ctx, params));
    });

    ctx.actions.register("accept-guidance-proposal", async (params: Record<string, unknown>) => {
      await requireKnownCompany(ctx, requireCompanyId(params));
      return getService().acceptGuidanceProposal(params, actionActor(ctx, params));
    });

    ctx.actions.register("manual-edit-guidance", async (params: Record<string, unknown>) => {
      await requireKnownCompany(ctx, requireCompanyId(params));
      return getService().manualEditGuidance(params, actionActor(ctx, params));
    });
  },

  async onApiRequest(input: PluginApiRequestInput) {
    return handleApiRequest(input);
  },

  async onHealth() {
    return { status: "ok", message: "Paperclip Triage worker is running" };
  },
  });
}

const plugin = createTriagePlugin();
export default plugin;
runWorker(plugin, import.meta.url);
