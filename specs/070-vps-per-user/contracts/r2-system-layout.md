# Contract: R2 System Layout

Extends spec 066 `matrixos-sync/{userId}/` layout.

```text
matrixos-sync/{userId}/
├── manifest.json
├── files/...
└── system/
    ├── vps-meta.json
    └── db/
        ├── latest
        └── snapshots/
            ├── 2026-04-26T1200Z.dump
            └── 2026-04-26T1800Z.dump
```

## `system/vps-meta.json`

```json
{
  "version": 1,
  "userId": "user_2x...",
  "machineId": "9f05824c-...",
  "hetznerServerId": 12345678,
  "imageVersion": "matrix-os-host-2026.04.26-1",
  "status": "running",
  "provisionedAt": "2026-04-26T10:00:00Z",
  "lastSyncAt": "2026-04-26T18:05:00Z",
  "publicIPv4": "1.2.3.4",
  "publicIPv6": "2a01:4f8:..."
}
```

Validation:

- `version` must be `1`.
- `userId` must match the R2 prefix owner.
- `lastSyncAt` must be ISO 8601 UTC.
- `status` is `running` in phase 1.

## `system/db/latest`

Plain UTF-8 text containing the latest snapshot key:

```text
system/db/snapshots/2026-04-26T1800Z.dump
```

Validation:

- Must reference a key under `system/db/snapshots/`.
- Must not contain absolute paths, `..`, URL schemes, or control characters.
- Restore refuses a missing referenced object.

## `system/db/snapshots/<ts>.dump`

Custom-format Postgres dump created by `pg_dump --format=custom` and restored directly with `pg_restore`.

Filename:

```text
YYYY-MM-DDTHHmmZ.dump
```

Restore process must stream/download with `AbortSignal.timeout(30_000)` or equivalent host timeout, verify non-empty object size, and fail closed if `pg_restore` fails.

## Retention

Retention pruning is deferred in this slice. Future pruning algorithm requirements:

- List only `system/db/snapshots/`.
- Sort by parsed UTC timestamp, not lexicographic fallback alone.
- Keep the object referenced by `latest`.
- Bound deletions per run to avoid runaway cleanup; default max 100 deletes per run.
- Log generic failure categories, not signed URLs or credentials.

## Ownership and Access

- R2 credentials or presigned flows must be scoped to `matrixos-sync/{userId}/`.
- The control plane can read/write `system/vps-meta.json` and inspect `system/db/latest` for recovery checks.
- Customer VPS can read/write its own `system/` subtree and spec 066 file sync objects.
- No cross-user R2 keys are accepted from request bodies.
