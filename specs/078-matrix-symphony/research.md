# Research: Matrix Symphony

## Decision 1: Matrix-native orchestrator replaces the normal external runner path

**Decision**: Implement one gateway-owned Symphony orchestrator that directly uses Matrix project, worktree, and agent-session managers. Consolidate the existing external runner wrapper into the Matrix-native path instead of keeping a second normal product surface.

**Rationale**: The user wants coding agents and worktrees to run inside Matrix and a Matrix dashboard to show their status. The current external runner can poll Linear, but it requires a gateway environment `LINEAR_API_KEY`, separate dashboard URL, and runner path/binary configuration. That keeps the hard parts outside Matrix.

**Alternatives considered**:
- Keep the Elixir runner and wrap it in a nicer UI: rejected because credentials, run state, and worktree/session control remain split.
- Ship both a Matrix runner and an external runner dashboard: rejected because Matrix users need one world-class Symphony app and runner, not two competing setup paths.
- Vendor the upstream runner: rejected because it duplicates Matrix workspace/session primitives and complicates ownership/runtime.

## Decision 2: Store durable Symphony state in owner Postgres through Kysely

**Decision**: Use owner-controlled Postgres/Kysely for Symphony installation config, runs, claims, and operator events. Files remain for repo workflow contracts and optional export snapshots.

**Rationale**: The constitution requires new durable app/workspace data to use PostgreSQL via Kysely. Run state needs queryable filtering, restart recovery, status grouping, and concurrency checks that fit relational storage.

**Alternatives considered**:
- Continue with `~/system/symphony.json`: rejected for run metadata because it is not enough for multi-run status, concurrent claims, and restart reconciliation.
- Add SQLite or another embedded store: rejected by repo rules.

## Decision 3: Support both Matrix integration connection and server-side Linear API secret

**Decision**: The normal setup accepts an existing Matrix Linear integration connection; an advanced owner-only path stores a Linear API secret server-side for runner/source use. Browser-visible config contains only credential presence/reference.

**Rationale**: The current app can connect Linear through `/api/integrations`, but the existing runner requires `LINEAR_API_KEY`. The user specifically asked to easily and securely add their Linear secret. Supporting both paths lets the current team unblock quickly without exposing tokens in app state.

**Alternatives considered**:
- Require Pipedream/OAuth only: rejected because unattended background polling may need a service-style credential and the user explicitly mentioned a Linear secret.
- Require env vars only: rejected because it is not easy or Matrix-first.

## Decision 4: Linear filtering must include assignee IDs

**Decision**: Extend the Linear integration/source query to filter by selected assignee IDs in addition to team, project, label, and state.

**Rationale**: The current registry returns issue assignees but does not filter by assignee. The requested product behavior is "tickets that are assigned to people I choose."

**Alternatives considered**:
- Client-side assignee filtering after broad issue fetch: acceptable as fallback but inefficient and can miss matches under page caps.
- Label-only dispatch like upstream customization: rejected as insufficient for teammate selection.

## Decision 5: Use existing worktree leases as the duplicate-claim guard

**Decision**: Symphony creates deterministic ticket worktree branches/IDs and acquires existing Matrix worktree leases before starting agent sessions; repository-level run claims mirror the lease state for dashboard/recovery.

**Rationale**: Worktree leases already protect agent sessions from colliding in the same workspace. Using them avoids a second concurrency mechanism.

**Alternatives considered**:
- Independent Symphony lock files: rejected because they can diverge from Matrix session/worktree state.
- Rely only on DB run status: rejected because agent sessions already enforce worktree-level ownership.

## Decision 6: Dashboard-first UX with advanced tools hidden

**Decision**: Replace the current setup-heavy layout with queue/running/attention/handoff dashboard and a settings drawer for rules/credentials. Remove raw GraphQL from the default workflow.

**Rationale**: The user said the current UI is too much. Operators need status and controls first, not runner command lines, paths, and raw GraphQL.

**Alternatives considered**:
- Keep all controls visible but restyle them: rejected because information architecture, not styling, is the main problem.
