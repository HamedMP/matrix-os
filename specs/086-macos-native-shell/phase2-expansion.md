# Phase 2 Expansion: Project + Task Management, Integrations, Symphony

**Feature**: [086-macos-native-shell](./spec.md) · **Status**: planned (requested during live MVP testing 2026-06-05)
**Context**: MVP works end-to-end (sign-in → sessions-as-cards → live zellij terminal on the VPS). These stories turn the board from a read-only session viewer into a full operator workspace.

## Reuse audit (what already exists on the gateway)

| Need | Existing surface | Net-new |
|---|---|---|
| Create a session | `POST /api/sessions` (orchestrator `startSession`); zellij `createSession`/`createTab` | wire to ⌘N + card-create |
| Create/list projects | `POST /api/projects`, `GET /api/workspace/projects`, `GET /api/projects/:slug` | clone-from-remote flow + UI |
| Tasks CRUD (move/rename/order) | `POST/PATCH/DELETE /api/projects/:slug/tasks` (status, order, priority, linkedSessionId) | client mutations (US2) |
| GitHub status / PRs | `GET /api/github/status`, `/api/projects/:slug/prs`, `/branches` | issue import mapping |
| `gh auth login` | runs in any card terminal (already attachable) | a guided "connect GitHub" affordance |
| Symphony | `packages/gateway/src/symphony/*` proxy | assign-to-symphony action |
| Labels / assignees | **not in task schema** (`CreateTaskSchema` has no tags/assignee) | **server delta**: add `tags`/`assignee` columns + validation |
| Linear import | **no Linear integration on VPS gateway** | platform-owned Pipedream/Linear proxy (PIPEDREAM_* stays platform-side per CLAUDE.md) |

## User Stories

### US7 — A card is backed by a fresh zellij session (P1 for this phase)
Creating a card (⌘N or the column "+") provisions a **new** zellij session on the VPS and links it (`linkedSessionId`); opening the card attaches its terminal. Opening an existing session-card attaches; "new terminal" adds a zellij **tab** (`createTab`).
- **FR-E1**: ⌘N / column-"+" creates a card → `POST /api/sessions` (idempotent) → links the new session id; the board shows it immediately and optimistically.
- **FR-E2**: A card titled by the user; the session name is derived safely (SAFE_SLUG) server-side.
- **FR-E3**: "New terminal" on a card opens a new zellij tab in that session.

### US8 — Projects: clone remote, new project, GitHub auth (P1)
The operator can create a project, **clone a remote git repo onto the VPS**, and authenticate git via `gh auth login` from a terminal.
- **FR-E4**: "New project" → `POST /api/projects` (name, optional git remote). Unique-slug create is idempotent server-side.
- **FR-E5**: "Clone repo" → provisions a session whose terminal runs the clone (or a gateway clone route if one exists) into `~/projects/<slug>`; progress visible in the card terminal.
- **FR-E6**: "Connect GitHub" → opens a card terminal pre-running `gh auth login` (device flow in-terminal); status reflected from `GET /api/github/status`.
- **FR-E7**: A project picker in the board chrome switches the active project/board (replaces the hardcoded slug).

### US9 — Import tickets from GitHub / Linear (P2)
Import issues into the board as cards.
- **FR-E8**: GitHub issues import for the project's repo → create tasks (title, body→description, labels→tags, state→column). Uses GitHub via the existing project GitHub auth.
- **FR-E9**: Linear import via a **platform-owned** integration (Pipedream/Linear proxy; `PIPEDREAM_*` never on the VPS — proxy through `PLATFORM_INTERNAL_URL` per CLAUDE.md). Maps Linear issues → tasks.
- **FR-E10**: Import is idempotent (re-import updates, does not duplicate; key on external id).

### US10 — Labels and assignment (incl. Symphony) (P2)
- **FR-E11**: Add/remove **labels** on a card (server delta: `tags: string[]` on task, validated `SAFE_SLUG`, capped).
- **FR-E12**: **Assign** a card to a person or an **agent** (server delta: `assignee` — a principal/agent ref). Assignment is visible on the card.
- **FR-E13**: **Assign to Symphony** → hands the task to the Symphony orchestrator (start a run scoped to the task/session); card shows run status + agent activity (ties to US5).

## Security / failure / resource notes
- All new routes principal-scoped (`requireRequestPrincipal`, owner scope); `bodyLimit` on every mutation; generic errors only.
- Session/project create idempotent (`ON CONFLICT` / unique-slug select-existing) — no duplicate sessions on double-tap.
- Import jobs bounded + paginated; external fetches (GitHub/Linear) time-bounded and SSRF-safe; Linear stays platform-side.
- Label/assignee server delta is a Kysely migration on owner Postgres (no new embedded DB).
- Symphony assignment must reflect terminal run state honestly (no silent success).

## Server deltas required (call out for review-spec)
1. `tasks.tags string[]` + `tasks.assignee` columns (+ validation, + PATCH support, revision-guarded).
2. (Maybe) a gateway clone route, or do clone purely in-terminal (no new route).
3. GitHub issue import endpoint (or client-side via gh in terminal + task POST).
4. Platform Linear proxy route (platform-owned).

## Task additions (appended to tasks.md Phase 4+)
See tasks.md "Phase 4b — Expansion (US7–US10)".
