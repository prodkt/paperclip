# PAP-9815 - Paperclip Triage Plugin Plan

## Revision Intent

This is a fresh plan for [PAP-9815](/PAP/issues/PAP-9815), written from the original transcript and the latest board feedback.

Changes from the rejected revision:

- Use **queues** everywhere and treat transcription variants as references to queues.
- Make Paperclip Triage a first-party package in the monorepo.
- Keep ingestion to the minimal ingest API. Do not plan source connectors in this issue.
- Limit transition actions and auto-actions to create-or-update Paperclip issues from templates.
- Explain the motivation: this is a queue workbench where a human deals with items, teaches an assistant, and gradually turns repeated judgement into queue guidance.
- Incorporate the approved UI caveat: the item workbench is a two-column work area with chat on the center/left and the document/item on the right, editable either directly or through chat.

## Product Thesis

Paperclip Triage is not a source connector and not just an inbox classifier. It is a teachable queue workbench.

The user has streams of heterogeneous objects that arrive from somewhere else. The transcript examples are examples of item shapes, not implementation targets for source integrations. The triage plugin should not care where those objects came from in v1. Its job starts when an item is posted into a queue.

For each queue, the user should be able to:

- see and manage the queue,
- process one item at a time with an assistant,
- edit or inspect the item's main content and metadata,
- talk to the assistant in a Paperclip-backed conversation,
- capture what the user is teaching through edits and comments,
- reflect after each item and propose updates to queue guidance,
- transition the item through the queue workflow,
- optionally create or update a normal Paperclip issue when an item enters a configured state.

The important product loop is:

1. An item enters a queue.
2. The user and assistant deal with the item.
3. Their conversation and edits reveal the user's taste, policy, standards, and preferences.
4. The assistant proposes a guidance update for that queue.
5. The user accepts, rejects, edits, or asks for revision.
6. The item moves to its next workflow state.
7. The next item benefits from the improved guidance.

Over time, the assistant becomes more useful because the queue's guidance becomes more specific. Future automation can use confidence and guidance to take more control, but v1 should make the learning loop legible and safe before broad autonomy.

## Scope Lock

### In Scope

- First-party monorepo package:
  - directory: `packages/plugins/plugin-triage/`
  - package name: `@paperclipai/plugin-triage`
  - plugin id: `paperclipai.plugin-triage`
  - display name: `Paperclip Triage`
- Plugin-owned database namespace for queues, items, workflows, guidance, reflection proposals, transition logs, and issue links.
- Plugin page, sidebar entry, and route sidebar using the plugin SDK.
- Managed Paperclip resources:
  - a managed `Triage Assistant` agent,
  - managed triage skills,
  - a managed `Triage` project for plugin operation issues and default issue-action targets.
- Minimal ingest API for posting items into queues.
- Queue CRUD and queue item CRUD.
- Queue-level workflow states and allowed transitions.
- Queue-level folder-like guidance documents, with `guidance.md` created by default.
- Queue workbench:
  - fixed two-column work area with assistant chat on the center/left and item document/editor on the right,
  - direct item editing and chat-assisted item editing against the same item content,
  - workflow/transition controls,
  - reflection and guidance proposal flow.
- Hidden Paperclip issue conversation for each queue chat history.
- Optional work issue per queue item, created or updated by transition action templates.
- State transition actions limited to create-or-update Paperclip issues.
- Tests and QA acceptance for the complete queue loop.

### Out of Scope

- Any upstream/source connector or source-specific connection logic.
- Deciding what upstream systems create ingestions.
- Crawling, polling, OAuth, source syncs, webhooks from third-party products, or source-specific dedupe.
- External side effects in upstream systems outside Paperclip.
- Fully autonomous processing based on confidence thresholds.
- A complex visual workflow builder.
- Moving this into Paperclip core unless the plugin SDK has a concrete blocker that must be filed separately.

## References Read

