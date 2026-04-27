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

- [x] T100 Add failing unit and integration tests for project CRUD, GitHub URL validation, slug conflicts, clone staging cleanup, worktree leases, op-log recovery, and owner-scoped workspace export/delete.
  - Files: `tests/gateway/project-manager.test.ts`, `tests/gateway/worktree-manager.test.ts`, `tests/gateway/state-ops.test.ts`, `tests/gateway/workspace-routes.test.ts`

- [x] T101 Implement `project-manager.ts` for project CRUD, GitHub URL validation, slug generation, safe clone staging, GitHub auth status, PR listing, and branch listing.
  - Files: `packages/gateway/src/project-manager.ts`

- [x] T102 Implement `worktree-manager.ts` for branch/PR worktrees, stable `wt_` IDs, dirty-state detection, safe deletion, and write leases.
  - Files: `packages/gateway/src/worktree-manager.ts`

- [x] T103 Implement `state-ops.ts` for atomic writes, operation logs, per-project locks, startup replay, index rebuild, and export/delete helpers.
  - Files: `packages/gateway/src/state-ops.ts`

- [x] T104 Add gateway API routes for projects, GitHub status, branches, PRs, worktrees, workspace export, and workspace data deletion.
  - Files: `packages/gateway/src/workspace-routes.ts`, `packages/gateway/src/server.ts`

- [x] T105 Add CLI project/worktree/export/delete commands.
  - Files: `bin/cli.ts`, `bin/matrixos.ts`, `tests/cli/cli.test.ts`

- [x] T106 Complete green/refactor coverage for project manager, worktree manager, clone staging, validation, leases, op-log recovery, and export/delete scoping.
  - Commands: `pnpm exec vitest run tests/cli/cli.test.ts tests/gateway/project-manager.test.ts tests/gateway/state-ops.test.ts tests/gateway/worktree-manager.test.ts tests/gateway/workspace-routes.test.ts`

### Agent Sessions / Runtime Bridge

- [x] T200 Add failing unit and integration tests for agent detection, launch argv construction, Zellij/tmux fallback, session lifecycle, attach/replay, lease conflicts, observe/takeover, transcript retention, and sandbox diagnostics.
  - Files: `tests/gateway/agent-launcher.test.ts`, `tests/gateway/zellij-runtime.test.ts`, `tests/gateway/agent-session-manager.test.ts`, `tests/gateway/session-runtime-bridge.test.ts`, `tests/gateway/session-transcript.test.ts`, `tests/gateway/agent-sandbox.test.ts`, `tests/gateway/workspace-routes.test.ts`, `tests/cli/cli.test.ts`

- [x] T201 Implement `agent-launcher.ts` for Claude, Codex, OpenCode, and Pi detection plus launch command construction.
  - Files: `packages/gateway/src/agent-launcher.ts`, `tests/gateway/agent-launcher.test.ts`

- [x] T202 Implement `zellij-runtime.ts` for generated layouts, start/attach/observe/kill, health checks, and degraded fallback metadata.
  - Files: `packages/gateway/src/zellij-runtime.ts`, `tests/gateway/zellij-runtime.test.ts`
- [x] T203 Implement `agent-session-manager.ts` for session records, lifecycle, worktree lease integration, send/kill/list/get, and startup reconciliation.
  - Files: `packages/gateway/src/agent-session-manager.ts`, `tests/gateway/agent-session-manager.test.ts`
- [x] T204 Implement `session-runtime-bridge.ts` to register external Zellij/tmux sessions with the terminal registry.
  - Files: `packages/gateway/src/session-runtime-bridge.ts`, `packages/gateway/src/session-registry.ts`, `tests/gateway/session-runtime-bridge.test.ts`
- [x] T205 Implement `session-transcript.ts` for durable JSONL replay, 10,000-line/5 MiB hot replay caps, 100 MiB or 30-day retention, truncation, export, and rehydration.
  - Files: `packages/gateway/src/session-transcript.ts`, `tests/gateway/session-transcript.test.ts`
- [x] T206 Implement `agent-sandbox.ts` for sandbox preflight and fail-closed Codex-style launches.
  - Files: `packages/gateway/src/agent-sandbox.ts`, `tests/gateway/agent-sandbox.test.ts`
- [x] T207 Add gateway API and CLI commands for sessions, observe/takeover, native terminal handoff, and sandbox status.
  - Files: `packages/gateway/src/workspace-routes.ts`, `bin/cli.ts`, `bin/matrixos.ts`, `tests/gateway/workspace-routes.test.ts`, `tests/cli/cli.test.ts`
