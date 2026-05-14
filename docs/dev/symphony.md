# Matrix Symphony

Symphony is the Matrix-native coding-agent runner for Linear and Matrix-native
tickets. It runs in the gateway, uses Matrix-owned projects/worktrees/sessions,
and exposes one first-party app at `home/apps/symphony`.

The legacy external runner path is no longer the product surface. Keep temporary
compatibility exports only for imports that have not moved yet.

## Runtime Shape

- API base: `/api/symphony`
- App: `home/apps/symphony`
- Backend module: `packages/gateway/src/symphony/`
- Durable state: owner Postgres through `KyselySymphonyRepository`
- Linear API secrets: server-side credential store under
  `~/system/symphony/credentials/`, written atomically with `0600` permissions
- Work execution: `createWorktreeManager()` plus `createAgentSessionManager()`
- Desktop execution policy: cloud-only; Matrix Desktop must not start local
  coding-agent processes

Normal browser responses expose only `credentialConfigured`; they must never
include Linear API keys, Pipedream secrets, raw provider errors, database errors,
or filesystem paths.

## Main Endpoints

- `GET /api/symphony/status`
- `GET /api/symphony/config`
- `POST /api/symphony/config`
- `POST /api/symphony/credentials/linear`
- `DELETE /api/symphony/credentials/linear`
- `GET /api/symphony/tickets/preview`
- `GET /api/symphony/runs`
- `POST /api/symphony/tickets/assign`
- `POST /api/symphony/start`
- `POST /api/symphony/stop`
- `POST /api/symphony/runs/:runId/actions`
- `GET /api/symphony/events`

Every mutating route uses `bodyLimit`, Zod boundary schemas, request-principal
auth, generic client errors, and operator events.

## Operator Flow

1. Owner opens Symphony in Matrix.
2. Owner adds a server-side Linear API secret or uses a connected Linear account
   path when available.
3. Owner saves the Matrix project, Linear team, labels, active/terminal states,
   and selected Linear assignee IDs.
4. Symphony previews matching tickets.
5. Starting Symphony polls Linear, creates/reuses deterministic Matrix
   worktrees, acquires the worktree lease, starts an agent session, and records
   run state for restart recovery.

## Desktop Assignment Flow

Matrix Desktop surfaces Symphony through Workspace and the first-party Symphony
app. A user can assign a Linear or Matrix-native ticket to Symphony; the
orchestrator checks claim authorization before reading or mutating repository
state, then creates or reuses the cloud worktree/session claim.

The desktop app may observe, take over, retry, or stop cloud sessions through
Matrix APIs. It must not expose a local-agent runtime toggle or local process
launcher.

## Shared Board Authorization

Shared board membership lives under `packages/gateway/src/boards/` and is backed
by owner Postgres when Kysely is available. Ticket routes accept an injected
project-access authorizer, and Symphony accepts an injected ticket-claim
authorizer. This keeps ticket reads and per-user Symphony claims behind the same
board permission boundary.

Current role meanings:

- `viewer`: can read the shared board.
- `editor`: can read the shared board and claim authorized work.
- owner: implicit for the project owner.

## Validation

Focused checks:

```bash
bun run test \
  tests/gateway/symphony-credential-store.test.ts \
  tests/gateway/symphony-repository.test.ts \
  tests/gateway/symphony-status-hub.test.ts \
  tests/gateway/symphony-linear-source.test.ts \
  tests/gateway/symphony-orchestrator.test.ts \
  tests/gateway/symphony-routes.test.ts \
  tests/gateway/symphony-workflow.test.ts \
  tests/gateway/symphony-restart-recovery.test.ts \
  tests/gateway/shared-board-auth.test.ts \
  tests/gateway/shared-board-membership.test.ts \
  tests/default-apps/symphony-app.test.tsx
```

Pre-PR gates remain:

```bash
bun run typecheck
bun run check:patterns
bun run test
```