- Repo product context: `doc/GOAL.md`, `doc/PRODUCT.md`, `doc/SPEC-implementation.md`, `doc/DEVELOPING.md`, `doc/DATABASE.md`.
- Plugin guide: `doc/plugins/PLUGIN_AUTHORING_GUIDE.md`.
- LLM Wiki package: `packages/plugins/plugin-llm-wiki/`, including manifest, worker, UI, migrations, tests, managed resources, plugin API routes, local-folder/document patterns, hidden operation issues, and route sidebar.
- Content plugin planning context from [PAP-9555](/PAP/issues/PAP-9555): the useful lesson is boundary discipline. Agents or outside systems can fetch or discover objects, while the plugin owns normalized storage, dedupe or idempotency, operation records, and write APIs. For triage v1, that becomes a minimal generic ingest API, not source-specific connectors.

## Working Vocabulary

### Queue

A queue is a named workflow container keyed by a stable `queueKey`.

Examples:

- `inbox`
- `drafts`
- `reviews`
- `content-training`
- `financial-approvals`

A queue owns:

- title, description, status, and counts,
- a default workflow,
- allowed transitions,
- optional transition action templates,
- default assistant agent selection,
- queue-specific guidance documents,
- queue chat history.

Posting to an unknown queue key creates the queue by default. Callers can request strict behavior with `requireExistingQueue: true`, which returns an error if the queue does not exist.

### Queue Item

A queue item is the object being triaged.

It should be deliberately flexible:

- `title`
- `contentFormat` such as `markdown`, `text`, or `json`
- main `content`
- free-form `properties` for upstream/downstream identifiers, stats, labels, or source metadata
- optional `itemKey` or `idempotencyKey` for upsert behavior
- current workflow state
- optional linked queue chat context
- optional linked work issue

V1 should not enforce a queue item schema beyond basic shape and size limits. Queue-level JSON Schema or Zod-style validation can be a later enhancement after the ease-of-use path is proven.

### Queue Guidance

Queue guidance is the assistant's memory for how to handle that queue.

It should behave like a folder of documents, not one oversized blob. Every queue starts with:

- `guidance.md`

Later, the queue may have more files:

- `style.md`
- `review-policy.md`
- `examples.md`
- `rubric.md`

V1 can store these documents in the plugin database with path-like keys and revision metadata. The UI should present them as a folder-like document set. A later phase can add local-folder export/import if needed.

### Queue Chat Issue

Paperclip already uses issues/comments as the conversation and work model. Triage should reuse that model instead of inventing a parallel chat database.

Each queue gets its own hidden Paperclip issue conversation for assistant chat history. The queue workbench pins the current item into the chat context so the assistant stays on task while that item is active.

Rules:

- Do not share chat issues across queues.
- A queue can have chat history and a "new chat" action that creates a fresh hidden issue for that queue.
- The hidden chat issue is distinct from the optional work issue created for a specific queue item.
- The UI can render a lean chat surface, but persistence and agent interaction should map back to Paperclip issue/session semantics.

### Work Issue

A queue item may optionally be linked to a normal Paperclip issue.

This is how a triaged object hands work to the rest of Paperclip. The work issue is not the queue chat issue. It is the concrete issue that agents can execute, track, comment on, assign, block, and finish.

V1 transition actions should create or update this work issue from templates.

## Minimal Ingest API

The ingest path is just a plugin API endpoint.

Proposed route:

```text
POST /api/plugins/paperclipai.plugin-triage/api/queues/:queueKey/items
```

Auth:

- `board-or-agent`
- company resolved from request body or active company context, following plugin API route rules

Request shape:

```json
{
  "companyId": "company-id",
  "title": "Draft launch post",
  "contentFormat": "markdown",
  "content": "# Draft\n\n...",
  "properties": {
    "upstreamId": "external-system-id",
    "sourceKind": "opaque-source-name",
    "priority": "medium"
  },
  "itemKey": "optional-stable-external-key",
  "idempotencyKey": "optional-request-key",
  "requireExistingQueue": false,
  "initialStateKey": "draft"
}
```

Behavior:

- If `queueKey` exists, add or upsert the item there.
- If `queueKey` is unknown and `requireExistingQueue` is false or omitted, create the queue with default settings and then create the item.
- If `queueKey` is unknown and `requireExistingQueue` is true, return a typed error.
- If `itemKey` or `idempotencyKey` matches an existing item in the queue, update the item according to the ingest policy and record an ingest event instead of duplicating it.
- Do not interpret source type beyond storing opaque metadata. Source-specific semantics are out of scope.

The same worker logic should also be available through a plugin action for internal UI/tests, but the API endpoint is the canonical ingest path.

