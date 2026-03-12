# Spec 040: Storage (Disk + Database)

**Goal**: Durable, portable storage layer. Disk backed by S3 (your own iCloud). SQLite for simple apps, shared PostgreSQL for advanced apps. Git versioning for all files. Users can destroy their VPS and recover everything from S3.

## Problem

1. Home directory lives on VPS disk -- if container dies, data is lost
2. No backup/restore mechanism beyond git (which doesn't handle binaries well)
3. No database layer for apps -- everything is JSON files via bridge API
4. No way for apps to use a real database (PostgreSQL, etc.)
5. SQLite databases not backed up (binary files in git are problematic)
6. No storage billing -- can't charge for database or disk usage
7. No per-app data isolation for databases

## Solution

### A: S3-Backed File System

The VPS has local disk, but S3 is the durable backing store. Think of it as "your personal iCloud":

**Architecture:**
```
User's Container (VPS)
  ~/matrixos/          <-- local disk (fast reads/writes)
     |
     +-- sync daemon ---> S3 bucket (s3://matrix-users/{handle}/)
                           |
                           +-- versioned objects (S3 versioning enabled)
                           +-- daily snapshots
```

**Sync strategy:**
- **Write-through**: all file writes go to local disk immediately (fast), then async-uploaded to S3
- **Periodic sync**: every 5 minutes, reconcile local <-> S3 (catch any missed writes)
- **On boot**: if local disk is empty (new container), pull entire home directory from S3
- **Git + S3**: git handles text file versioning (diffs, history). S3 handles binary files and full snapshots.

**What gets synced:**
- Everything in `~/matrixos/` except: `node_modules/`, `.cache/`, `tmp/`, running process state
- `.syncignore` file (like .gitignore) for user-controlled exclusions

**Recovery flow:**
1. Container dies / user migrates to new VPS
2. New container boots, no local data
3. Gateway detects empty home, triggers S3 pull
4. Full home directory restored from S3
5. Apps restart, user continues where they left off

### B: Git Versioning

All text files in `~/matrixos/` are git-tracked (existing behavior). Enhancements:

- **Auto-commit**: periodic git commit (every 10 minutes) with summary of changes
- **Named snapshots**: user can say "save a snapshot" -> tagged git commit
- **Browse history**: `GET /api/files/history/:path` returns commit log for a file
- **Restore**: `POST /api/files/restore/:path?commit=abc123` restores a file from history
- **Binary exclusion**: `.gitignore` excludes `.sqlite`, images, media (these are S3-only)

### C: SQLite for Apps

Default database for all apps. Zero config, file-based, works with bridge API:

- Each app gets a SQLite database at `~/data/{appName}/db.sqlite`
- Bridge API extended: `POST /api/bridge/sql` -- execute SQL against app's SQLite
- `better-sqlite3` (synchronous, fast for single-user) or `sql.js` (WASM, for in-browser)
- Drizzle ORM support: apps can include a `drizzle.config.ts` pointing to their SQLite
- **Backup**: SQLite files backed up to S3 separately (not via git -- binary files)
- **Backup strategy**: hourly SQLite backup via `.dump` (text SQL), daily full file copy

**Bridge SQL API:**
```
POST /api/bridge/sql
{
  "appName": "budget-tracker",
  "sql": "SELECT * FROM expenses WHERE month = ?",
  "params": ["2026-03"]
}
```

Scoped: apps can only access their own database. Gateway enforces `appName` matches the calling app's origin.

### D: PostgreSQL Addon

For advanced apps that need a real database (relational, concurrent, full SQL):

**Architecture:**
```
User's Container
  |
  +-- PostgreSQL 16 (single instance per user)
       |
       +-- database: budget_tracker_db
       +-- database: crm_db
       +-- database: analytics_db
       |
       +-- role: app_budget_tracker (limited to its DB)
       +-- role: app_crm (limited to its DB)
```

**How it works:**
- User activates PostgreSQL addon (flat fee per month)
- Single PostgreSQL instance starts in the user's container
- Each app that requests `"database": "postgres"` in matrix.json gets its own database
- Gateway creates database + role automatically on app registration
- Connection string injected as env var: `DATABASE_URL=postgresql://app_name:pass@localhost:5432/app_name_db`
- Apps access Postgres directly (not through bridge API) -- they're server-side apps with their own process

**Resource limits:**
- Default: 1GB storage, 100 connections
- Configurable via platform config

**Billing hooks (schema only, not implemented):**
```
storage_usage table:
  user_id      TEXT
  type         TEXT  -- 'disk' | 'sqlite' | 'postgres' | 's3'
  bytes_used   INTEGER
  measured_at  TEXT
```

### E: Data Isolation

Per-app data boundaries enforced at multiple levels:

- **Bridge API**: gateway validates app origin, scopes to `~/data/{appName}/`
- **SQLite**: each app has its own `.sqlite` file, no cross-app queries
- **PostgreSQL**: each app has its own database + role, no cross-database access
- **S3**: all under user's prefix (`s3://matrix-users/{handle}/`), no cross-user access
- **Files**: apps in `~/apps/{name}/` can only write to `~/data/{name}/` via bridge

## Non-Goals

- Multi-region S3 replication (single region for now)
- Real-time file sync across devices (S3 is the sync point, not peer-to-peer yet)
- Managed database service (users don't pick Postgres version, instance size, etc.)
- Object storage API for apps (S3 is infrastructure, not exposed to apps)

## Dependencies

- Existing: git auto-commit in gateway, bridge API, file watcher
- 038-app-platform: app manifest for database requests
- 008B: platform service for billing schema

## Success Metrics

- Kill a container, boot new one: all data restored from S3 in under 2 minutes
- App reads/writes SQLite via bridge SQL API without any setup
- App with `"database": "postgres"` in manifest gets a working connection string automatically
- File history: browse 30 days of changes for any file
- Storage usage visible to user via API
