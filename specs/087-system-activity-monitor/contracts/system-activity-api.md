# Contract: System Activity API

All routes are owner-only gateway routes on the current Matrix computer. Responses must be sanitized for client display and must not include raw provider names, tokens, filesystem paths outside approved display labels, stack traces, command stderr, or database/systemd raw errors.

## Auth Matrix

| Route | Method | Auth | Public | Notes |
| --- | --- | --- | --- | --- |
| `/api/system/activity` | GET | Owner session or accepted Matrix bearer/JWT | No | Read-only snapshot |
| `/api/system/activity/actions` | POST | Owner session or accepted Matrix bearer/JWT | No | Mutating cleanup action; `bodyLimit` required |
| `/api/system/activity/policy` | GET | Owner session or accepted Matrix bearer/JWT | No | Read auto-clean policy |
| `/api/system/activity/policy` | PUT | Owner session or accepted Matrix bearer/JWT | No | Mutating policy update; `bodyLimit` required |
| `/api/system/activity/history` | GET | Owner session or accepted Matrix bearer/JWT | No | Bounded audit history |

## GET `/api/system/activity`

Returns a bounded activity snapshot for the current machine.

### Query Parameters

| Name | Type | Required | Rules |
| --- | --- | --- | --- |
| `processLimit` | integer | No | 1-100, default 25 |
| `includeSuggestions` | boolean | No | default true |

### Response `200`

```json
{
  "generatedAt": "2026-06-07T17:30:00.000Z",
  "machine": {
    "handle": "hamedmp",
    "runtimeSlot": "primary",
    "hostname": "matrix-hamedmp-bdbdbbb5",
    "status": "healthy",
    "releaseVersion": "v2026.06.07-316",
    "releaseChannel": "dev",
    "gitCommit": "e7e2ef8",
    "uptimeSeconds": 2960000
  },
  "resources": {
    "cpu": {
      "cores": 2,
      "load1": 0.58,
      "load5": 0.88,
      "load15": 0.60,
      "pressureSome10": 5.23
    },
    "memory": {
      "totalBytes": 4096000000,
      "usedBytes": 1932735283,
      "availableBytes": 2040109465,
      "processRssBytes": 1600000000,
      "cgroupAnonBytes": 450000000,
      "cgroupFileBytes": 170000000,
      "cgroupKernelBytes": 47000000
    },
    "swap": {
      "totalBytes": 0,
      "usedBytes": 0
    },
    "disk": [
      {
        "mount": "/",
        "label": "System",
        "usedBytes": 63350767616,
        "totalBytes": 80530636800,
        "usedPercent": 82
      }
    ]
  },
  "services": [
    {
      "serviceId": "matrix-gateway",
      "state": "running",
      "memoryBytes": 685232128,
      "cpuSeconds": 815,
      "tasks": 79
    }
  ],
  "processes": [
    {
      "processRef": "proc_opaque_1",
      "pid": 2336842,
      "ownerClass": "matrix",
      "classification": "matrix_service",
      "displayName": "matrix-gateway",
      "cpuPercent": 2,
      "rssBytes": 360000000,
      "elapsedSeconds": 3700,
      "ports": [4000]
    }
  ],
  "cleanupSuggestions": [
    {
      "candidateId": "cand_opaque_1",
      "type": "stop_stale_app_server",
      "targetLabel": "matrix-beta-crm preview server",
      "reason": "No active connections and executable no longer matches the current runtime.",
      "confidence": "high",
      "risk": "low",
      "estimatedReclaimBytes": 104857600,
      "requiresConfirmation": true,
      "confirmationToken": "confirm_opaque_1",
      "expiresAt": "2026-06-07T17:35:00.000Z"
    }
  ],
  "collectionWarnings": []
}
```

### Error Responses

- `401`: unauthenticated.
- `403`: authenticated but not owner for this runtime.
- `500`: generic collection failure.

## POST `/api/system/activity/actions`

Executes one typed cleanup action against a server-generated cleanup candidate.

### Request

```json
{
  "type": "stop_stale_app_server",
  "candidateId": "cand_opaque_1",
  "confirmationToken": "confirm_opaque_1",
  "mode": "manual"
}
```

