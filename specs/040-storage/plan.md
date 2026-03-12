# Plan: Storage (Disk + Database)

**Spec**: spec.md
**Tasks**: tasks.md

## Execution Order

```
Phase A: S3 Sync (T1500-T1505)            -- foundation: durable storage
  |
  +---> Phase B: Git Enhancements (T1510-T1513) -- depends on S3 for binary backup
  |
Phase C: SQLite (T1520-T1523)             -- independent of S3, uses bridge API
  |
Phase D: PostgreSQL (T1530-T1534)          -- depends on app runtime (038) for manifest
```

## Phase Breakdown

### Week 1: S3 Foundation
- S3 sync daemon (T1500-T1502)
- Boot recovery (T1503)
- .syncignore (T1504)
- Test: kill container, recover from S3

### Week 2: Git + SQLite (parallel)
- **Stream 1**: Git auto-commit, snapshots, history API (T1510-T1513)
- **Stream 2**: SQLite bridge API, scoping, backup (T1520-T1523)

### Week 3: PostgreSQL
- Postgres service manager (T1530)
- Per-app database provisioning (T1531)
- Backup + activation flow (T1532-T1533)
- Storage usage tracking (T1534)

## Key Decisions

1. **S3 as durable store, local disk as cache**: Local disk is fast but ephemeral. S3 is slow but permanent. Write-through sync gives both speed and durability.
2. **SQLite via bridge API**: Apps don't run their own SQLite process. Gateway manages the database on behalf of apps. This keeps apps simple (just HTTP calls) and enforces isolation.
3. **PostgreSQL as single instance**: One Postgres per user, many databases inside. Cheaper and simpler than one Postgres per app. Still isolated via roles.
4. **Git for text, S3 for everything**: Git excels at text diffs and history. S3 excels at binary storage and durability. Use both for their strengths.

## Risk Mitigation

- **S3 costs**: Enable S3 Intelligent-Tiering. Set lifecycle policy: move old versions to Glacier after 90 days.
- **Sync conflicts**: S3 is single-writer (one container per user). No conflict possible. If multi-device support added later, use S3 versioning + merge strategy.
- **PostgreSQL resource usage**: Idle Postgres uses ~30MB RAM. Auto-stop after 30 minutes of inactivity, auto-start on first connection.
- **SQLite corruption**: WAL mode (already default in better-sqlite3). Hourly `.dump` backup catches corruption early.
