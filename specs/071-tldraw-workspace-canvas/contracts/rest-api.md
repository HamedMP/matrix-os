# REST API Contract: Workspace Canvas

All routes require Matrix session auth or a valid CLI token. No route is public. All mutating routes use Hono `bodyLimit` before buffering. Client-facing errors are generic and do not expose provider names, filesystem paths, stack traces, or raw validation issues.

## GET /api/canvases

List canvas summaries visible to the authenticated user.

Query:

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `scopeType` | string | No | `global`, `project`, `task`, `pull_request`, `review_loop`. |
| `scopeId` | string | No | Required when filtering a non-global scope. |
| `limit` | integer | No | Default 50, max 100. |
| `cursor` | string | No | Opaque pagination cursor. |

Response `200`:

```json
{
  "canvases": [
    {
      "id": "cnv_123",
      "title": "PR 57 Review",
      "scopeType": "pull_request",
      "scopeRef": { "projectId": "prj_1", "owner": "acme", "repo": "app", "number": 57 },
      "revision": 12,
      "updatedAt": "2026-04-27T00:00:00.000Z",
      "nodeCounts": { "total": 18, "stale": 1, "live": 3 }
    }
  ],
  "nextCursor": null
}
```

## POST /api/canvases

Create a canvas document.

Body limit: 256 KiB.

Request:

```json
{
  "title": "PR 57 Review",
  "scopeType": "pull_request",
  "scopeRef": { "projectId": "prj_1", "owner": "acme", "repo": "app", "number": 57 },
  "template": "pr_workspace"
}
```

Response `201`:

```json
{ "canvasId": "cnv_123", "revision": 1 }
```

Errors:

- `400`: invalid payload.
- `401`: unauthenticated.
- `403`: scope not authorized.
- `409`: duplicate active canvas for unique scope where uniqueness is enforced.

## GET /api/canvases/:canvasId

Read a canvas document and reconciled linked-record summaries.

Response `200`:

```json
{
  "document": {
    "id": "cnv_123",
    "schemaVersion": 1,
    "scopeType": "pull_request",
    "revision": 12,
    "nodes": [],
    "edges": [],
    "viewStates": [],
    "displayOptions": {}
  },
  "linkedState": {
    "terminalSessions": [],
    "pullRequests": [],
    "reviewLoops": [],
    "missingRefs": []
  }
}
```

## PUT /api/canvases/:canvasId

Replace the bounded canvas document using optimistic concurrency.

Body limit: 256 KiB.

Request:

```json
{
  "baseRevision": 12,
  "document": {
    "schemaVersion": 1,
    "nodes": [],
    "edges": [],
    "viewStates": [],
    "displayOptions": {}
  }
}
```

Response `200`:

```json
{ "revision": 13, "updatedAt": "2026-04-27T00:00:00.000Z" }
```

Errors:

- `400`: invalid payload.
- `401`: unauthenticated.
- `403`: not authorized.
- `409`: stale `baseRevision`; response includes current safe summary and latest revision.
- `413`: body too large.

## PATCH /api/canvases/:canvasId/nodes/:nodeId

Update a single node display state, position, size, metadata, or source reference.

Body limit: 64 KiB.

Request:

```json
{
  "baseRevision": 13,
  "updates": {
    "position": { "x": 120, "y": 240 },
    "size": { "width": 520, "height": 360 },
    "displayState": "normal"
  }
}
```

Response `200`:

```json
{ "revision": 14 }
```

## POST /api/canvases/:canvasId/actions

Execute a confirmed domain action from the canvas.

Body limit: 64 KiB.

Allowed `type` values:

- `terminal.create`
- `terminal.attach`
- `terminal.kill`
- `review.start`
- `review.stop`
- `review.next`
- `pr.refresh`
- `file.open`
- `preview.healthCheck`
- `custom.validate`

Request:

```json
{
  "nodeId": "node_terminal_1",
  "type": "terminal.attach",
  "payload": { "sessionId": "550e8400-e29b-41d4-a716-446655440000" }
}
```

Response `200`:

```json
{
  "ok": true,
  "result": {
    "kind": "terminal_session",
    "sessionId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

## DELETE /api/canvases/:canvasId

Soft-delete a canvas document. Does not delete linked source-of-truth records unless a separate confirmed domain action is submitted.

Response `200`:

```json
{ "ok": true }
```

## GET /api/canvases/:canvasId/export

Export a canvas document with safe linked summaries.

Response `200`:

```json
{
  "canvas": {},
  "linkedSummaries": {},
  "exportedAt": "2026-04-27T00:00:00.000Z"
}
```