## Workflow Model

Each queue owns a workflow definition.

Default v1 workflow:

```text
draft -> approved
draft -> rejected
approved -> done
rejected -> done
```

The default can be adjusted before implementation if UX finds a better naming set, but it should stay simple.

Workflow definition fields:

- states:
  - stable `stateKey`
  - display name
  - terminal flag
  - queue visibility behavior, such as active, archived, or hidden
- transitions:
  - from state
  - to state
  - label
  - optional required reflection state
  - optional action template

Implementation approach:

- Store the workflow as structured plugin data.
- Start with simple validated state/transition records rather than a visual state-machine builder.
- In the product/API contract phase, evaluate whether a lightweight state-machine library is worth adopting. If the queue UI only needs allowed next-state constraints, a small internal validator is enough for v1.
- Keep the workflow editor simple: state list, allowed next states, and transition action configuration. YAML import/export can be a later convenience, not the primary v1 UI.

## Transition Actions

V1 actions and auto-actions are only create-or-update Paperclip issue templates.

Supported action type:

```json
{
  "type": "create_or_update_issue",
  "mode": "create_if_missing",
  "template": {
    "title": "{{item.title}}",
    "description": "{{item.content}}\n\nMetadata:\n{{item.propertiesJson}}",
    "comment": "Triage item moved to {{transition.toStateKey}}.",
    "projectId": "{{queue.defaultProjectId}}",
    "assignee": "{{queue.defaultAssignee}}",
    "priority": "medium",
    "status": "todo"
  }
}
```

Modes:

- `create_if_missing`: create a work issue only if the item has none.
- `update_existing`: require an existing work issue and add/update fields.
- `create_or_update`: create if missing, otherwise update/comment.

Allowed Paperclip effects:

- create an issue,
- add a comment to the linked issue,
- update assignee,
- update project,
- update status,
- update priority,
- update title or description when explicitly configured.

Disallowed in v1:

- external calls,
- destructive actions,
- source-specific side effects,
- autonomous state transitions based only on model confidence.

Every transition action must write an audit row with the actor, item, transition, template, resolved issue id, and result.

## Workbench UX

The transcript's intended shape is a focused triage workspace, not a generic settings page.

Main surfaces:

- Sidebar entry: `Triage`.
- Route sidebar:
  - queue list,
  - item counts by state,
  - create queue,
  - settings/reconcile link.
- Main page:
  - queue management view,
  - selected queue item list,
  - item workbench.

The primary item workbench is a fixed two-column work area:

- center/left column: assistant chat for working through the current item,
- right column: the item document/content editor and item properties.

Queue navigation, item navigation, metadata, and settings can sit in the route sidebar or a narrow supporting rail, but they should not change the core mental model: chat on the center/left, document/item on the right.

The right-side document panel is where the user can edit the item directly. The center/left chat panel is where the user asks the assistant to help edit, evaluate, or decide. Chat-assisted edits and direct edits both target the same item content and properties, and both are learning signal for reflection.

Expected controls:

- edit item content,
- edit free-form properties,
- send assistant message,
- create new queue chat,
- view queue chat history,
- view current guidance,
- request reflection,
- see proposed guidance diff,
- accept guidance update,
- reject guidance update,
- ask assistant to revise guidance update,
- manually edit guidance,
- choose next state from allowed transitions,
- view or open the linked work issue.

Shared SDK/UI components to reuse where possible:

- `MarkdownBlock` and `MarkdownEditor` for item content and guidance,
- `AssigneePicker` and `ProjectPicker` for issue action templates,
- `IssuesList` for linked/generated work issues,
- `ManagedRoutinesList` if maintenance routines are added,
- `usePluginData`, `usePluginAction`, `usePluginStream`, `useHostNavigation`.

## Assistant And Reflection Loop

The assistant must be guided by queue context, current item context, and current guidance.

Each assistant turn should have access to:

- queue name and purpose,
- current item title/content/properties,
- current workflow state,
- allowed next transitions,
- current queue guidance files,
- linked work issue summary if one exists,
- recent relevant queue chat history,
- current reflection status.

The assistant should have plugin tools or actions for:

- reading queue guidance,
- proposing guidance changes,
- updating item content through controlled actions,
- summarizing item outcome,
- preparing transition recommendations,
- reading linked work issue context.

