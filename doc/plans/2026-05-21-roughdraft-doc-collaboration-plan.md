# PAP-9940 — Roughdraft Learnings + Paperclip Doc Collaboration Plan

## Goal
Define how Paperclip should evolve document tooling by borrowing the best parts of Roughdraft for collaborative document review, while staying aligned with V1 constraints and our company-scoped architecture.

## What we learned from Roughdraft

- Local-first markdown workflow over plain `.md` files, with inline review markers persisted in file content (`comment`, `highlight`, `addition`, `deletion`, `substitution`) and agent-friendly handoff via explicit review-complete events.
- Explicit agent collaboration contract:
  - local open flow that yields a stable URL
  - `review.completed`/status handoff
  - review index JSON for machine-readability
- A “Done Reviewing” action that transitions document state and emits completion metadata.
- Separation between UI review ergonomics (inline/highlighted rail + split view style) and file/source-of-truth markdown persistence.
- MCP-like external tooling path for listing open reviews, watching events, appending replies, and resolving comments.
- Rich setup/CLI flow (open/read/status/watch) that lets agents and humans synchronize around a single document.

## What to borrow now (Priority)

1. **Highest value**: inline annotation model and review-index schema.
2. **High value**: explicit review lifecycle (open → comment/suggest → complete) and status aggregation.
3. **High value**: event/polling interface so agents can wait for reviewer completion.
4. **Deferred**: full local CLI path (`roughdraft` command) until we finish first-party local-server UX.

## What likely does not fit Paperclip without change

- File-path ownership model is local filesystem centric; Paperclip docs currently live as issue/company-scoped DB entities.
- We should avoid forcing CriticMarkup into all documents; support it as a compatibility/review layer within existing markdown storage.
- We should not duplicate markdown file server + database state; persist as one source of truth in Paperclip docs and use derived review indexes.

## Proposed Implementation Phases (post-approval)

### Phase 1 — Design freeze + schema alignment (No code)

- Finalize review model and decide where CriticMarkup-like marks are stored:
  - raw markdown only, parsed annotations table, or hybrid parser + normalized `document_review_events` records.
- Define interoperability contracts:
  - Document review index JSON shape
  - completion/status semantics (`open`, `in_review`, `needs_reply`, `done`)
  - comment resolution rules and permissions
- Confirm UX scope with product/design:
  - inline threaded comments
  - side rail vs modal review surface
  - editor split/preview mode expectations
- Define event API contract for agents:
  - open request, update status, completion notifications
- Add explicit UX/security acceptance criteria and non-functional requirements.

### Phase 2 — API and server data model

- Add server endpoints for review sessions and completion state transitions.
- Add DB persistence for normalized annotations plus review sessions per document.
- Add company/permission checks and immutable activity logs for all review mutations.
- Add a compact, stable JSON review index endpoint consumed by agents and UI.
- Add deterministic status transitions (e.g., reviewer complete, unresolved count, last update time).

### Phase 3 — Rich editor and review UX in Paperclip UI

- Introduce markdown-based rich editing mode with inline annotations.
- Show rendered/markdown toggle and inline comment anchors with thread list.
- Add “Done Reviewing” action with explicit final-state transition and optional reviewer summary.
- Support read/write split behavior for reviewers:
  - read mode for context
  - edit mode for suggested replacements and highlights
- Add diff-safe rendering that preserves base markdown as much as possible.

### Phase 4 — Agent collaboration pathway

- Add/extend Paperclip agent skills so agents can:
  - open a document review session
  - fetch pending review index data
  - append/update comments/replies
  - mark resolved items and report status changes
  - wait for review completion event/timeouts
- Add a machine-visible handoff payload (document URL/id + requested action + deadline + status).
- Add audit-safe handling for status transitions triggered by agents.

### Phase 5 — QA and rollout

- Add focused integration tests for:
  - review lifecycle endpoint transitions
  - company scoping/security on review resources
  - inline annotation parse/serialize roundtrip
- Add UI interaction tests for at least:
  - inline annotation rendering
  - done-review transition
  - status visibility and error handling
- Ship with compatibility note for existing document types and migration path.

## Delivery Plan (blocking dependencies)

1. Confirm plan with CTO/board review.
2. Approve schema contracts in shared types.
3. Implement server contracts.
4. Implement UI editor and review rail.
5. Implement agent skill tooling and protocol.
6. Validate with targeted QA and close by issue.

## Evidence this work should satisfy issue request

- Comments: full inline review flow.
- Rich editor: markdown-aware editing and rendering with review rails.
- Agent collaboration: explicit open/completion protocol and watch/update actions.
- Borrowing rationale: mapped directly to Paperclip capabilities and constraints (company boundaries, contracts, existing document system).