### Validation

- Request body limit: 16 KiB.
- `type` must be one of:
  - `stop_stale_app_server`
  - `close_stale_terminal_session`
  - `restart_idle_code_server`
  - `clean_cache_scope`
  - `prune_old_bundle`
- `candidateId` and `confirmationToken` are opaque bounded strings issued by the latest `CleanupCandidate` response.
- `mode` is `manual` or `automatic`.
- When `mode` is `automatic`, the server must verify auto-clean policy is enabled, `type` is in `allowedTypes`, and the policy `maxActionsPerHour` budget has not been exhausted before executing.
- Server must re-read the target and verify the candidate still matches before mutation.

### Response `200`

```json
{
  "actionId": "act_opaque_1",
  "result": "completed",
  "reclaimedBytes": 104857600,
  "message": "Cleanup completed.",
  "snapshotRefreshRecommended": true
}
```

### Idempotent Response `200`

```json
{
  "actionId": "act_opaque_2",
  "result": "already_clean",
  "message": "The target was already clean.",
  "snapshotRefreshRecommended": true
}
```

### Error Responses

- `400`: invalid payload.
- `401`: unauthenticated.
- `403`: not owner or policy not allowed.
- `409`: candidate expired, target changed, or confirmation mismatch.
- `500`: generic cleanup failure.

## GET `/api/system/activity/policy`

Returns current auto-clean policy.

### Response `200`

```json
{
  "enabled": false,
  "allowedTypes": [],
  "gracePeriodSeconds": 1800,
  "maxActionsPerHour": 3,
  "lastUpdatedAt": "2026-06-07T17:30:00.000Z"
}
```

## PUT `/api/system/activity/policy`

Updates auto-clean policy.

### Request

```json
{
  "enabled": true,
  "allowedTypes": ["stop_stale_app_server", "clean_cache_scope"],
  "gracePeriodSeconds": 3600,
  "maxActionsPerHour": 2
}
```

### Validation

- Request body limit: 16 KiB.
- Only these conservative action types are accepted for automation in v1:
  - `stop_stale_app_server` when confidence is `high`, risk is `low`, the executable is stale, and there are no active connections.
  - `clean_cache_scope` for allowlisted cache scopes only.
  - `prune_old_bundle` for inactive, non-rollback host bundles only.
- `close_stale_terminal_session` and `restart_idle_code_server` are manual-only in v1.
- `gracePeriodSeconds` must be 300-86400.
- `maxActionsPerHour` must be 1-12.

### Response `200`

Returns the saved policy after validation and normalization.

```json
{
  "enabled": true,
  "allowedTypes": ["stop_stale_app_server", "clean_cache_scope"],
  "gracePeriodSeconds": 3600,
  "maxActionsPerHour": 2,
  "lastUpdatedAt": "2026-06-07T17:45:00.000Z"
}
```

### Error Responses

| Status | Reason |
| --- | --- |
| 400 | Invalid policy body, unsupported action type, or bounds violation |
| 401 | Missing owner authentication |
| 403 | Authenticated principal is not the machine owner |
| 500 | Policy could not be persisted |

## GET `/api/system/activity/history`

Returns bounded cleanup history.

### Query Parameters

| Name | Type | Required | Rules |
| --- | --- | --- | --- |
| `limit` | integer | No | 1-100, default 25 |
| `cursor` | string | No | opaque bounded cursor |

### Response `200`

```json
{
  "entries": [
    {
      "id": "hist_opaque_1",
      "createdAt": "2026-06-07T17:31:00.000Z",
      "actor": "owner",
      "actionType": "stop_stale_app_server",
      "targetLabel": "matrix-beta-crm preview server",
      "result": "completed",
      "reclaimedBytes": 104857600,
      "reasonCode": "stale_app_server_no_connections"
    }
  ],
  "nextCursor": null
}
```

## Resource Management Requirements

- Process and service collectors must use bounded subprocess timeouts.
- Any in-memory candidate cache must have a maximum size and TTL eviction.
- Cleanup history retention must be bounded.
- Temp files used during cleanup must be created exclusively and removed through symlink-safe cleanup.
- Shutdown drains must clear candidate timers and auto-clean intervals.
