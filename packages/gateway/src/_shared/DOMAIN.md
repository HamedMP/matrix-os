# DOMAIN: `_shared` — gateway infrastructure with no domain rules

Dependency direction: every domain may import `_shared`. `_shared` must
**never** import a domain (or `server.ts` / `routes/`). Violations will fail
the boundary check (Phase 1-A3.0 follow-up).

## Contents

| Module | Provides |
|---|---|
| `logger.ts` | Gateway logger + interaction logger factory |
| `http-body.ts` | Shared body helpers |
| `ring-buffer.ts` | Bounded ring buffer |
| `path-security.ts` | `resolveWithinPrefix`-style path validation |
| `forward-ws.ts` | WS forwarding primitives |
| `postgres-manager.ts` | Owner Postgres lifecycle helpers |
| `bounded-json-file.ts` | Size-capped JSON file store |
| `bounded-operation.ts` | Bounded async operation helper |

## Decision log

- 2026-09-16 (Phase 1-A3/W1): `platform-db.ts` deliberately NOT moved here —
  Phase 2 deletes the Gateway→Platform direct-SQL path entirely; moving it
  now would just churn the diff.
- `state-ops.ts` placed in `domains/files`, not here: it is app-state file
  ops with domain semantics, not generic infra.