- [x] T208 Complete green/refactor coverage for session lifecycle, runtime fallback, attach/replay, leases, observe/takeover, transcripts, and sandbox diagnostics.
  - Commands: `pnpm exec vitest run tests/gateway/agent-sandbox.test.ts tests/gateway/session-transcript.test.ts tests/gateway/session-runtime-bridge.test.ts tests/gateway/session-registry.test.ts tests/gateway/agent-session-manager.test.ts tests/gateway/zellij-runtime.test.ts tests/gateway/agent-launcher.test.ts tests/gateway/worktree-manager.test.ts tests/gateway/state-ops.test.ts tests/gateway/project-manager.test.ts tests/gateway/workspace-routes.test.ts tests/cli/cli.test.ts`

### Review Loop Engine

- [ ] T300 Add failing unit and integration tests for findings parsing, legal/illegal review transitions, convergence, stall, parse failure, verification failure, operator stop/approve, max-round limits, and recovery from partial writes.
  - Partial: `tests/gateway/findings-parser.test.ts` covers structured findings parsing, zero-finding convergence input, parse failure states, unsafe paths, and file parsing.
- [x] T301 Implement `findings-parser.ts` for structured markdown findings and explicit parse failure states.
  - Files: `packages/gateway/src/findings-parser.ts`, `tests/gateway/findings-parser.test.ts`
- [ ] T302 Implement `review-loop.ts` state machine for reviewer/implementer rounds, control files, convergence gates, failures, stop/next/approve, and max rounds.
- [ ] T303 Add review prompts and atomic `.matrix/review-round-{N}.json` control-file protocol.
- [ ] T304 Persist review records under `~/system/reviews/{reviewId}.json`.
- [ ] T305 Add gateway API and CLI commands for review start/status/watch/next/approve/stop.
- [ ] T306 Complete green/refactor coverage for convergence, stall, parse failure, verification failure, illegal transitions, and recovery from partial writes.

### Tasks / Events / Previews

- [ ] T400 Add failing unit and integration tests for task lifecycle, ordering, archive, session/worktree links, bounded activity eviction, preview validation, preview caps, stale links, export manifests, and delete scoping.
- [ ] T401 Implement `task-manager.ts` for task CRUD, ordering, archive, status, parent/child links, and session/worktree links.
- [ ] T402 Implement `workspace-events.ts` for project/task/session/review/preview event updates capped at 5,000 hot events per user with cursor pagination and eviction.
- [ ] T403 Implement `preview-manager.ts` for saved preview URLs, URL detection from session output, validation, 100-per-project and 20-per-task caps, 10 second probes, and recoverable failure states.
- [ ] T404 Add API and CLI support for tasks, previews, workspace export, and workspace data deletion.
- [ ] T405 Complete green/refactor coverage for task lifecycle, event fanout, preview validation, stale link behavior, export manifests, and delete scoping.

### Web Workspace / Terminal Cockpit / TUI

- [ ] T500 Add failing web, desktop, and TUI tests for project/task layout, attach/reconnect behavior, event convergence, browser IDE file edit/save persistence, large-list virtualization for 100 projects and 1,000 tasks, and mobile/desktop rendering.
- [ ] T501 Build Matrix-native workspace app with project list, project detail, task board/list, git/worktree panel, sessions panel, review panel, preview panel, and browser IDE launch links.
- [ ] T502 Update terminal cockpit to use `/api/sessions` as the coding-session source of truth and terminal registry only as transport.
- [ ] T503 Add attach, observe, takeover, kill, duplicate pane, local-terminal handoff, transcript search, and session health UI.
- [ ] T504 Build Ink TUI dashboard and `matrixos` no-subcommand entry point.
- [ ] T505 Complete green/refactor coverage for layout, attach/reconnect behavior, event convergence, browser IDE file-operation persistence, large-list responsiveness, and mobile/desktop rendering.

### Docker / Recovery / Docs

- [ ] T600 Add failing startup, health, and documentation-gate tests for required runtime tools, workspace directory ownership, recovery order, sanitized health output, and public docs presence.
- [ ] T601 Ensure final container includes Zellij, tmux, gh, openssh-client, sandbox tooling, agent CLIs, git, and code-server.
- [ ] T602 Create required workspace directories at startup with correct ownership.
- [ ] T603 Implement startup recovery order for state ops, projects, worktree leases, runtime sessions, bridges, transcripts, reviews, browser IDE health, and preview detection.
- [ ] T604 Extend `/health` with workspace manager, session, review, sandbox, and browser IDE status.
- [ ] T605 Add public docs for cloud coding, GitHub auth, data ownership, worktrees, session sharing, review loops, browser IDE, and sandboxing.
