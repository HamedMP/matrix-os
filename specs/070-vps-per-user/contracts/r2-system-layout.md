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
            ├── 2026-04-26T1200Z.sql.gz
            └── 2026-04-26T1800Z.sql.gz
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
system/db/snapshots/2026-04-26T1800Z.sql.gz
```

Validation:

- Must reference a key under `system/db/snapshots/`.
- Must not contain absolute paths, `..`, URL schemes, or control characters.
- Restore refuses a missing referenced object.

## `system/db/snapshots/<ts>.sql.gz`

Compressed custom-format Postgres dump.

Filename:

```text
YYYY-MM-DDTHHmmZ.sql.gz
```

Restore process must stream/download with `AbortSignal.timeout(30_000)` or equivalent host timeout, verify non-empty object size, and fail closed if decompression or `pg_restore` fails.

## Retention

The customer VPS backup job keeps last 24 hourly and last 14 daily snapshots.

Pruning algorithm requirements:

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
