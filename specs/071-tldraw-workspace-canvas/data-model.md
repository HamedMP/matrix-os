# Data Model: Workspace Canvas

## CanvasDocument

Canonical saved workspace document.

| Field | Type | Rules |
|-------|------|-------|
| `id` | string | Stable prefixed ID, unique per owner. |
| `ownerScope` | `personal` or `org` | Initial implementation writes `personal`; org is reserved. |
| `ownerId` | string | Authenticated Matrix user ID or future org ID. |
| `scopeType` | `global`, `project`, `task`, `pull_request`, `review_loop` | Required. |
| `scopeRef` | object or null | Required for all non-global scopes; validates referenced project/task/PR/review loop access. |
| `title` | string | 1-120 chars, safe display text. |
| `revision` | integer | Monotonic optimistic concurrency token. |
| `schemaVersion` | integer | Starts at `1`; migration required on breaking changes. |
| `nodes` | CanvasNode[] | Bounded by document limits. |
| `edges` | CanvasEdge[] | Bounded by document limits. |
| `viewStates` | CanvasViewState[] | Per-user display state. |
| `displayOptions` | object | Validated options only. |
| `createdAt` | ISO datetime | Server generated. |
| `updatedAt` | ISO datetime | Server generated. |
| `deletedAt` | ISO datetime or null | Soft delete for recovery/export window. |

Validation:

- Max serialized document size: 256 KiB for normal writes.
- Max nodes per document: 500.
- Max edges per document: 1,000.
- Writes require matching `revision`.
- Export/delete must check owner scope and linked project access.

## CanvasNode

Typed visual item in a canvas document.

| Field | Type | Rules |
|-------|------|-------|
| `id` | string | Stable node ID, unique within document. |
| `type` | enum | `terminal`, `pr`, `review_loop`, `finding`, `task`, `file`, `preview`, `note`, `app_window`, `issue`, `custom`, `fallback`. |
| `position` | `{ x, y }` | Finite numbers, bounded world coordinates. |
| `size` | `{ width, height }` | Positive, min/max per node type. |
| `zIndex` | integer | Bounded ordering value. |
| `collapsed` | boolean | Optional, defaults false. |
| `displayState` | enum | `normal`, `minimized`, `summary`, `stale`, `missing`, `unauthorized`, `failed`, `recoverable`. |
| `sourceRef` | NodeSourceRef or null | Required except pure note/fallback nodes. |
| `metadata` | object | Type-specific Zod schema, capped at 16 KiB per node. |
| `createdAt` | ISO datetime | Server generated. |
| `updatedAt` | ISO datetime | Server generated. |

Validation:

- Node type determines allowed `sourceRef` and metadata schema.
- Unsafe file paths, URLs, and unauthorized app IDs are rejected.
- Custom node metadata must include `customType`, `customVersion`, and validated payload.

## NodeSourceRef

Reference to the domain source of truth.

| Field | Type | Rules |
|-------|------|-------|
| `kind` | enum | `terminal_session`, `project`, `task`, `pull_request`, `review_loop`, `review_finding`, `file`, `url`, `app_window`, `github_issue`, `custom`. |
| `id` | string | Stable ID in the referenced subsystem. |
| `projectId` | string optional | Required where project authorization is needed. |
| `external` | object optional | Provider-neutral metadata such as owner/repo/number; no raw provider errors or tokens. |

## CanvasEdge

Visual relationship between nodes.

| Field | Type | Rules |
|-------|------|-------|
| `id` | string | Stable edge ID, unique within document. |
| `fromNodeId` | string | Must reference an existing node. |
| `toNodeId` | string | Must reference an existing node. |
| `type` | enum | `visual`, `depends_on`, `implements`, `reviews`, `opens`, `related`. |
| `label` | string optional | Max 80 chars. |
| `metadata` | object optional | Capped at 4 KiB. |

Edges are visual by default. Mutating underlying project/task/review relationships requires a separate confirmed action.

## CanvasViewState

Per-user view preferences for a document.

| Field | Type | Rules |
|-------|------|-------|
| `userId` | string | Authenticated user. |
| `viewport` | `{ x, y, zoom }` | Zoom bounded from 0.1 to 4.0. |
| `selection` | string[] | Node/edge IDs, bounded at 100. |
| `focusedNodeId` | string optional | Must exist or be ignored. |
| `filters` | object | Validated query/filter state. |
| `groups` | object[] | Group metadata, bounded. |
| `updatedAt` | ISO datetime | Server generated. |

## CustomNodeDefinition

Versioned custom node renderer/metadata contract.

| Field | Type | Rules |
|-------|------|-------|
| `id` | string | Safe slug. |
| `ownerScope` | string | User/org/app scope. |
| `version` | integer | Positive. |
| `displayName` | string | 1-80 chars. |
| `metadataSchema` | JSON schema subset | Bounded; validated before registration. |
| `permissions` | string[] | Explicit app/file/network capabilities. |
| `rendererRef` | object | Approved renderer key, not arbitrary code. |
| `migrationRefs` | object[] | Optional version migrations. |
| `createdAt` | ISO datetime | Server generated. |

## CanvasSubscription

In-memory subscriber state, not persisted.

| Field | Type | Rules |
|-------|------|-------|
| `connectionId` | string | Stable for WS lifetime. |
| `canvasId` | string | Authorized document. |
| `userId` | string | Authenticated user. |
| `lastSeenRevision` | integer | Used for replay/conflict hints. |
| `presence` | object | Cursor/focus metadata with TTL. |

Caps:

- 100 total subscribers per gateway process.
- 10 subscribers per canvas per user process.
- Presence TTL: 30 seconds.

## State Transitions

Canvas document:

```text
draft -> active -> soft_deleted -> purged
active -> recovering -> active
active -> conflict -> active
```

Node display state:

```text
normal -> summary -> normal
normal -> stale -> recoverable -> normal
normal -> missing
normal -> unauthorized
normal -> failed -> normal
```

Review loop node:

```text
idle -> running -> waiting_for_fixes -> verifying -> converged
running -> stalled
running -> failed
running -> stopped
```
