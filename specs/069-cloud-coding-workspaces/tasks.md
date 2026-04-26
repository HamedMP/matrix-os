# Tasks: Cloud Coding Workspaces

This task list is the implementation handoff for feature `069-cloud-coding-workspaces`. It records work already present in the current worktree so future agents do not redo it.

## Current Worktree Snapshot

As of 2026-04-26, the worktree contains a deployed implementation slice for the authenticated browser IDE / `code.matrix-os.com` proxy path.

Modified implementation files currently present:

- `Dockerfile`
- `Dockerfile.dev`
- `distro/cloudflared.yml`
- `distro/docker-compose.platform.yml`
- `distro/docker-dev-entrypoint.sh`
- `distro/docker-entrypoint.sh`
- `docs/dev/vps-deployment.md`
- `packages/platform/src/main.ts`
- `packages/platform/src/orchestrator.ts`
- `packages/platform/src/ws-upgrade.ts`
- `tests/platform/proxy-routing.test.ts`
- `tests/platform/ws-upgrade.test.ts`

Untracked support/spec files currently present:

- `.specify/feature.json`
- `scripts/open-feature-worktree-tab.sh`
- `specs/069-cloud-coding-workspaces/`

## Completed / Already Started In This Worktree

- [x] T001 Add code-server build stage to production image using Node 22 runtime isolated from Matrix's Node 24 runtime.
  - Files: `Dockerfile`

- [x] T002 Add code-server build stage to development image using the same isolated Node 22 runtime.
  - Files: `Dockerfile.dev`

- [x] T003 Install code-server wrapper and expose `MATRIX_CODE_SERVER_PORT=8787` in production and development images.
  - Files: `Dockerfile`, `Dockerfile.dev`

- [x] T004 Start code-server in the production container entrypoint as the non-root `matrixos` user with auth disabled because Matrix platform proxy owns public auth.
  - Files: `distro/docker-entrypoint.sh`

- [x] T005 Start and supervise code-server in the development container entrypoint alongside shell and gateway processes.
  - Files: `distro/docker-dev-entrypoint.sh`

- [x] T006 Add `code.matrix-os.com` Cloudflare/platform routing documentation and tunnel ingress.
  - Files: `distro/cloudflared.yml`, `distro/docker-compose.platform.yml`, `docs/dev/vps-deployment.md`

- [x] T007 Add `code.matrix-os.com` host recognition and session-routed WebSocket host support.
  - Files: `packages/platform/src/ws-upgrade.ts`, `tests/platform/ws-upgrade.test.ts`

- [x] T008 Route authenticated `code.matrix-os.com` HTTP requests to each user's private container code-server port.
  - Files: `packages/platform/src/main.ts`, `packages/platform/src/orchestrator.ts`

- [x] T009 Add short-lived `matrix_code_session` cookie support so editor subresource and WebSocket follow-up requests can authenticate without requiring Clerk verification on every asset request.
  - Files: `packages/platform/src/main.ts`, `tests/platform/proxy-routing.test.ts`

- [x] T010 Preserve editor asset/cache behavior so unauthenticated protected editor responses do not return cacheable auth HTML that can poison JavaScript, worker, font, icon, or service worker loads.
  - Files: `packages/platform/src/main.ts`, `tests/platform/proxy-routing.test.ts`
  - Notes: code-server application static assets are proxied from the user's private editor port, but the platform forces `Cache-Control: no-store, private`, `CDN-Cache-Control: no-store`, and `Cloudflare-CDN-Cache-Control: no-store` so Cloudflare cannot retain auth HTML under editor bundle URLs.

- [x] T011 Strip Matrix platform credentials before proxying code-domain requests into code-server and preserve forwarded host/proto headers.
  - Files: `packages/platform/src/main.ts`, `tests/platform/proxy-routing.test.ts`

- [x] T012 Route code-domain WebSocket upgrades to the private code-server port while keeping app-domain WebSocket upgrades on the gateway port.
  - Files: `packages/platform/src/main.ts`, `packages/platform/src/ws-upgrade.ts`, `tests/platform/ws-upgrade.test.ts`

- [x] T013 Install missing `@vscode/fs-copyfile` dependency into code-server's bundled Git extension so the built-in Git extension activates in the browser IDE.
  - Files: `Dockerfile`, `Dockerfile.dev`

## Browser IDE Slice Verification

- [x] T014 Run platform proxy and WebSocket tests for the code-domain changes.
  - Command: `pnpm exec vitest run tests/platform/proxy-routing.test.ts tests/platform/ws-upgrade.test.ts`
  - Result: 2 files passed, 18 tests passed.

- [x] T015 Run platform typecheck and whitespace verification.
  - Commands: `node /home/deploy/matrix-os/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc --noEmit -p packages/platform/tsconfig.typecheck.json`; `git diff --check`
  - Result: both passed.

- [x] T016 Build and smoke-test the Docker image with code-server installed.
  - Command: Docker build tagged `matrixos-user:local`.
  - Result: image contains code-server `4.116.0` and `@vscode/fs-copyfile@2.0.0`.
  - Relevant files: `Dockerfile`, `Dockerfile.dev`, `distro/docker-entrypoint.sh`, `distro/docker-dev-entrypoint.sh`

