# Tasks: Storage (Disk + Database)

**Spec**: spec.md
**Task range**: T1500-T1539
**Parallel**: S3 sync (A) and SQLite (C) are independent. PostgreSQL (D) depends on app runtime (038). Git enhancements (B) are independent.
**Deps**: Existing git, bridge API, file watcher

## User Stories

- **US74**: "If my server dies, I can recover everything from S3 -- like my own iCloud"
- **US75**: "My files are automatically versioned and I can browse/restore any version"
- **US76**: "My app can use SQLite via a simple API without any setup"
- **US77**: "For advanced apps, I can activate PostgreSQL and each app gets its own database"
- **US78**: "I can see how much storage I'm using (disk, database, S3)"

---

## Phase A: S3 Backup Layer (T1500-T1509)

### Tests (TDD)

- [ ] T1500a [US74] Write `tests/gateway/s3-sync.test.ts`:
  - Sync daemon uploads changed files to S3
  - .syncignore excludes specified patterns
  - On boot with empty disk: pulls from S3
  - Periodic reconciliation detects missed writes
  - Binary files (images, sqlite) synced correctly
  - S3 path: `{handle}/{relative-path}` structure

### T1500 [US74] S3 sync daemon
- [ ] Create `packages/gateway/src/s3-sync.ts`
- [ ] Uses AWS SDK v3 (`@aws-sdk/client-s3`)
- [ ] `S3SyncDaemon` class: `start()`, `stop()`, `syncFile(path)`, `fullSync()`, `restore()`
- [ ] Watch for file changes (integrate with existing file watcher)
- [ ] Upload changed files async (don't block writes)
- [ ] Configurable bucket + prefix in config.json

### T1501 [US74] Write-through sync
- [ ] On file write event: queue S3 upload
- [ ] Debounce: wait 2 seconds after last write before uploading (batch rapid changes)
- [ ] Upload queue: max 10 concurrent uploads, retry on failure (3 attempts)
- [ ] Error logging: failed uploads logged to activity log

### T1502 [US74] Periodic reconciliation
- [ ] Every 5 minutes: compare local file list with S3 inventory
- [ ] Upload any files that exist locally but not in S3
- [ ] Detect: files modified locally but not uploaded (edge case recovery)
- [ ] Log reconciliation stats (files checked, uploads needed)

### T1503 [US74] Boot recovery
- [ ] On gateway boot: check if home directory is empty/missing
- [ ] If empty: pull entire home from S3 (`fullRestore()`)
- [ ] Progress logging: "Restoring 234 files from backup..."
- [ ] After restore: re-initialize git, restart apps, resume normal operation
- [ ] Config: `S3_BUCKET`, `S3_PREFIX`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`

### T1504 [US74] .syncignore
- [ ] `home/.syncignore` template with defaults: `node_modules/`, `.cache/`, `tmp/`, `*.log`
- [ ] Parser: glob patterns like .gitignore
- [ ] Applied during both upload and download

### T1505 [US74] S3 versioning
- [ ] Enable S3 bucket versioning (one-time setup)
- [ ] Files have version history in S3 (automatic, no extra code needed)
- [ ] `GET /api/files/s3-versions/:path` -- list S3 versions for a file
- [ ] `POST /api/files/s3-restore/:path?versionId=...` -- restore specific S3 version

---

## Phase B: Git Versioning Enhancements (T1510-T1514)

### Tests (TDD)

- [ ] T1510a [US75] Write `tests/gateway/git-versioning.test.ts`:
  - Auto-commit creates commit every N minutes with change summary
  - Named snapshot creates tagged commit
  - File history returns commit log for specific file
  - File restore checks out specific version

### T1510 [US75] Auto-commit service
- [ ] Create `packages/gateway/src/git-auto-commit.ts`
- [ ] Timer: every 10 minutes, check for uncommitted changes
- [ ] If changes: `git add -A && git commit -m "Auto-save: {summary}"`
- [ ] Summary: count of files changed, top 3 file names
- [ ] Respect .gitignore (no binaries, no node_modules)

### T1511 [US75] Named snapshots
- [ ] IPC tool: `create_snapshot({ name })` -- creates tagged git commit
- [ ] `git tag -a "snapshot/{name}" -m "{name}"`
- [ ] API: `POST /api/files/snapshot` -> creates snapshot
- [ ] API: `GET /api/files/snapshots` -> list all snapshots

### T1512 [US75] File history API
- [ ] `GET /api/files/history/:path` -- returns `[{ commit, message, date, author }]`
- [ ] Uses `git log --follow -- {path}`
- [ ] Pagination: `?limit=20&offset=0`
- [ ] Diff: `GET /api/files/diff/:path?commit=abc123` returns diff

### T1513 [US75] File restore API
- [ ] `POST /api/files/restore/:path` with body `{ commit: "abc123" }`
- [ ] `git show {commit}:{path} > {path}` (restore single file)
- [ ] Creates a new commit: "Restored {path} from {commit}"
- [ ] Triggers S3 sync for restored file

---

## Phase C: SQLite for Apps (T1520-T1524)

### Tests (TDD)

- [ ] T1520a [US76] Write `tests/gateway/bridge-sql.test.ts`:
  - POST /api/bridge/sql executes SELECT query
  - INSERT/UPDATE/DELETE work
  - App scoping: can only access own database
  - SQL injection prevention (parameterized queries)
  - Database auto-created on first query
  - Schema migrations via CREATE TABLE IF NOT EXISTS

### T1520 [US76] Bridge SQL API
- [ ] New route: `POST /api/bridge/sql`
- [ ] Request: `{ appName, sql, params }` (parameterized)
- [ ] Response: `{ rows, changes, lastInsertRowid }`
- [ ] Uses `better-sqlite3` (synchronous, fast)
- [ ] Database path: `~/data/{appName}/db.sqlite`
- [ ] Auto-create database file and ~/data/{appName}/ directory on first query

### T1521 [US76] App scoping and security
- [ ] Validate appName matches request origin (bridge API existing pattern)
- [ ] No cross-app database access
- [ ] Reject dangerous SQL: `ATTACH DATABASE`, `PRAGMA journal_mode` (whitelist safe PRAGMAs)
- [ ] Max query result size: 1MB
- [ ] Max database size: 100MB per app (configurable)

### T1522 [US76] SQLite backup to S3
- [ ] Hourly: run `.dump` on each app's SQLite -> `{appName}/db.sql` (text, git-friendly)
- [ ] Daily: full `.sqlite` file copy to S3
- [ ] Restore: download from S3, replace local file
- [ ] Track backup status in `~/system/logs/backup.jsonl`

### T1523 [US76] SQLite client library for apps
- [ ] `home/templates/sqlite-client.js` -- copy-paste snippet for app developers
- [ ] Wraps `fetch('/api/bridge/sql', ...)` with convenience methods
- [ ] Methods: `query(sql, params)`, `run(sql, params)`, `get(sql, params)`
- [ ] Include in build-for-matrix skill as recommended pattern

---

## Phase D: PostgreSQL Addon (T1530-T1539)

### Tests (TDD)

- [ ] T1530a [US77] Write `tests/gateway/postgres-addon.test.ts`:
  - Activate PostgreSQL: starts Postgres process
  - Create app database: new DB + role created
  - Connection string returned for app
  - Per-app isolation: role can only access its own DB
  - Deactivate: stops Postgres, data preserved

### T1530 [US77] PostgreSQL service manager
- [ ] Create `packages/gateway/src/postgres-manager.ts`
- [ ] `PostgresManager` class: `activate()`, `deactivate()`, `createAppDatabase(appName)`, `getConnectionString(appName)`
- [ ] Starts PostgreSQL 16 via Docker (postgres:16-alpine) or native `pg_ctl`
- [ ] Single instance per user, multiple databases inside
- [ ] Data directory: `~/system/postgres/data/`
- [ ] Port: 5432 (internal to container)

### T1531 [US77] Per-app database provisioning
- [ ] On app registration with `"database": "postgres"` in matrix.json:
  - Create database: `CREATE DATABASE {appName_db}`
  - Create role: `CREATE ROLE app_{appName} WITH LOGIN PASSWORD '{generated}'`
  - Grant: `GRANT ALL ON DATABASE {appName_db} TO app_{appName}`
  - Revoke public access
- [ ] Store credentials in `~/system/postgres/credentials.json` (encrypted at rest)
- [ ] Inject `DATABASE_URL` as env var when starting app process

### T1532 [US77] PostgreSQL backup
- [ ] Daily: `pg_dump` per database -> S3
- [ ] Hourly: WAL archiving to S3 (point-in-time recovery)
- [ ] Restore: `pg_restore` from S3 dump
- [ ] Track backup status in backup.jsonl

### T1533 [US77] Activation flow
- [ ] API: `POST /api/postgres/activate` -- starts PostgreSQL, returns status
- [ ] API: `POST /api/postgres/deactivate` -- stops PostgreSQL (data preserved on disk + S3)
- [ ] API: `GET /api/postgres/status` -- running, databases, storage used
- [ ] Chat: "activate postgresql" -> AI calls activate API

### T1534 [US78] Storage usage tracking
- [ ] Create `packages/gateway/src/storage-tracker.ts`
- [ ] Measure: disk usage (`du -sh ~/matrixos/`), S3 usage, SQLite sizes, Postgres data size
- [ ] Store in `~/system/logs/storage.jsonl` (daily measurement)
- [ ] API: `GET /api/storage/usage` -- returns breakdown by type
- [ ] Platform: aggregate per-user for billing (future)

---

## Checkpoint

1. [ ] `bun run test` passes with all storage tests
2. [ ] Write a file -> appears in S3 within 10 seconds
3. [ ] Kill container, boot new one -> home directory restored from S3
4. [ ] App queries SQLite via bridge: `POST /api/bridge/sql` returns rows
5. [ ] SQLite backed up hourly (`.dump` text file in S3)
6. [ ] Activate PostgreSQL -> `GET /api/postgres/status` shows running
7. [ ] App with `"database": "postgres"` gets DATABASE_URL injected automatically
8. [ ] `GET /api/storage/usage` shows breakdown: disk 2.3GB, S3 2.3GB, Postgres 150MB
9. [ ] File history: `GET /api/files/history/apps/chess/index.html` shows 10 commits
10. [ ] Restore file from git history -> file reverted, S3 updated
