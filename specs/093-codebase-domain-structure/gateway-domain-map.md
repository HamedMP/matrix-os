# Gateway Domain Map (worked example)

Proposed target layout for `packages/gateway/src` — **86 flat `.ts` files + 19 sub-folders** grouped into domains.

> **Verified against `origin/main` @ `c6efa3f8` (2026-06-16):** 86 flat top-level `.ts` files, 19 sub-folders. Delta since first draft: `icon-routes.ts` added (now in `apps`).
>
> **Status: PROPOSED.** Grouping is inferred from filenames and the existing sub-folders, not from reading every file. Rows marked **⚠︎ provisional** need a quick confirm during migration; the final call is recorded in that domain's `DOMAIN.md` decision log. This map exists to make the spec concrete and to size the work — not as a binding placement.

## Target shape

```
packages/gateway/src/
├── index.ts  main.ts  server.ts        # app / bootstrap (stay at root)
├── routes/  config/                     # composition (existing)
├── _shared/                             # infra, no domain rules
└── domains/
    ├── apps/        sessions/   workspace/
    ├── files/       git/        review/
    ├── social/      voice/      identity/
    ├── observability/  scheduling/  integrations/
    ├── channels/    symphony/   onboarding/   plugins/
```

## Domain → files

### `domains/apps/` — app lifecycle, manifests, per-app data bridge
`apps.ts` · `app-manager.ts` · `app-ops.ts` · `app-manifest.ts` · `app-fork.ts` · `app-publish.ts` · `app-upload.ts` · `default-icons.ts` · `icon-routes.ts` · `app-runtime/`
**Sub-cluster `apps/db/`** (per-app Postgres bridge): `app-db.ts` · `app-db-kv.ts` · `app-db-migration.ts` · `app-db-query.ts` · `app-db-registry.ts` · `app-db-types.ts` · `bridge-sql.ts`
⚠︎ `preview-manager.ts` (app preview — could be its own `preview` domain) · `icon-routes.ts` (icon serving — apps vs files/_shared)

### `domains/sessions/` — agent sessions, conversations, dispatch
`agent-launcher.ts` · `agent-sandbox.ts` · `agent-session-manager.ts` · `session-registry.ts` · `session-runtime-bridge.ts` · `session-store.ts` · `session-transcript.ts` · `conversation-run-registry.ts` · `conversation-summary.ts` · `conversations.ts` · `approval.ts` · `prompt-validation.ts`
⚠︎ `dispatcher.ts` (message routing — sessions vs app-layer) · `pty.ts` / `zellij-runtime.ts` (terminal runtime — could be a `terminal` domain or under `workspace`)

### `domains/workspace/` — workspace docs, tasks, projects, orchestration
`workspace-event-publisher.ts` · `workspace-events.ts` · `workspace-routes.ts` · `workspace-session-orchestrator.ts` · `workspace-startup-recovery.ts` · `task-manager.ts` · `project-manager.ts` · `projects.ts`
⚠︎ `worktree-manager.ts` (workspace vs git) · `canvas/` (shell canvas backend vs workspace)

### `domains/files/` — file ops, tree, search, blobs, sync
`file-ops.ts` · `file-utils.ts` · `files-tree.ts` · `file-search.ts` · `file-blob-routes.ts` · `file-fallbacks.ts` · `trash.ts` · `watcher.ts` · `storage-tracker.ts` · `s3-sync.ts` · `sync/`
⚠︎ `state-ops.ts` (generic state file ops — files vs _shared)

### `domains/git/` — git state & versioning
`git-env.ts` · `git-sync.ts` · `git-versioning.ts`
⚠︎ `worktree-manager.ts` (shared with workspace — pick one owner)

### `domains/review/` — code-review loop
`review-control.ts` · `review-loop.ts` · `review-store.ts` · `findings-parser.ts`

### `domains/social/` — social graph, activity, messaging
`social.ts` · `social-activity.ts` · `leaderboard.ts` · `social-connectors/` · `messages/`
⚠︎ `matrix-client.ts` (Matrix-protocol client — social/messaging vs identity)

### `domains/voice/` — voice & vocal
`voice.ts` · `voice/` · `vocal/`

### `domains/identity/` — auth & request principal
`auth.ts` · `auth-jwt.ts` · `request-principal.ts` · `security/`

### `domains/observability/` — gateway-local telemetry
`ai-analytics.ts` · `metrics.ts` · `client-error-log.ts` · `memory-extractor.ts` · `system-info.ts` · `system-update.ts` · `system-activity/`
(Note: distinct from `packages/observability`; this is the gateway's local emission. Confirm whether some should move to that package instead.)

### `domains/scheduling/` — periodic triggers
`cron/` · `heartbeat/`

### Already-foldered domains (keep, add `DOMAIN.md`)
`integrations/` · `channels/` · `symphony/` (+ `symphony-runner.ts`) · `onboarding/` · `plugins/`

### `_shared/` — infra, never imports a domain
`logger.ts` · `http-body.ts` · `ring-buffer.ts` · `path-security.ts` · `ws-message-schema.ts` · `forward-ws.ts` · `postgres-manager.ts` · `platform-db.ts`

### App / bootstrap (stay at `src/` root)
`index.ts` · `main.ts` · `server.ts` · `routes/` · `config/`
⚠︎ `provisioner.ts` (VPS provisioning — likely a **platform** concern leaking into gateway; flag for review, may belong in `packages/platform`)

## Coupling estimate (suggested migration order)

Migrate lowest-coupling domains first so early PRs are trivial and de-risk the convention:

| Wave | Domains | Why first/last |
|------|---------|----------------|
| 1 | `review`, `voice`, `social`, `git`, `scheduling`, `observability` | Self-contained, few inbound deps. Proves the pattern + the lint rule cheaply. |
| 2 | `files`, `identity`, `apps/db` | Moderate fan-in; well-bounded. |
| 3 | `apps`, `sessions`, `workspace` | Highest coupling and most files; do last, once the convention + `_shared` are settled. |

Each wave = one or more PRs within Matrix's ≤50-file / ≤3000-addition limit. Every PR is `git mv` + import-path fixes + the domain's `DOMAIN.md`; **no logic edits**, tests unchanged.

## Open questions to resolve before Wave 1
1. `worktree-manager` → `git` or `workspace`?
2. `pty` / `zellij-runtime` → new `terminal` domain, or under `sessions`/`workspace`?
3. `provisioner` → stays in gateway or moves to `packages/platform`?
4. `matrix-client` → `social` or `identity`?
5. Does any of `observability/*` belong in `packages/observability` instead of a gateway domain?
6. `icon-routes` / `default-icons` → `apps` or `files`/`_shared`?