- [x] T017 Manually verify `https://code.matrix-os.com/?folder=/home/matrixos/home` after deployment.
  - Result: authenticated editor opens through the platform proxy; WebSockets connect; service worker, JavaScript modules, worker modules, and codicon font return real code-server bytes with `cf-cache-status: BYPASS` after the cache-control fix.
  - Operational note: Cloudflare cache entries poisoned before the fix may require a one-time cache purge for `code.matrix-os.com`.

## Remaining Major Implementation Work

### Project / GitHub / Worktree Foundation

- [ ] T101 Implement `project-manager.ts` for project CRUD, GitHub URL validation, slug generation, safe clone staging, GitHub auth status, PR listing, and branch listing.
- [ ] T102 Implement `worktree-manager.ts` for branch/PR worktrees, stable `wt_` IDs, dirty-state detection, safe deletion, and write leases.
- [ ] T103 Implement `state-ops.ts` for atomic writes, operation logs, per-project locks, startup replay, and index rebuild.
- [ ] T104 Add gateway API routes for projects, GitHub status, branches, PRs, and worktrees.
- [ ] T105 Add CLI project/worktree commands.
- [ ] T106 Add unit and integration tests for project manager, worktree manager, clone staging, validation, leases, and op-log recovery.

### Agent Sessions / Runtime Bridge

- [ ] T201 Implement `agent-launcher.ts` for Claude, Codex, OpenCode, and Pi detection plus launch command construction.
- [ ] T202 Implement `zellij-runtime.ts` for generated layouts, start/attach/observe/kill, health checks, and degraded fallback metadata.
- [ ] T203 Implement `agent-session-manager.ts` for session records, lifecycle, worktree lease integration, send/kill/list/get, and startup reconciliation.
- [ ] T204 Implement `session-runtime-bridge.ts` to register external Zellij/tmux sessions with the terminal registry.
- [ ] T205 Implement `session-transcript.ts` for durable JSONL replay, retention, truncation, export, and rehydration.
- [ ] T206 Implement `agent-sandbox.ts` for sandbox preflight and fail-closed Codex-style launches.
- [ ] T207 Add gateway API and CLI commands for sessions, observe/takeover, native terminal handoff, and sandbox status.
- [ ] T208 Add tests for session lifecycle, runtime fallback, attach/replay, leases, observe/takeover, transcripts, and sandbox diagnostics.

### Review Loop Engine

- [ ] T301 Implement `findings-parser.ts` for structured markdown findings and explicit parse failure states.
- [ ] T302 Implement `review-loop.ts` state machine for reviewer/implementer rounds, control files, convergence gates, failures, stop/next/approve, and max rounds.
- [ ] T303 Add review prompts and atomic `.matrix/review-round-{N}.json` control-file protocol.
- [ ] T304 Persist review records under `~/system/reviews/{reviewId}.json`.
- [ ] T305 Add gateway API and CLI commands for review start/status/watch/next/approve/stop.
- [ ] T306 Add tests for convergence, stall, parse failure, verification failure, illegal transitions, and recovery from partial writes.

### Tasks / Events / Previews

- [ ] T401 Implement `task-manager.ts` for task CRUD, ordering, archive, status, parent/child links, and session/worktree links.
- [ ] T402 Implement `workspace-events.ts` for bounded project/task/session/review/preview event updates.
- [ ] T403 Implement `preview-manager.ts` for saved preview URLs, URL detection from session output, validation, and recoverable failure states.
- [ ] T404 Add API and CLI support for tasks and previews.
- [ ] T405 Add tests for task lifecycle, event fanout, preview validation, and stale link behavior.

### Web Workspace / Terminal Cockpit / TUI

- [ ] T501 Build Matrix-native workspace app with project list, project detail, task board/list, git/worktree panel, sessions panel, review panel, preview panel, and browser IDE launch links.
- [ ] T502 Update terminal cockpit to use `/api/sessions` as the coding-session source of truth and terminal registry only as transport.
- [ ] T503 Add attach, observe, takeover, kill, duplicate pane, local-terminal handoff, transcript search, and session health UI.
- [ ] T504 Build Ink TUI dashboard and `matrixos` no-subcommand entry point.
- [ ] T505 Add web, desktop, and TUI tests for layout, attach/reconnect behavior, event convergence, and mobile/desktop rendering.

### Docker / Recovery / Docs

- [ ] T601 Ensure final container includes Zellij, tmux, gh, openssh-client, sandbox tooling, agent CLIs, git, and code-server.
- [ ] T602 Create required workspace directories at startup with correct ownership.
- [ ] T603 Implement startup recovery order for state ops, projects, worktree leases, runtime sessions, bridges, transcripts, reviews, browser IDE health, and preview detection.
- [ ] T604 Extend `/health` with workspace manager, session, review, sandbox, and browser IDE status.
- [ ] T605 Add public docs for cloud coding, GitHub auth, data ownership, worktrees, session sharing, review loops, browser IDE, and sandboxing.