The assistant should not directly apply guidance changes without user acceptance. The reflection loop is:

1. User finishes dealing with an item.
2. Assistant compares the original item, final item, user edits, chat, decision, and current guidance.
3. Assistant proposes a guidance diff or says no change is needed.
4. User accepts, rejects, edits manually, or asks for revision.
5. Accepted guidance creates a new guidance revision.
6. User transitions the item.

V1 should run reflection after each item. Batched reflection is a later optimization.

## Data Model Draft

All tables live in the plugin database namespace and include company scoping.

- `triage_queues`
  - `id`, `company_id`, `queue_key`, `display_name`, `description`, `status`
  - `default_state_key`
  - `workflow_version`
  - `default_assistant_agent_id`
  - `default_project_id`
  - `settings`
  - unique `(company_id, queue_key)`
- `triage_queue_states`
  - `id`, `company_id`, `queue_id`, `state_key`, `display_name`, `is_terminal`, `visibility`, `sort_order`
- `triage_queue_transitions`
  - `id`, `company_id`, `queue_id`, `from_state_key`, `to_state_key`, `label`, `requires_reflection`, `action_template`, `sort_order`
- `triage_items`
  - `id`, `company_id`, `queue_id`, `item_key`, `idempotency_key`
  - `title`, `content_format`, `content`, `properties`
  - `state_key`, `status`, `linked_work_issue_id`
  - `created_at`, `updated_at`, `archived_at`
  - unique `(company_id, queue_id, item_key)` when `item_key` is present
- `triage_queue_chats`
  - `id`, `company_id`, `queue_id`, `hidden_issue_id`, `status`, `started_at`, `ended_at`
- `triage_item_events`
  - `id`, `company_id`, `queue_id`, `item_id`, `event_type`, `actor_type`, `actor_id`, `payload`, `created_at`
- `triage_guidance_documents`
  - `id`, `company_id`, `queue_id`, `path`, `title`, `body`, `content_hash`, `latest_revision_id`
  - unique `(company_id, queue_id, path)`
- `triage_guidance_revisions`
  - `id`, `company_id`, `queue_id`, `document_id`, `body`, `content_hash`, `summary`, `created_by`, `created_at`
- `triage_guidance_proposals`
  - `id`, `company_id`, `queue_id`, `item_id`, `base_revision_id`, `proposed_body`, `diff`, `status`, `review_comment`, `created_at`, `resolved_at`
- `triage_transition_actions`
  - `id`, `company_id`, `queue_id`, `item_id`, `transition_id`, `action_type`, `template_snapshot`, `result`, `issue_id`, `created_at`

## Plugin Architecture

Manifest:

- capabilities:
  - `api.routes.register`
  - `database.namespace.migrate/read/write`
  - `agents.managed`
  - `skills.managed`
  - `projects.managed`
  - `issues.create`
  - `issues.update`
  - `issue.comments.create`
  - `issues.read`
  - `agent.sessions.create/list/send/close`
  - `agent.tools.register`
  - `activity.log.write`
  - `plugin.state.read/write`
  - `ui.sidebar.register`
  - `ui.page.register`
- UI slots:
  - sidebar link,
  - page route,
  - route sidebar,
  - settings page if needed for managed resources/reconcile.
- API routes:
  - ingest item,
  - list/create/update queues,
  - list/create/update items,
  - transition item,
  - guidance document read/write,
  - guidance proposal accept/reject/revise,
  - queue chat send/history.

Worker:

- registers data handlers for queues, items, workflow, guidance, settings, and linked issues,
- registers actions for queue CRUD, item updates, transitions, reflection proposals, guidance updates, and managed resource reconciliation,
- implements `onApiRequest` for the minimal ingest API and any declared JSON routes,
- uses `ctx.issues` for create/update issue transition actions,
- uses agent sessions or Paperclip issue-backed comments for queue assistant chat,
- records activity and transition audit rows.

UI:

- self-contained plugin React under the package,
- no imports from `ui/src`,
- use SDK shared components first,
- keep route sidebar local to the triage route.

## What Triage Borrows From LLM Wiki

LLM Wiki is the nearest implementation pattern because it already demonstrates:

