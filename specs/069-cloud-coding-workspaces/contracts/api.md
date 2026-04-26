# API Contracts: Cloud Coding Workspaces

All routes require authenticated Matrix user context unless explicitly documented otherwise. Mutating routes require body limits, Zod validation, ownership checks, and structured errors.

## Error Shape

```json
{
  "error": {
    "code": "invalid_ref",
    "message": "Branch or PR reference is invalid",
    "requestId": "req_..."
  }
}
```

User-facing responses must not include internal paths, stack traces, raw provider errors, or command output containing secrets.

## GitHub

### `GET /api/github/status`

Returns GitHub CLI/auth availability for the current container.

```json
{
  "installed": true,
  "authenticated": true,
  "user": "octocat",
  "errorCode": null
}
```

## Projects

### `POST /api/projects`

Request:

```json
{
  "url": "github.com/owner/repo",
  "slug": "repo"
}
```

Response: `201`

```json
{
  "project": {
    "slug": "repo",
    "name": "repo",
    "localPath": "/home/matrixos/home/projects/repo/repo",
    "github": { "owner": "owner", "repo": "repo" }
  }
}
```

Errors: `github_auth_required`, `invalid_repository_url`, `clone_too_large`, `clone_timeout`, `slug_conflict`.

### `GET /api/projects`

Query: `?q=&limit=&cursor=`

Response:

```json
{
  "projects": [],
  "nextCursor": null
}
```

### `GET /api/projects/:slug/prs`

Response:

```json
{
  "prs": [
    {
      "number": 42,
      "title": "Add workspace",
      "author": "octocat",
      "headRef": "feature/workspace",
      "baseRef": "main",
      "state": "OPEN"
    }
  ],
  "refreshedAt": "2026-04-26T00:00:00.000Z"
}
```

### `GET /api/projects/:slug/branches`

Returns local and remote branches with current/default markers.

## Worktrees

### `POST /api/projects/:slug/worktrees`

Request must include exactly one of `pr` or `branch`.

```json
{
  "pr": 42
}
```

Response: `201`

```json
{
  "worktree": {
    "id": "wt_abc123",
    "projectSlug": "repo",
    "currentBranch": "pr-42",
    "path": "/home/matrixos/home/projects/repo/worktrees/wt_abc123"
  }
}
```

Errors: `invalid_ref`, `worktree_exists`, `github_auth_required`, `checkout_failed`.

### `DELETE /api/projects/:slug/worktrees/:worktreeId`

Request:

```json
{
  "confirmDirtyDelete": false
}
```

Errors: `dirty_worktree_confirmation_required`, `worktree_locked`, `not_found`.

## Tasks

### `POST /api/projects/:slug/tasks`

```json
{
  "title": "Fix auth middleware",
  "description": "Validate user-supplied tokens",
  "priority": "high"
}
```

### `PATCH /api/projects/:slug/tasks/:taskId`

Supports title, description, status, priority, order, parent task, due date, linked session, linked worktree, and archive changes.

## Sessions

### `POST /api/sessions`

Request:

```json
{
  "projectSlug": "repo",
  "taskId": "task_123",
  "worktreeId": "wt_abc123",
  "pr": 42,
  "kind": "agent",
  "agent": "codex",
  "prompt": "Fix the failing tests",
  "runtimePreference": "zellij"
}
```

Response: `201`

```json
{
  "session": {
    "id": "sess_123",
    "terminalSessionId": "term_123",
    "status": "starting",
    "runtime": { "type": "zellij" },
    "nativeAttachCommand": "zellij attach matrix-sess_123"
  }
}
```

Errors: `agent_missing`, `agent_auth_required`, `worktree_locked`, `sandbox_unavailable`, `runtime_unavailable`.

### `GET /api/sessions`

Query supports `projectSlug`, `taskId`, `pr`, `status`, `limit`, and `cursor`.

### `POST /api/sessions/:sessionId/send`

```json
{
  "input": "run tests\n"
}
```

### `POST /api/sessions/:sessionId/observe`

Creates or returns a read-only attach ticket.

### `POST /api/sessions/:sessionId/takeover`

Moves write ownership to the requesting client after explicit confirmation.

### `DELETE /api/sessions/:sessionId`

Kills or terminates the runtime session and records exit state.

## Reviews

### `POST /api/reviews`

```json
{
  "projectSlug": "repo",
  "pr": 42,
  "reviewer": "claude",
  "implementer": "codex",
  "maxRounds": 5,
  "convergenceGate": "findings_and_verify",
  "verificationCommands": ["pnpm test"]
}
```

Response: `201`

```json
{
  "review": {
    "id": "rev_123",
    "status": "queued",
    "round": 0
  }
}
```

### `GET /api/reviews/:reviewId`

Returns status, active session, rounds, findings counts, commits, and terminal actions.

### `POST /api/reviews/:reviewId/next`

Legal only from documented terminal/operator states. Cannot skip an actively running agent round.

### `POST /api/reviews/:reviewId/approve`

Marks the loop operator-approved with audit metadata.

### `POST /api/reviews/:reviewId/stop`

Stops active sessions owned by the review loop and releases the worktree lease.

## Agents

### `GET /api/agents`

Returns install/auth/runtime status for supported agents.

### `GET /api/agents/sandbox-status`

```json
{
  "available": true,
  "mode": "bubblewrap",
  "diagnostics": []
}
```

## Workspace Events

### `GET /api/workspace/events`

Server-sent events or equivalent streaming endpoint for project/task/session/review/preview changes. Clients use it to converge web, desktop, CLI, and TUI state without manual refresh.
