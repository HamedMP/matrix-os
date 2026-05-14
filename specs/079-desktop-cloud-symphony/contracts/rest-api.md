# REST API Contract

All endpoints require Matrix request-principal authentication unless explicitly stated. All mutating routes use `bodyLimit`, Zod 4 boundary schemas, generic client errors, and server-side detailed logs.

## Desktop Runtime

### `GET /api/desktop/runtime`

Returns safe runtime policy for desktop/shell.

Response:

```json
{
  "agentExecution": { "mode": "cloud", "localAgentsAllowed": false },
  "capabilities": ["matrixShell", "appLauncher", "cloudDevelopment", "linearTicketSync", "internalTickets", "symphonyRunner"],
  "gatewayHealth": "healthy",
  "version": 1
}
```

## Tickets

### `GET /api/projects/:projectSlug/tickets`

Query:

- `source`: `linear` | `matrix` | `all`
- `status`: optional status filter
- `assigneeId`: optional assignee filter
- `cursor`: optional cursor
- `limit`: integer, capped
- `includeArchived`: boolean, default false

Response:

```json
{
  "tickets": [
    {
      "id": "ticket_123",
      "identifier": "MAT-123",
      "sourceKind": "linear",
      "title": "Build desktop workbench",
      "status": "Todo",
      "priority": "high",
      "revision": 4,
      "syncStatus": "synced"
    }
  ],
  "nextCursor": null
}
```

### `POST /api/projects/:projectSlug/tickets`

Creates a Matrix-native ticket.

Request:

```json
{
  "title": "Add cloud preview panel",
  "description": "Show preview URL in task workbench",
  "status": "Todo",
  "priority": "medium",
  "assigneeIds": [],
  "labelIds": []
}
```

Response: created tracked ticket.

### `PATCH /api/projects/:projectSlug/tickets/:ticketId`

Updates a tracked ticket with optimistic concurrency.

Request:

```json
{
  "baseRevision": 4,
  "patch": {
    "status": "In Progress",
    "labelIds": ["desktop"]
  }
}
```

Response: updated tracked ticket or conflict code.

### `POST /api/projects/:projectSlug/tickets/sync/linear`

Triggers or previews Linear sync for a configured source.

Request:

```json
{
  "sourceId": "source_linear",
  "mode": "preview"
}
```

Response:

```json
{
  "created": 4,
  "updated": 12,
  "unchanged": 84,
  "truncated": false
}
```

## Symphony Assignment

### `POST /api/projects/:projectSlug/tickets/:ticketId/assignments/symphony`

Assigns a ticket to Symphony manually.

Request:

```json
{
  "agent": "codex",
  "mode": "start"
}
```

Response:

```json
{
  "run": {
    "id": "run_123",
    "ticketId": "ticket_123",
    "status": "queued",
    "agent": "codex"
  }
}
```

### `POST /api/projects/:projectSlug/symphony/rules`

Creates or updates an automatic assignment rule.

Request:

```json
{
  "name": "Desktop queue",
  "sourceFilter": { "sourceKinds": ["linear", "matrix"] },
  "ticketFilter": { "requiredLabels": ["symphony"], "statuses": ["Todo", "Ready"] },
  "agent": "codex",
  "concurrencyLimit": 3,
  "enabled": true
}
```

Response: saved rule with server-generated ID.

## Sessions

Existing workspace/session APIs remain the control path for observing, sending input, stopping, retrying, and taking over cloud sessions. Any request containing a local runtime mode is rejected with a generic cloud-only policy error.

## Repository Workflow And Preview

### `GET /api/projects/:projectSlug/workflow`

Returns sanitized workflow setup/readiness for a project.

Response:

```json
{
  "workflow": {
    "revision": 3,
    "setupConfigured": true,
    "liveConfigured": true,
    "allowedPreviewPorts": [3000, 4000],
    "codexRequired": true
  },
  "codex": {
    "status": "valid",
    "lastCheckedAt": "2026-05-14T18:00:00.000Z"
  }
}
```

### `POST /api/projects/:projectSlug/workflow`

Saves workflow setup, live commands, validation commands, and preview ports.

Request:

```json
{
  "baseRevision": 3,
  "setupCommands": [{ "name": "Install", "command": "pnpm install --frozen-lockfile" }],
  "liveCommands": [{ "name": "Dev", "command": "pnpm dev", "ports": [3000] }],
  "validationCommands": [{ "name": "Test", "command": "bun run test" }],
  "allowedPreviewPorts": [3000],
  "codexRequired": true
}
```

Rules:

- Commands and ports are validated before save.
- Unsafe or unsupported command definitions are rejected with a generic client error.
- Codex token material is never accepted in this route.

### `GET /api/projects/:projectSlug/previews`

Returns approved preview URLs/targets for a project/worktree/session.

Rules:

- Only allowlisted project ports are exposed.
- Server-side URL handling uses SSRF protections and redirect validation.

## Shared Boards

### `GET /api/projects/:projectSlug/members`

Returns authorized board members and roles.

### `POST /api/projects/:projectSlug/members`

Adds, updates, or revokes a board member.

Request:

```json
{
  "userId": "user_123",
  "role": "member",
  "canAssignTickets": true,
  "canRunSymphony": true
}
```

Rules:

- Owner/admin only.
- Membership changes create operator events.
- Revoked members lose ticket/run/event access immediately on next request.