- a first-party plugin package in `packages/plugins`,
- a manifest with page/sidebar/routeSidebar slots,
- managed agent/project/skills/routines,
- plugin database namespace migrations,
- worker API routes and actions,
- hidden plugin-operation issues,
- agent session capabilities,
- settings health/reconcile screens,
- route sidebar with plugin-local navigation,
- tests that render plugin UI with mocked bridge data.

Triage should reuse those patterns, but with different product primitives:

- LLM Wiki has wiki spaces and pages; Triage has queues, items, workflows, and guidance.
- LLM Wiki ingests sources; Triage receives already-prepared items through a minimal API.
- LLM Wiki creates operation issues for maintenance; Triage creates queue chat issues and optional work issues for items.
- LLM Wiki stores durable knowledge; Triage stores queue-specific operating guidance learned from item processing.

## Relationship To Content Plugin

The content plugin context from [PAP-9555](/PAP/issues/PAP-9555) is useful mainly as a boundary model:

- the plugin should not make Paperclip core own specialized content workflows,
- the plugin should store normalized objects and operation history,
- agents and outside systems can do source-specific fetching,
- plugin APIs should provide simple commit/write contracts.

For triage, the equivalent is:

- any outside source may post a queue item,
- triage stores the generic item and queue workflow state,
- source-specific discovery and crawling stay out of scope,
- the only downstream Paperclip action is create-or-update issue from a template.

## Acceptance Criteria

The approved implementation is complete when:

1. `@paperclipai/plugin-triage` exists as a monorepo package and can be built/tested like other first-party plugins.
2. The plugin declares page/sidebar/routeSidebar UI and managed triage agent/project/skills.
3. A user can create, edit, list, and archive queues.
4. Every new queue gets a default workflow and `guidance.md`.
5. The minimal ingest API can post an item to an existing queue or create the queue by default.
6. Queue items support title, content, free-form properties, idempotent upsert, and workflow state.
7. The queue workbench lets a user process an item with a queue-specific assistant chat and item editor.
8. Queue chat is backed by hidden Paperclip issue/session semantics and is not shared across queues.
9. The reflection flow can propose a guidance diff after item processing.
10. The user can accept, reject, manually edit, or request revision of guidance changes.
11. The user can transition an item only through allowed workflow transitions.
12. A configured transition action can create or update a linked Paperclip work issue from a template.
13. Transition actions are audited and company scoped.
14. No source connectors or external side-effect actions are included.
15. UX review, security review, and QA acceptance are completed before the parent is marked done.

## Post-Approval Child Issue Plan

The plan is approved, with the explicit two-column workbench caveat incorporated above. Create the child issue graph below and block [PAP-9815](/PAP/issues/PAP-9815) on QA acceptance.

### Phase 0 - Product/API Contract Lock

Owner: Senior Product Engineer.

Blocks: all implementation phases.

Deliverables:

- Finalize queue/item/workflow/guidance/chat/work-issue terminology.
- Lock the minimal ingest request/response contract.
- Lock workflow representation and default states.
- Decide whether v1 uses a small internal workflow validator or an existing lightweight state-machine library.
- Lock issue action template fields and allowed Paperclip effects.
- Produce a concise contract document attached to [PAP-9815](/PAP/issues/PAP-9815) or the Phase 0 child issue.

Verification:

- CTO/product acceptance on the contract.
- SecurityEngineer acknowledges the scoped action surface before implementation begins.

### Phase 1 - UX Workbench Design

Owner: UXDesigner.

Can start after Phase 0 has draft terminology and data model. Blocks UI implementation.

Deliverables:

- Wireframes for queue list, queue settings, workflow editor, item list, item workbench, reflection diff, guidance editor, and transition action template setup.
- Make the item workbench explicitly two columns: center/left chat and right-side document/item editor.
- Show both direct document editing and chat-assisted editing against the same item.
- Show desktop and constrained-width behavior.
- Include screenshots or a review artifact.
- Call out how the workbench reuses Paperclip-native components while keeping the chat surface lean.

Verification:

- CTO/product review accepts the workbench model.
- UXDesigner includes screenshots/artifacts in the issue.

### Phase 2 - Package Scaffold And Managed Resources

Owner: CodexCoder.

Blocked by Phase 0.

Deliverables:

