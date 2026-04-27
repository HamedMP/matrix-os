# Realtime Contract: Workspace Canvas

Realtime updates use an authenticated WebSocket. The implementation may reuse the main Matrix OS socket or expose `/ws/canvas`; either path must use the same auth source of truth as REST routes.

## Client Messages

### canvas.subscribe

```json
{
  "type": "canvas.subscribe",
  "canvasId": "cnv_123",
  "lastSeenRevision": 12
}
```

Rules:

- Authenticated user must be authorized for the canvas scope.
- Server rejects if subscriber caps are exceeded.

### canvas.unsubscribe

```json
{
  "type": "canvas.unsubscribe",
  "canvasId": "cnv_123"
}
```

### canvas.presence

```json
{
  "type": "canvas.presence",
  "canvasId": "cnv_123",
  "presence": {
    "cursor": { "x": 200, "y": 100 },
    "focusedNodeId": "node_pr_1"
  }
}
```

Rules:

- Frame limit: 32 KiB.
- Presence expires after 30 seconds.
- Unknown node IDs are ignored.

## Server Messages

### canvas.snapshot

Sent after subscribe when the client is stale or has no local copy.

```json
{
  "type": "canvas.snapshot",
  "canvasId": "cnv_123",
  "revision": 13,
  "document": {}
}
```

### canvas.updated

Sent after a successful document or node write.

```json
{
  "type": "canvas.updated",
  "canvasId": "cnv_123",
  "revision": 14,
  "changedBy": "usr_123",
  "summary": {
    "nodeIds": ["node_terminal_1"],
    "edgeIds": []
  }
}
```

Clients that cannot apply the event safely must refetch the document.

### canvas.presence

```json
{
  "type": "canvas.presence",
  "canvasId": "cnv_123",
  "userId": "usr_456",
  "presence": {
    "cursor": { "x": 200, "y": 100 },
    "focusedNodeId": "node_pr_1"
  },
  "expiresAt": "2026-04-27T00:00:30.000Z"
}
```

### canvas.referenceStateChanged

Sent when reconciliation detects stale/missing/recovered linked records.

```json
{
  "type": "canvas.referenceStateChanged",
  "canvasId": "cnv_123",
  "revision": 15,
  "nodes": [
    {
      "nodeId": "node_terminal_1",
      "displayState": "stale",
      "reason": "runtime_unavailable"
    }
  ]
}
```

### canvas.error

```json
{
  "type": "canvas.error",
  "canvasId": "cnv_123",
  "code": "not_authorized",
  "message": "Canvas is not available"
}
```

Allowed codes:

- `not_authenticated`
- `not_authorized`
- `invalid_message`
- `subscriber_limit`
- `canvas_not_found`
- `stale_revision`
- `server_error`

Messages stay generic.
