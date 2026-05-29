# Realtime Events Contract: Matrix Symphony

Delivery is implemented as authenticated SSE at `GET /api/symphony/events`. A bounded polling fallback may be kept for clients that cannot hold an event stream. If a future WebSocket transport is added, authenticated browser clients must use the Matrix query-token path already required for browser WebSocket routes.

## Event Envelope

```json
{
  "type": "symphony.run.updated",
  "installationId": "sym_abc",
  "runId": "run_123",
  "sequence": 42,
  "createdAt": "2026-05-13T00:00:00.000Z",
  "payload": {}
}
```

Rules:
- `sequence` is monotonic per installation.
- Payloads are sanitized and bounded.
- Subscriber registry has a max size and stale-connection eviction.
- Shutdown sends a best-effort closing event and clears subscribers.
- Reconnect clients use the next status snapshot as source of truth; events are hints, not the canonical store.

## Event Types

### `symphony.config.updated`

Emitted after non-secret config or rule changes.

Payload:
```json
{
  "credentialConfigured": true,
  "projectSlug": "matrix-os",
  "maxConcurrentAgents": 3
}
```

### `symphony.poll.completed`

Payload:
```json
{
  "matchedTickets": 10,
  "dispatched": 3,
  "skipped": 7,
  "durationMs": 850
}
```

### `symphony.run.updated`

Payload:
```json
{
  "status": "running",
  "ticketIdentifier": "MAT-123",
  "worktreeId": "wt_abc",
  "sessionId": "sess_abc",
  "lastEvent": "Agent session started"
}
```

### `symphony.run.attention`

Payload:
```json
{
  "status": "retrying",
  "ticketIdentifier": "MAT-123",
  "reasonCode": "agent_start_failed",
  "nextRetryAt": "2026-05-13T00:05:00.000Z"
}
```