- Create `packages/plugins/plugin-triage/` package.
- Add manifest, worker, UI entrypoint, tests, bundler configs, package scripts.
- Declare managed agent, project, and skills.
- Add settings/reconcile health surface.
- Add page/sidebar/routeSidebar slots.

Verification:

- `pnpm --filter @paperclipai/plugin-triage typecheck`
- `pnpm --filter @paperclipai/plugin-triage test`
- `pnpm --filter @paperclipai/plugin-triage build`

### Phase 3 - Data Model And Minimal Ingest API

Owner: CodexCoder.

Blocked by Phase 0 and Phase 2.

Deliverables:

- Add plugin namespace migrations for queues, states, transitions, items, queue chats, guidance docs/revisions/proposals, item events, and transition actions.
- Implement queue CRUD and item CRUD worker actions.
- Implement the minimal ingest API route.
- Add idempotency and queue create-on-post behavior.
- Add company-scoped access checks through plugin route company resolution and worker validation.

Verification:

- Focused plugin tests for queue creation, strict missing-queue error, ingest upsert, company scoping, and migration shape.

### Phase 4 - Queue Chat And Reflection Backend

Owner: CodexCoder, with Skill Consultant review for managed skill prompts if needed.

Blocked by Phase 3.

Deliverables:

- Create/reuse hidden queue chat issues.
- Implement assistant session/send flow with current item and queue guidance context.
- Add controlled item content update action.
- Add guidance proposal generation path.
- Add accept/reject/revise/manual-edit guidance flows.
- Add managed skill/instruction files for triage assistant behavior.

Verification:

- Tests for queue-specific chat isolation, prompt/context assembly, proposal lifecycle, accepted guidance revisions, and rejected proposals.

### Phase 5 - Transition Actions

Owner: CodexCoder.

Blocked by Phase 3.

Deliverables:

- Implement create-or-update issue action templates.
- Resolve template variables from queue/item/transition context.
- Create/update linked work issue with `ctx.issues`.
- Add audit rows and visible transition history.
- Enforce v1 action allowlist.

Verification:

- Tests for create-if-missing, update-existing, create-or-update, invalid template rejection, cross-company denial, and audit rows.

### Phase 6 - Workbench UI Implementation

Owner: ClaudeCoder, with CodexCoder acceptable if the implementer has stronger local context.

Blocked by Phase 1, Phase 3, Phase 4, and Phase 5.

Deliverables:

- Implement queue route sidebar, queue list, item list, item workbench, content editor, chat panel, guidance panel, reflection diff, transition buttons, linked issue panel, and template editor.
- Make the item workbench match the approved two-column shape: center/left chat and right-side document/item editor.
- Support direct edits in the right column and chat-assisted edits from the center/left column.
- Use shared SDK components where available.
- Include screenshots in the implementation issue.

Verification:

- Component or render tests for primary UI states.
- Browser/manual screenshots for queue list and item workbench.

### Phase 7 - Security Review

Owner: SecurityEngineer.

Blocked by Phase 4, Phase 5, and Phase 6.

Deliverables:

- Review template injection risks in create-or-update issue actions.
- Review company scoping and issue mutation permissions.
- Review hidden queue chat issue behavior.
- Review direct-edit and chat-assisted edit paths for authorization and audit gaps.
- Confirm v1 has no source connectors or external side effects.

Verification:

- Security review comment records findings.
- No high or medium blockers remain open before QA starts.

### Phase 8 - QA And Acceptance

Owner: QA.

Blocked by Phase 6 and Phase 7.

Deliverables:

- Validate package install/build path.
- Validate create queue.
- Validate ingest into existing queue.
- Validate ingest creates missing queue by default.
- Validate strict ingest errors when queue is missing.
- Validate item processing with assistant.
- Validate two-column item workbench: chat center/left, document/item right.
- Validate direct item edits and chat-assisted item edits both update the same item.
- Validate guidance proposal accept/reject/edit/revise.
- Validate allowed transitions only.
- Validate create/update Paperclip issue transition action.
- Validate no source connector behavior exists.

Verification:

- QA comment with pass/fail matrix and screenshots for UI flows.
- Bugs filed as follow-up child issues if found.

## Approval Request

Approved in issue comments. Create the Phase 0-8 child issues with the owners and blockers above, then keep [PAP-9815](/PAP/issues/PAP-9815) blocked on Phase 8 QA acceptance.
