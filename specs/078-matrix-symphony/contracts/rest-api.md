# REST API Contract: Matrix Symphony

Base path: `/api/symphony`

All endpoints require a Matrix request principal. Owner-only endpoints reject authorized teammates unless noted. Client error messages are generic and never include provider tokens, raw provider errors, database errors, or filesystem paths.

## Auth Matrix

| Method | Path | Auth | Role | Body Limit |
|--------|------|------|------|------------|
| GET | `/status` | Matrix request principal | Owner or operator | N/A |
| GET | `/config` | Matrix request principal | Owner or operator | N/A |
| POST | `/config` | Matrix request principal | Owner | 16KB |
| POST | `/credentials/linear` | Matrix request principal | Owner | 16KB |
| DELETE | `/credentials/linear` | Matrix request principal | Owner | 4KB |
| GET | `/tickets/preview` | Matrix request principal | Owner or operator | N/A |
| GET | `/runs` | Matrix request principal | Owner or operator | N/A |
| POST | `/start` | Matrix request principal | Owner or operator | 4KB |
| POST | `/stop` | Matrix request principal | Owner or operator | 4KB |
| POST | `/runs/:runId/actions` | Matrix request principal | Owner or operator | 16KB |
| GET | `/events` | Matrix request principal | Owner or operator | N/A |

## `GET /status`

Returns sanitized orchestrator state.

Response:
```json
{
  "running": true,
  "installationId": "sym_abc",
  "credentialConfigured": true,
  "pollIntervalMs": 30000,
  "maxConcurrentAgents": 3,
  "counts": {
    "queued": 2,
    "running": 1,
    "needsAttention": 1,
    "handoff": 4
  },
  "lastPollAt": "2026-05-13T00:00:00.000Z"
}
```

## `GET /config`

Returns non-secret config.

Response:
```json
{
  "installation": {
    "projectSlug": "matrix-os",
    "enabled": false,
    "credentialConfigured": true,
    "pollIntervalMs": 30000,
    "maxConcurrentAgents": 3,
    "defaultAgent": "codex",
    "authorizedOperators": ["user_123"]
  },
  "rule": {
    "teamId": "team_mat",
    "teamKey": "MAT",
    "projectId": "project_matrix",
    "projectSlug": "matrix-os",
    "requiredLabels": ["symphony"],
    "activeStates": ["Todo", "In Progress"],
    "terminalStates": ["Done", "Canceled"],
    "assigneeIds": ["user_linear_1"]
  }
}
```

## `POST /config`

Saves non-secret config and ticket rule. Uses one transaction for installation + rule + audit event.

Body:
```json
{
  "installation": {
    "projectSlug": "matrix-os",
    "pollIntervalMs": 30000,
    "maxConcurrentAgents": 3,
    "defaultAgent": "codex",
    "authorizedOperators": ["user_123"]
  },
  "rule": {
    "teamId": "team_mat",
    "teamKey": "MAT",
    "projectId": "project_matrix",
    "projectSlug": "matrix-os",
    "requiredLabels": ["symphony"],
    "activeStates": ["Todo", "In Progress"],
    "terminalStates": ["Done", "Canceled"],
    "assigneeIds": ["user_linear_1"]
  }
}
```

## `POST /credentials/linear`

Stores or validates a Linear credential server-side.

Body:
```json
{
  "kind": "api_key",
  "secret": "lin_api_..."
}
```

Response:
```json
{
  "credentialConfigured": true,
  "accountLabel": "Linear"
}
```

## `DELETE /credentials/linear`

Removes the server-side Linear credential and disables dispatch until another credential source is available.

Response:
```json
{
  "credentialConfigured": false
}
```

## `GET /tickets/preview`

Returns matching tickets for current saved or draft query params.

Query params:
- `limit`: integer 1-100
- `state`: optional state name

Response:
```json
{
  "tickets": [
    {
      "externalId": "lin_123",
      "identifier": "MAT-123",
      "title": "Improve Symphony",
      "url": "https://linear.app/...",
      "stateName": "Todo",
      "assigneeName": "Hamed",
      "labels": ["symphony"]
    }
  ],
  "truncated": false
}
```

## `GET /runs`

Returns the sanitized dashboard run list.

Query params:
- `status`: optional run status filter
- `limit`: integer 1-100
- `cursor`: optional opaque cursor

Response:
```json
{
  "runs": [
    {
      "id": "run_123",
      "status": "running",
      "ticketIdentifier": "MAT-123",
      "ticketTitle": "Improve Symphony",
      "ticketUrl": "https://linear.app/...",
      "agent": "codex",
      "projectSlug": "matrix-os",
      "worktreeId": "wt_abc",
      "sessionId": "sess_abc",
      "lastEvent": "Agent session started",
      "updatedAt": "2026-05-13T00:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

## `POST /start`

Starts polling. Does not require a request body beyond `{}`.

## `POST /stop`

Stops polling and drains status subscribers. Does not kill already-running agent sessions unless paired with run actions.

## `POST /runs/:runId/actions`

Discriminated union body:
```json
{ "type": "stop" }
```
```json
{ "type": "retry" }
```
```json
{ "type": "open_workspace" }
```

Response:
```json
{
  "run": {
    "id": "run_123",
    "status": "stopped",
    "ticketIdentifier": "MAT-123",
    "worktreeId": "wt_abc",
    "sessionId": "sess_abc"
  }
}
```

## `GET /events`

Returns a bounded server-sent event stream for sanitized status changes. The server evicts stale subscribers, caps subscribers per owner, and sends a best-effort closing event during shutdown.

Event data uses the envelope from [realtime-events.md](./realtime-events.md).
