# Contract: Matrix Gateway Symphony API

All routes are browser-facing Matrix gateway routes. The upstream Elixir service remains loopback-only.

## GET `/api/symphony/state`

Returns normalized Elixir service state.

```json
{
  "service": {
    "status": "ready",
    "version": "0.1.0-matrix",
    "workspaceRoot": "/home/matrix/home/projects/matrix-os/symphony-workspaces",
    "credentialStatus": "connected",
    "lastHeartbeatAt": "2026-05-25T00:00:00.000Z"
  },
  "groups": {
    "queue": [],
    "running": [],
    "needsAttention": [],
    "done": []
  }
}
```

Errors use coarse codes: `unauthorized`, `forbidden`, `service_unavailable`, `timeout`, `invalid_response`.

## GET `/api/symphony/issues/:issueIdentifier`

Returns detail for one issue/run. `issueIdentifier` must match the gateway-safe issue identifier schema before proxying.

## POST `/api/symphony/refresh`

Triggers an Elixir refresh/poll cycle. Request body must be empty or `{}` and is body-limited before parsing.

## POST `/api/symphony/runs/:runId/stop`

Stops an active run when the Elixir runtime exposes the action. `runId` must match the safe run ID schema. Response returns updated normalized state or detail.

## Proxy Rules

- Only allowlisted upstream route templates may be called.
- Upstream origin is configured server-side and must be loopback.
- Every upstream call uses `AbortSignal.timeout(10000)`.
- Raw upstream errors are logged server-side and mapped to coarse client errors.
