# Data Model: Matrix OS macOS App

**Feature**: [086-macos-native-shell](./spec.md) · **Source of truth**: user's Postgres via gateway. No local durable store.

## Server (existing — reused, not redefined)

- **Task** (`task-manager`): `id, projectSlug, title, description?, status(todo|running|waiting|blocked|complete|archived), priority(low|normal|high|urgent), order, parentTaskId?, linkedSessionId?, linkedWorktreeId?, previewIds[], createdAt, updatedAt, revision`.
- **Session** (session orchestrator + zellij registry): `id/name, status(active|exited), cwd, layoutName?, tabs[]`.
- **WorkspaceEvent**: `type(task.created|task.updated|…), scope{projectSlug,taskId}, payload, seq/ts`.

## Server delta (net-new, only if in v1 scope)

- **Task.tags**: `tags: string[]?` (≤ N tags, each `SAFE_SLUG`, validated at route boundary; Kysely migration on owner Postgres). If deferred, labels are out of v1.

## Client view models (in-memory, bounded — never persisted)

| Model | Fields | Notes |
|---|---|---|
| `Card` | maps Task 1:1 + derived `liveBadge`, `lastOutputLine?` | value type; diff-updated from events |
| `SessionRef` | `id, status, tabs[], cwd` | from session/zellij |
| `Panel` | `.terminal \| .shell \| .app(slug)` | client-only UI state |
| `ConnectionProfile` | `handle, gatewayEndpoint, selectedVpsId, credentialRef(Keychain)` | only Keychain ref persists |
| `TerminalBuffer` | `lastSeq, ringBuffer(cap)` | capped + evicted (R1) |

## Invariants

- One Card ↔ at most one `linkedSessionId`. Creating a card may create a session; archiving defaults to **detach** (session survives) — terminate requires explicit confirm.
- Board writes are **revision-guarded** in the UPDATE (optimistic concurrency); stale writers refresh.
- Column = Task.status; intra-column position = Task.order. Moving a card = status/order PATCH (atomic).
- Live badge derives from Session.status + workspace events; never stored client-side as truth.
- Tags (if shipped) validated server-side; client never trusts its own cache as authority.
