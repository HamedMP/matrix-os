# Implementation Plan: Zellij-Native Shell and Unified CLI

**Branch**: `068-zellij-cli` | **Date**: 2026-04-26 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/068-zellij-cli/spec.md`

## Summary

Unify Matrix OS around the published `matrix` CLI and a shared zellij-native session model. The gateway will expose authenticated session, tab, pane, layout, and terminal-attach surfaces backed by zellij in the user's container. `packages/sync-client` will become the only CLI, adding profile-aware commands, shell management commands, and a versioned daemon IPC contract for editor integrations. The plan preserves compatibility for the current web terminal endpoints until the browser shell migration lands in a later phase.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, ES modules, Node.js 24+
**Primary Dependencies**: Hono gateway, Hono WebSocket support, node-pty, zod/v4, citty, ws, Node child_process/fs/promises/path/crypto APIs, zellij 0.44.1 pinned in Docker images
**Storage**: Files under the owner-controlled Matrix home (`~/system/shell-sessions.json`, `~/system/layouts/*.kdl`) plus local CLI files under `~/.matrixos/profiles.json` and `~/.matrixos/profiles/<name>/`
**Testing**: Vitest unit/integration tests, focused contract tests, gateway WebSocket tests, CLI command tests, pattern scanner via `bun run check:patterns`
**Target Platform**: Linux user containers for gateway/zellij, Node CLI on developer/user machines, browser clients through the existing gateway, future VSCode integration via local daemon IPC plus direct WS attach
**Project Type**: Multi-package backend/CLI/docs feature in an existing monorepo
**Performance Goals**: Session list/control operations complete within 1s p95 locally; terminal attach first output within 2s p95 when the gateway is healthy; daemon one-shot IPC responses within 500ms p95; reconnect restores recent output for at least the configured replay window
**Constraints**: No unbounded fetch/process/IPC waits; all external calls and child processes bounded by timeout/signal; all mutating HTTP routes use bodyLimit; no raw internal errors to clients; all maps/sets/buffers have caps and eviction; file writes are atomic; no wildcard CORS; no globalThis cross-package communication
**Scale/Scope**: One owned container per personal OS instance in current deployment; per-container zellij sessions capped by configuration; multiple browser/CLI/editor clients may attach to the same owned session; v1 targets a small stable set of shell/profile/sync/instance commands before later browser-shell rewrite

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Data Belongs to Its Owner**: PASS. Session metadata, layouts, and CLI profiles live in owner-controlled files. No platform-owned terminal state is introduced.
- **AI Is the Kernel**: PASS. This feature changes shell/CLI access surfaces only and does not bypass the kernel for AI interactions.
- **Headless Core, Multi-Shell**: PASS. The session model is exposed through gateway/CLI/daemon contracts and is not coupled to the web shell renderer.
- **Self-Healing and Self-Expanding**: PASS. Diagnostics, reconnect behavior, atomic writes, and compatibility migration are part of the plan.
- **Quality Over Shortcuts**: PASS. The CLI and shell behavior are production surfaces with documented contracts, tests, and public docs.
- **App Ecosystem**: PASS. No new app sandbox bypass is introduced; layouts remain user-owned system data.
- **Multi-Tenancy**: PASS. Gateway operations scope to the authenticated user/container and must not expose cross-user session state.
- **Defense in Depth**: PASS with required implementation gates. Every new endpoint/WS/IPC operation has auth, input validation, timeout, resource-limit, and generic-error requirements below.
- **TDD**: PASS. Tasks must start with failing tests for gateway routes/WS, daemon IPC, CLI commands, migration, and contract formats before implementation.

## Project Structure

### Documentation (this feature)

```text
specs/068-zellij-cli/
|--- plan.md
|--- research.md
|--- data-model.md
|--- quickstart.md
|--- technical-design-draft.md
|--- checklists/
|   `--- requirements.md
|--- contracts/
|   |--- cli-contract.md
|   |--- daemon-ipc.md
|   |--- rest-api.md
|   `--- websocket-protocol.md
`--- tasks.md
```

### Source Code (repository root)

```text
packages/gateway/src/
|--- server.ts                         # route and WS registration
|--- shell/
|   |--- names.ts                      # session/layout/profile-safe name validation
|   |--- zellij.ts                     # bounded zellij child-process adapter
|   |--- registry.ts                   # atomic shadow registry + reconciliation
|   |--- layouts.ts                    # layout storage and validation
|   `--- routes.ts                     # session/tab/pane/layout HTTP handlers
|--- session-registry.ts               # kept for deprecated raw PTY compatibility
`--- ring-buffer.ts                    # bounded replay behavior reused/adapted

packages/sync-client/src/
|--- cli/
|   |--- index.ts                      # unified command tree
|   |--- output.ts                     # human/JSON/NDJSON formatting
|   |--- profiles.ts                   # profile resolution and global flags
|   `--- commands/
|       |--- profile.ts
|       |--- shell.ts
|       |--- status.ts
|       |--- doctor.ts
|       |--- instance.ts
|       `--- completion.ts
|--- daemon/
|   |--- ipc-handler.ts                # versioned control-plane verbs
|   |--- ipc-server.ts                 # versioned response/error envelope
|   `--- types.ts
|--- lib/
|   |--- config.ts                     # profile-aware config compatibility
|   |--- profiles.ts                   # profile file model + migration
|   `--- atomic-write.ts
`--- auth/
    `--- token-store.ts                # profile-scoped auth storage

tests/
|--- cli/
|   |--- profile.test.ts
|   |--- shell.test.ts
|   |--- json-output.test.ts
|   `--- legacy-config-migration.test.ts
|--- gateway/
|   |--- shell-routes.test.ts
|   |--- shell-registry.test.ts
|   |--- shell-layouts.test.ts
|   `--- terminal-zellij-ws.test.ts
`--- sync-client/
    `--- daemon-ipc-v1.test.ts

www/content/docs/guide/
|--- cli.mdx
`--- meta.json
```

**Structure Decision**: Keep gateway session control in `packages/gateway` because zellij runs in the user's container and gateway already owns terminal WebSocket behavior. Keep profile, CLI, daemon IPC, and JSON output contracts in `packages/sync-client` because it owns the published `@finnaai/matrix` package. Public user docs stay in `www/content/docs/guide`. Spec contracts stay under `specs/068-zellij-cli/contracts` and are mirrored into implementation tests.

## Defense-In-Depth Design Gates

### Auth Matrix

| Surface | Operation | Auth source | Public? | Notes |
|---------|-----------|-------------|---------|-------|
| Gateway HTTP | Session/tab/pane/layout list/read | Sync JWT bearer | No | Scope to caller's user container/home only |
| Gateway HTTP | Session/tab/pane/layout mutate | Sync JWT bearer + bodyLimit | No | Validate names, paths, sizes, and command payloads |
| Gateway WS | Browser terminal attach | Short-lived WS token from existing auth flow | No | Token in query string only for browser limitation |
| Gateway WS | CLI/editor terminal attach | Sync JWT bearer header | No | Prefer header auth over query token |
| Daemon IPC | Local profile/shell/sync verbs | Local socket permissions plus profile token where remote calls are needed | Local-only | Socket directory `0700`, socket `0600`; max connections and buffer caps |
| Platform HTTP | Instance info/restart/logs | Sync JWT mapped to caller container | No | Do not reuse platform-secret admin routes |

### Input Validation

- Session/layout/profile identifiers use a safe slug format: lowercase letter start, lowercase letters/digits/hyphen, maximum 31 characters for session/profile names and 64 for layouts unless a stricter local limit already exists.
- All filesystem paths are resolved within the user's home or Matrix config directory using existing `resolveSyncPathWithinHome`-style helpers.
- Layout content is capped before parsing/validation and validated by a bounded zellij layout-check path before atomic save.
- Command strings are only passed as subprocess arguments, never through a shell string. Prefer `execFile`/`spawn` with argument arrays.
- Daemon IPC requests are parsed through zod/v4 schemas per command and reject unknown or oversized payloads.

### Error Policy

- Client-visible errors use `{ code, message }` with stable generic messages.
- Raw zellij stderr, filesystem paths, token details, stack traces, and provider/internal names are logged server-side only.
- CLI human output may include recovery hints, but JSON output always uses stable codes.

### Resource Management

- Zellij control subprocesses use explicit timeouts and AbortSignal cancellation.
- Terminal replay buffers remain bounded by byte and entry count; dropped output is represented by a replay marker.
- Session registry maps have a configured maximum session count and deterministic eviction/rejection behavior.
- IPC connections and buffers keep existing caps or stricter caps where new streaming commands are added.
- Temporary layout validation files are removed in `finally` blocks and protected by max-age cleanup on startup.

### Atomicity And Failure Modes

- Session metadata and layout writes use write-temp-then-rename atomic writes.
- Registry reconciliation treats live zellij sessions as authoritative for existence and shadow metadata as authoritative only for Matrix-created labels/indices.
- Network calls stay outside file locks; locks guard only local metadata reads/writes.
- On partial session creation failure, created metadata is rolled back or marked orphaned and reconciled on next list.
- On layout save failure after validation, the previous layout remains intact.

## Phase 0: Research

Completed in [research.md](./research.md). All planning questions are resolved with no remaining `NEEDS CLARIFICATION` markers.

## Phase 1: Design And Contracts

Generated artifacts:

- [data-model.md](./data-model.md)
- [contracts/rest-api.md](./contracts/rest-api.md)
- [contracts/websocket-protocol.md](./contracts/websocket-protocol.md)
- [contracts/daemon-ipc.md](./contracts/daemon-ipc.md)
- [contracts/cli-contract.md](./contracts/cli-contract.md)
- [quickstart.md](./quickstart.md)

## Post-Design Constitution Check

- **Data ownership**: PASS. Files remain scoped to user-owned home/config paths.
- **Multi-shell architecture**: PASS. Browser, CLI, and editor attach through contracts rather than shared renderer state.
- **Defense in Depth**: PASS. Contracts include auth, validation, timeout, body limit, and generic error rules.
- **TDD**: PASS. Quickstart and future tasks identify test-first gates.
- **Documentation-driven development**: PASS. `www/content/docs/guide/cli.mdx` and `meta.json` are explicit deliverables.

## Complexity Tracking

No constitution violations require justification.
