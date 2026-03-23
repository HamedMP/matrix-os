# Spec 050: App Data Layer

**Goal**: Unified, Postgres-backed data persistence for all apps. One Postgres per user, one schema per app, queryable from any channel (web, Telegram, Discord, etc.) via a single Kysely-powered data layer. Coding agents choose the right storage at build time; all apps declare their data shape in the manifest.

**Supersedes**: 040-storage sections C and D (SQLite for apps, PostgreSQL addon). Sections A (S3), B (git), and E (isolation) from 040 remain valid and complementary.

## Problem

1. App data is stored as flat JSON files (`~/data/{app}/{key}.json`) -- no querying, no relations, no transactions
2. Agents from non-web channels (Telegram, Discord) must parse raw JSON blobs to answer "what tasks are due this week?"
3. The existing `bridge-sql.ts` (per-app SQLite) and `postgres-manager.ts` (per-app Postgres databases) are disconnected from each other and from the bridge data API
4. No unified query API -- iframe apps use `MatrixOS.readData()`, agents use `app_data` IPC tool, both just do file I/O
5. App manifests have no `storage` field -- the AI agent has no metadata about where/how an app stores data
6. Cross-app queries are impossible (each app is a separate SQLite file or JSON blob)

## Solution

### Architecture

```
User's Container
  |
  +-- PostgreSQL 16 (single instance per user, in container or external)
  |     |
  |     +-- public schema
  |     |     +-- _apps table (registry + schema snapshots)
  |     |     +-- _kv table (backwards-compat key-value store)
  |     |
  |     +-- todo schema (created by coding agent)
  |     |     +-- tasks table
  |     |     +-- categories table
  |     |
  |     +-- budget schema (created by coding agent)
  |     |     +-- transactions table
  |     |     +-- accounts table
  |     |
  |     +-- (one schema per app)
  |
  +-- Gateway (Kysely instance)
  |     +-- POST /api/bridge/query  <-- iframe apps (MatrixOS.db.*)
  |     +-- POST /api/bridge/data   <-- legacy JSON compat (reads from _kv)
  |     +-- app_data IPC tool       <-- kernel agents (any channel)
  |
  +-- App manifests declare storage:
        matrix.json -> "storage": { "tables": {...} }
```

### A: One Postgres Per User

- Docker: Postgres service in docker-compose, shared volume for data
- Dev: Postgres runs locally or in Docker (connection string in env)
- Cloud: connect to managed Postgres (Neon, Supabase) -- just change `DATABASE_URL`
- Backup: `pg_dump` the entire user's data in one shot
- Each user's Postgres is isolated (multi-tenant via platform service)

### B: Schema-Per-App Isolation

- Each app slug becomes a Postgres schema: `CREATE SCHEMA {slug}`
- App name uniqueness enforced by Postgres (can't create duplicate schemas)
- Cross-app queries work via schema-qualified names: `SELECT * FROM todo.tasks JOIN budget.categories ON ...`
- Clean removal: `DROP SCHEMA {slug} CASCADE`
- The `public` schema is reserved for OS-level tables (`_apps`, `_kv`)

### C: `_apps` Registry Table

```sql
CREATE TABLE public._apps (
  slug        text PRIMARY KEY,
  name        text NOT NULL,
  description text,
  version     text DEFAULT '1.0.0',
  author      text,
  category    text,
  tables      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
```

The `tables` column stores a JSON schema snapshot that agents introspect:

```json
{
  "tasks": {
    "columns": {
      "id": { "type": "uuid", "primary": true },
      "title": { "type": "text", "nullable": false },
      "done": { "type": "boolean", "default": false },
      "due": { "type": "timestamptz" },
      "category": { "type": "text" }
    },
    "indexes": ["due", "category"]
  }
}
```

### D: Unified Query API (Kysely)

One query handler that both the bridge HTTP endpoint and IPC tool use:

**Filter syntax** (MongoDB-inspired, agent-friendly):
```json
{
  "done": false,
  "due": { "$lte": "2026-03-21" },
  "category": { "$in": ["work", "urgent"] },
  "title": { "$like": "%milk%" }
}
```

**Operations**: find, findOne, insert, update, delete, count, createTable, dropTable, schema, listApps

**Kysely translates filters to SQL** -- apps and agents never write SQL directly.

### E: Manifest Storage Field

```json
{
  "name": "Task Manager",
  "storage": {
    "tables": {
      "tasks": {
        "columns": {
          "title": "text",
          "done": "boolean",
          "due": "timestamptz",
          "category": "text",
          "priority": "integer"
        },
        "indexes": ["due", "category"]
      },
      "categories": {
        "columns": {
          "name": "text",
          "color": "text"
        }
      }
    }
  }
}
```

When the gateway discovers a new app with a `storage` field:
1. Create Postgres schema for the app
2. Create tables from the manifest
3. Register in `_apps` with schema snapshot
4. App is immediately queryable from any channel

### F: Bridge Client (MatrixOS.db)

Injected into iframe apps alongside existing `MatrixOS.readData()`:

```javascript
MatrixOS.db.find('tasks', { where: { done: false }, orderBy: { due: 'asc' }, limit: 10 })
MatrixOS.db.insert('tasks', { title: 'Buy milk', done: false })
MatrixOS.db.update('tasks', id, { done: true })
MatrixOS.db.delete('tasks', id)
MatrixOS.db.count('tasks', { done: false })
MatrixOS.db.onChange('tasks', (event) => { /* re-render */ })
```

Legacy `MatrixOS.readData()`/`writeData()` continue to work, backed by `public._kv` table.

### G: Migration

**Code migration:**
- `app-data.ts` (JSON file handler): replaced by Kysely query handler, then removed
- `bridge-sql.ts` (per-app SQLite): deprecated, kept for backwards compat during transition
- `postgres-manager.ts` (per-app Postgres databases): replaced by schema-per-app model

**Data migration (running containers):**
- Migration script reads all `~/data/{app}/{key}.json` files
- For each app: creates schema, inserts JSON data into `_kv` table (key-value compat)
- For apps with SQLite databases: reads tables, recreates in Postgres schema
- Migration is idempotent and non-destructive (JSON files not deleted)

**App migration (existing HTML apps):**
- Existing apps using `MatrixOS.readData()`/`writeData()` continue to work (backed by `_kv`)
- New apps use `MatrixOS.db.*` API
- Coding agent skill updated with new patterns
- Pre-installed apps (todo, notes, expense-tracker) migrated to `MatrixOS.db.*` in a separate task

## Non-Goals

- Multi-database support (one Postgres is sufficient per user)
- Connection pooling optimization (single user, low concurrency)
- Managed Postgres UI (connection string in env is enough)
- Full ORM with relations/migrations (Kysely query builder is sufficient)

## Dependencies

- Docker compose changes (add Postgres service)
- Kysely + pg npm packages
- Existing: gateway server, IPC server, os-bridge, app-manifest

## Success Metrics

- Agent from Telegram can query any app's data without parsing JSON blobs
- New app with `storage` in manifest gets working database tables on first boot
- Existing apps using `readData()`/`writeData()` continue to work unchanged
- Cross-app query works: "show my budget alongside my todo list"
- Migration script converts all JSON files to Postgres without data loss
- `bun run test` passes with all new + existing tests
