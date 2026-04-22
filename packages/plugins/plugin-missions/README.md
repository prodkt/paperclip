# @paperclipai/plugin-missions

First-party Missions plugin package for the current Paperclip alpha plugin runtime.

This package now carries the installable mission workflow surface:

- manifest id `paperclip.missions`
- scoped plugin API routes under `/api/plugins/:pluginId/api/*`
- namespace migrations for mission-owned tables
- worker handlers for mission initialization, draft summary reads, and placeholder follow-up workflow routes
- package-local typecheck, test, and build verification

## Declared Surfaces

- API routes
  - `POST /issues/:issueId/missions/init`
  - `GET /issues/:issueId/missions/summary`
  - `POST /issues/:issueId/missions/decompose`
  - `POST /issues/:issueId/missions/advance`
  - `POST /issues/:issueId/missions/findings/:findingKey/waive`
  - `GET /missions`
- UI slots
  - plugin `page`
  - issue `taskDetailView`
  - issue `toolbarButton`
  - plugin `settingsPage`

## Alpha Workflow Notes

The mission detail UI exposes command metadata for initialize, decompose,
advance, and waive actions. Initialization is available from the UI in this
package. Decompose, advance, and waive remain intentionally disabled in the UI
until the follow-on workflow tickets land; the worker API routes are present so
agents and integration tests can exercise those flows directly during the alpha.

## Verify

From the repo root:

```bash
pnpm --filter @paperclipai/plugin-missions typecheck
pnpm --filter @paperclipai/plugin-missions test
pnpm --filter @paperclipai/plugin-missions build
```

Install the local package into a running Paperclip instance after a successful
build:

```bash
pnpm paperclipai plugin install ./packages/plugins/plugin-missions
```

The host loads `dist/manifest.js`, `dist/worker.js`, and `dist/ui/`, so install
after building. Plugin install is board-only in the current runtime; agent API
keys correctly receive `403 Board access required` for `/api/plugins/install`.
