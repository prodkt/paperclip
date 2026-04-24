# Agent Instruction Templates

Use this reference from step 4 of the hiring workflow. It lists the current role templates, when to use each, and how to decide between an exact template, an adjacent template, or the generic fallback.

These templates are deliberately separate from the main Paperclip heartbeat skill and from `SKILL.md` in this folder — the core wake procedure and hiring workflow stay short, and role-specific depth lives here.

## Decision flow

```
role match?
├── exact template exists       → copy it, replace placeholders, submit
├── adjacent template is close  → copy closest, adapt deliberately (charter, lenses, sections)
└── no template is close        → use references/baseline-role-guide.md to build from scratch
```

In the hire comment, state which path you took so the board can audit the reasoning.

## Index

| Template | Use when hiring | Typical adapter |
|---|---|---|
| [`Coder`](agents/coder.md) | Software engineers who implement code, debug issues, write tests, and coordinate with QA/CTO | `codex_local`, `claude_local`, `cursor`, or another coding adapter |
| [`QA`](agents/qa.md) | QA engineers who reproduce bugs, validate fixes, capture screenshots, and report actionable findings | `claude_local` or another browser-capable adapter |
| [`UX Designer`](agents/uxdesigner.md) | Product designers who produce UX specs, review interface quality, and evolve the design system | `codex_local`, `claude_local`, or another adapter with repo/design context |

If you are hiring a role that is not in this index, do not force a fit. Use the adjacent-template path when one is genuinely close, or the generic fallback when none is.

## How to apply an exact template

1. Open the matching reference in `references/agents/`.
2. Copy that template into the new agent's instruction bundle (usually `AGENTS.md`). For hire requests using local managed-bundle adapters, set the adapted template as `adapterConfig.promptTemplate`; Paperclip materializes it into `AGENTS.md`.
3. Replace placeholders like `{{companyName}}`, `{{managerTitle}}`, `{{issuePrefix}}`, and URLs.
4. Remove tools or workflows the target adapter cannot use.
5. Keep the Paperclip heartbeat requirement and the task-comment requirement.
6. Add role-specific skills or reference files only when they are actually installed or bundled.
7. Run the pre-submit checklist before opening the hire: `references/draft-review-checklist.md`.

## How to apply an adjacent template

Use this when the requested role is close to an existing template but not the same (for example, "Backend Engineer" adapted from `coder.md`, "Content Designer" adapted from `uxdesigner.md`, or "Release Engineer" adapted from `qa.md`).

1. Start from the closest template.
2. Rewrite the role title, charter, and capabilities for the new role — do not leave the source role's framing in place.
3. Swap domain lenses to match the new discipline. Keep only lenses that actually apply.
4. Remove sections that do not fit (for example, drop the UX visual-quality bar from a backend engineer template).
5. Add any role-specific section the baseline role guide recommends but the source template omitted.
6. Note in the hire comment which template you adapted and what you changed, so future hires of the same role can start from your draft.
7. Run the pre-submit checklist.

## How to apply the generic fallback

Use this when no template is close. Open `references/baseline-role-guide.md` and follow its section outline. That guide is structured so a CEO or hiring agent can produce a usable `AGENTS.md` without asking the board for prompt-writing help. After drafting, run the pre-submit checklist.
