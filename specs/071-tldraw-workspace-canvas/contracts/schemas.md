# Schema Contract: Workspace Canvas

Schemas are implemented with Zod 4 imported from `zod/v4`. The gateway owns validation at boundaries; shell code may share derived types after schemas stabilize.

## ID Rules

| ID | Pattern |
|----|---------|
| Canvas ID | `^cnv_[A-Za-z0-9_-]{8,64}$` |
| Node ID | `^node_[A-Za-z0-9_-]{8,64}$` |
| Edge ID | `^edge_[A-Za-z0-9_-]{8,64}$` |
| Project ID | Existing project/workspace ID schema |
| Terminal session ID | Existing UUID schema from `SessionRegistry` |
| Custom type | Existing `SAFE_SLUG` style: lowercase slug, max 64 chars |

## CanvasDocumentInput

Required fields:

- `schemaVersion`: `1`
- `nodes`: array, max 500
- `edges`: array, max 1000
- `viewStates`: array, max 25
- `displayOptions`: object, max serialized size 8 KiB

Server-owned fields are ignored or rejected on write:

- `ownerId`
- `createdAt`
- `updatedAt`
- `deletedAt`
- `revision`

## CanvasNodeInput

Required fields:

- `id`
- `type`
- `position`
- `size`

Common limits:

- `position.x/y`: finite number between -1,000,000 and 1,000,000.
- `size.width`: 120 to 2,400.
- `size.height`: 80 to 1,600.
- `metadata`: max serialized size 16 KiB.

Type-specific requirements:

| Type | Required Source Ref | Required Metadata |
|------|---------------------|-------------------|
| `terminal` | `terminal_session` or project/task ref for creation | `mode`, optional `title` |
| `pr` | `pull_request` | `owner`, `repo`, `number`, optional `title` |
| `review_loop` | `review_loop` | `state`, optional `roundCount` |
| `finding` | `review_finding` | `severity`, `filePath`, `roundId` |
| `task` | `task` | `title`, `status` |
| `file` | `file` | `path`, optional `line` |
| `preview` | `url` | `url`, `title` |
| `note` | none | `text` max 8 KiB |
| `app_window` | `app_window` | `appId`, optional `windowId` |
| `issue` | `github_issue` | `owner`, `repo`, `number` |
| `custom` | `custom` | `customType`, `customVersion`, `payload` |
| `fallback` | any or none | `originalType`, `reason` |

## URL Rules

Allowed schemes:

- `https:`
- `http:` only for localhost or explicitly allowed dev origins

Rejected:

- `javascript:`
- `data:`
- `file:`
- credential-bearing URLs
- private-network targets unless a future explicit local-preview permission is added

All preview health checks use `AbortSignal.timeout(10_000)`.

## File Path Rules

- Resolve through `resolveWithinHome` or a project-root equivalent.
- Store display-safe relative paths when possible.
- Never include raw absolute paths in client-visible errors.
- Reject traversal, NUL bytes, and paths outside authorized roots.

## Error Shape

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Canvas request is invalid"
  }
}
```

Allowed codes:

- `invalid_request`
- `not_authenticated`
- `not_authorized`
- `not_found`
- `conflict`
- `too_large`
- `rate_limited`
- `server_error`

Do not return raw Zod issues to clients.
