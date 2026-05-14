# Realtime Events Contract

Desktop uses bounded realtime streams with polling fallback. Event bodies contain client-safe strings only.

## Ticket Events

Channel: `GET /api/projects/:projectSlug/tickets/events`

Event examples:

```json
{
  "type": "ticket.created",
  "projectSlug": "matrix-os",
  "ticketId": "ticket_123",
  "revision": 1,
  "createdAt": "2026-05-14T18:00:00.000Z"
}
```

```json
{
  "type": "ticket.sync.completed",
  "projectSlug": "matrix-os",
  "sourceId": "source_linear",
  "created": 4,
  "updated": 12,
  "truncated": false,
  "createdAt": "2026-05-14T18:01:00.000Z"
}
```

## Symphony Events

Channel: existing `/api/symphony/events`, extended for unified tickets.

Event examples:

```json
{
  "type": "symphony.run.queued",
  "runId": "run_123",
  "ticketId": "ticket_123",
  "projectSlug": "matrix-os",
  "createdAt": "2026-05-14T18:02:00.000Z"
}
```

```json
{
  "type": "symphony.run.updated",
  "runId": "run_123",
  "ticketId": "ticket_123",
  "status": "needs_attention",
  "safeMessage": "Cloud agent needs operator attention.",
  "createdAt": "2026-05-14T18:03:00.000Z"
}
```

## Resource Rules

- Subscriber registry has a hard cap per owner/project.
- Stale subscribers are evicted by TTL.
- Broadcast failures are isolated per subscriber and dead subscribers are removed after failure.
- Shutdown drains send a final generic shutdown event before clearing subscribers.
- Clients reconcile by project/ticket/run revision after reconnect.
