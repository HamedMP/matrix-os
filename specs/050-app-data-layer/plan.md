# App Data Layer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace flat JSON file persistence with a unified Postgres-backed data layer using Kysely, accessible from all channels via a single query API.

**Architecture:** One Postgres per user (in-container or external), one Postgres schema per app, Kysely as query builder. Two access paths: HTTP bridge (iframe apps) and IPC tool (kernel agents from any channel). Legacy `readData()`/`writeData()` backed by a `_kv` compat table.

**Tech Stack:** Kysely (query builder), pg (Postgres driver), pglite (in-memory Postgres for tests), PostgreSQL 16, Zod 4 (validation), Vitest (testing)

**Testing Strategy:** Unit tests use `pglite` (embedded Postgres in WASM -- no Docker needed, runs in `bun run test`). Integration tests use real Postgres via Docker. This ensures 99%+ coverage in the standard test run.

**Kernel-to-Gateway Communication:** The kernel runs as a subprocess of the gateway. For app data queries, the kernel's `app_data` IPC tool calls the gateway's HTTP API at `http://localhost:${PORT}/api/bridge/query` (PORT defaults to 4000, passed via `GATEWAY_PORT` env var set by the gateway when spawning the kernel).

---

## File Structure

```
packages/gateway/src/
  app-db.ts              -- NEW: Kysely pool, connection, schema management
  app-db-query.ts        -- NEW: filter-to-Kysely translator, CRUD operations
  app-db-registry.ts     -- NEW: _apps table management, schema introspection
  app-db-migration.ts    -- NEW: JSON/SQLite -> Postgres migration script
  app-db-kv.ts           -- NEW: _kv compat layer (readData/writeData backed by Postgres)
  bridge-sql.ts          -- KEEP: deprecated, used during migration window
  postgres-manager.ts    -- KEEP: deprecated, used during migration window
  app-manifest.ts        -- MODIFY: add storage field to Zod schema
  server.ts              -- MODIFY: add /api/bridge/query endpoint, update /api/bridge/data
  app-data.ts (kernel)   -- REPLACE: file-based -> delegates to gateway Kysely layer

packages/kernel/src/
  app-data.ts            -- MODIFY: query handler delegates to Postgres via IPC
  ipc-server.ts          -- MODIFY: update app_data tool with new actions

shell/src/lib/
  os-bridge.ts           -- MODIFY: add MatrixOS.db.* client API

docker-compose.yml       -- MODIFY: add postgres service
.env.docker              -- MODIFY: add DATABASE_URL

tests/
  gateway/app-db.test.ts           -- NEW: connection, schema creation
  gateway/app-db-query.test.ts     -- NEW: filter translation, CRUD
  gateway/app-db-registry.test.ts  -- NEW: _apps table, introspection
  gateway/app-db-kv.test.ts        -- NEW: _kv compat layer
  gateway/app-db-migration.test.ts -- NEW: JSON/SQLite migration
  kernel/app-data-tool.test.ts     -- MODIFY: update for new actions
```

---

## Chunk 1: Foundation (Kysely + Postgres + Docker)

### Task 1: Add dependencies and Docker Postgres service

**Files:**
- Modify: `packages/gateway/package.json`
- Modify: `docker-compose.yml`
- Modify: `.env.docker`

- [ ] **Step 1: Add Kysely, pg, and pglite dependencies**

```bash
cd /Users/hamed/dev/claude-tools/matrix-os
pnpm add -F @matrix-os/gateway kysely pg
pnpm add -D -F @matrix-os/gateway @types/pg @electric-sql/pglite kysely-pglite
```

Note: `pglite` is an embedded Postgres that runs in-process (WASM). Used for unit tests only -- no Docker or external Postgres needed for `bun run test`.

- [ ] **Step 2: Add Postgres to docker-compose files**

Add a `postgres` service to **both** `docker-compose.yml` (production) and `docker-compose.dev.yml` (development). The dev compose is what `bun run docker` uses.

```yaml
# In both compose files:
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: matrixos
      POSTGRES_PASSWORD: matrixos
      POSTGRES_DB: matrixos
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U matrixos"]
      interval: 10s
      timeout: 5s
      start_period: 10s

  matrix-os:
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://matrixos:matrixos@postgres:5432/matrixos
    # ... keep all existing config ...

volumes:
  pgdata:  # add to existing volumes section
```

For multi-user profiles (alice, bob): each user service should depend on a shared postgres or their own. For simplicity, share one Postgres instance -- each user gets their own database (created at provisioning by the platform service). Add `DATABASE_URL` to alice/bob service environments too.

**Do NOT modify `.env.docker`** -- it contains API keys and should not have DATABASE_URL (the compose environment section handles it).

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/package.json pnpm-lock.yaml docker-compose.yml docker-compose.dev.yml
git commit -m "chore: add Kysely, pg, pglite, and Postgres Docker service"
```

---

### Task 2: Kysely connection pool and bootstrap

**Files:**
- Create: `packages/gateway/src/app-db.ts`
- Test: `tests/gateway/app-db.test.ts`

- [ ] **Step 1: Write failing tests for connection and bootstrap**

```typescript
// tests/gateway/app-db.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db.js";
import { PGlite } from "@electric-sql/pglite";

// Use pglite for unit tests -- no external Postgres needed
// This runs an embedded Postgres in-process via WASM

describe("AppDb connection", () => {
  let db: AppDb;
  let pglite: PGlite;

  beforeEach(async () => {
    // pglite creates an in-memory Postgres instance
    pglite = new PGlite();
    db = createAppDb({ pool: pglite });
    await db.bootstrap();
  });

  afterEach(async () => {
    await db.raw("DROP SCHEMA IF EXISTS test_app CASCADE");
    await db.destroy();
    await pglite.close();
  });

  it("bootstraps _apps and _kv tables in public schema", async () => {
    const tables = await db.raw(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('_apps', '_kv') ORDER BY table_name"
    );
    expect(tables.rows.map((r: any) => r.table_name)).toEqual(["_apps", "_kv"]);
  });

  it("creates a schema for an app", async () => {
    await db.createAppSchema("test_app");
    const schemas = await db.raw(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'test_app'"
    );
    expect(schemas.rows).toHaveLength(1);
  });

  it("drops a schema for an app", async () => {
    await db.createAppSchema("test_app");
    await db.dropAppSchema("test_app");
    const schemas = await db.raw(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'test_app'"
    );
    expect(schemas.rows).toHaveLength(0);
  });

  it("rejects invalid schema names", async () => {
    await expect(db.createAppSchema("../evil")).rejects.toThrow(/invalid/i);
    await expect(db.createAppSchema("")).rejects.toThrow(/invalid/i);
    await expect(db.createAppSchema("DROP TABLE")).rejects.toThrow(/invalid/i);
  });

  it("creates tables in app schema from column definitions", async () => {
    await db.createAppSchema("test_app");
    await db.createTable("test_app", "items", {
      title: "text",
      done: "boolean",
      count: "integer",
    });

    const cols = await db.raw(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'test_app' AND table_name = 'items' ORDER BY ordinal_position"
    );
    const colNames = cols.rows.map((r: any) => r.column_name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("title");
    expect(colNames).toContain("done");
    expect(colNames).toContain("created_at");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `DATABASE_URL=postgresql://matrixos:matrixos@localhost:5432/matrixos bun run vitest run tests/gateway/app-db.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement AppDb**

```typescript
// packages/gateway/src/app-db.ts
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";

const SAFE_SLUG = /^[a-z][a-z0-9_-]{0,62}$/;

function validateSlug(slug: string): void {
  if (!SAFE_SLUG.test(slug)) {
    throw new Error(`Invalid app slug: ${slug}`);
  }
}

export interface AppDb {
  kysely: Kysely<any>;
  bootstrap(): Promise<void>;
  createAppSchema(slug: string): Promise<void>;
  dropAppSchema(slug: string): Promise<void>;
  createTable(
    schema: string,
    table: string,
    columns: Record<string, string>,
    indexes?: string[],
  ): Promise<void>;
  raw(query: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  destroy(): Promise<void>;
}

const TYPE_MAP: Record<string, string> = {
  text: "text",
  string: "text",
  boolean: "boolean",
  bool: "boolean",
  integer: "integer",
  int: "integer",
  float: "double precision",
  number: "double precision",
  date: "date",
  timestamptz: "timestamptz",
  timestamp: "timestamptz",
  json: "jsonb",
  jsonb: "jsonb",
  uuid: "uuid",
};

function pgType(t: string): string {
  return TYPE_MAP[t.toLowerCase()] ?? "text";
}

// Accepts either a connection string (production) or a pool/pglite instance (testing)
export function createAppDb(opts: string | { pool: any }): AppDb {
  let kysely: Kysely<any>;

  if (typeof opts === "string") {
    const pool = new pg.Pool({ connectionString: opts, max: 10 });
    kysely = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
  } else {
    // For pglite or custom pool (testing)
    kysely = new Kysely<any>({ dialect: new PostgresDialect({ pool: opts.pool }) });
  }

  return {
    kysely,

    async bootstrap(): Promise<void> {
      await sql`
        CREATE TABLE IF NOT EXISTS public._apps (
          slug        text PRIMARY KEY,
          name        text NOT NULL,
          description text,
          version     text DEFAULT '1.0.0',
          author      text,
          category    text,
          tables      jsonb NOT NULL DEFAULT '{}',
          created_at  timestamptz DEFAULT now(),
          updated_at  timestamptz DEFAULT now()
        )
      `.execute(kysely);

      await sql`
        CREATE TABLE IF NOT EXISTS public._kv (
          app         text NOT NULL,
          key         text NOT NULL,
          value       text,
          updated_at  timestamptz DEFAULT now(),
          PRIMARY KEY (app, key)
        )
      `.execute(kysely);
    },

    async createAppSchema(slug: string): Promise<void> {
      validateSlug(slug);
      const identifier = sql.raw(`"${slug.replace(/"/g, '""')}"`);
      await sql`CREATE SCHEMA IF NOT EXISTS ${identifier}`.execute(kysely);
    },

    async dropAppSchema(slug: string): Promise<void> {
      validateSlug(slug);
      const identifier = sql.raw(`"${slug.replace(/"/g, '""')}"`);
      await sql`DROP SCHEMA IF EXISTS ${identifier} CASCADE`.execute(kysely);
    },

    async createTable(
      schema: string,
      table: string,
      columns: Record<string, string>,
      indexes?: string[],
    ): Promise<void> {
      validateSlug(schema);
      if (!SAFE_SLUG.test(table)) throw new Error(`Invalid table name: ${table}`);

      const colDefs = Object.entries(columns)
        .map(([name, type]) => `"${name}" ${pgType(type)}`)
        .join(", ");

      const fullTable = `"${schema}"."${table}"`;
      await sql
        .raw(
          `CREATE TABLE IF NOT EXISTS ${fullTable} (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            ${colDefs},
            created_at timestamptz DEFAULT now(),
            updated_at timestamptz DEFAULT now()
          )`,
        )
        .execute(kysely);

      if (indexes) {
        for (const col of indexes) {
          if (!SAFE_SLUG.test(col)) continue;
          const idxName = `idx_${schema}_${table}_${col}`;
          await sql
            .raw(
              `CREATE INDEX IF NOT EXISTS "${idxName}" ON ${fullTable} ("${col}")`,
            )
            .execute(kysely);
        }
      }
    },

    async raw(
      query: string,
      params?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[] }> {
      const result = await pool.query(query, params);
      return { rows: result.rows };
    },

    async destroy(): Promise<void> {
      await kysely.destroy();
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `DATABASE_URL=postgresql://matrixos:matrixos@localhost:5432/matrixos bun run vitest run tests/gateway/app-db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/app-db.ts tests/gateway/app-db.test.ts
git commit -m "feat: Kysely-backed AppDb with schema-per-app model"
```

---

### Task 3: App registry (_apps table management)

**Files:**
- Create: `packages/gateway/src/app-db-registry.ts`
- Test: `tests/gateway/app-db-registry.test.ts`

- [ ] **Step 1: Write failing tests for registry**

```typescript
// tests/gateway/app-db-registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db.js";
import {
  createAppRegistry,
  type AppRegistry,
} from "../../packages/gateway/src/app-db-registry.js";
import { PGlite } from "@electric-sql/pglite";

describe("AppRegistry", () => {
  let db: AppDb;
  let registry: AppRegistry;
  let pglite: PGlite;

  beforeEach(async () => {
    pglite = new PGlite();
    db = createAppDb({ pool: pglite });
    await db.bootstrap();
    registry = createAppRegistry(db);
  });

  afterEach(async () => {
    await db.raw("DELETE FROM public._apps");
    await db.raw("DROP SCHEMA IF EXISTS todo CASCADE");
    await db.raw("DROP SCHEMA IF EXISTS notes CASCADE");
    await db.destroy();
    await pglite.close();
  });

  it("registers an app with schema and tables", async () => {
    await registry.register({
      slug: "todo",
      name: "Todo",
      tables: {
        tasks: {
          columns: { title: "text", done: "boolean", due: "timestamptz" },
          indexes: ["due"],
        },
      },
    });

    const app = await registry.get("todo");
    expect(app).toBeDefined();
    expect(app!.name).toBe("Todo");
    expect(app!.tables).toHaveProperty("tasks");
  });

  it("creates Postgres schema and tables on register", async () => {
    await registry.register({
      slug: "todo",
      name: "Todo",
      tables: {
        tasks: {
          columns: { title: "text", done: "boolean" },
        },
      },
    });

    // Verify schema exists
    const schemas = await db.raw(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'todo'"
    );
    expect(schemas.rows).toHaveLength(1);

    // Verify table exists with correct columns
    const cols = await db.raw(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'todo' AND table_name = 'tasks'"
    );
    const colNames = cols.rows.map((r: any) => r.column_name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("title");
    expect(colNames).toContain("done");
  });

  it("lists all registered apps", async () => {
    await registry.register({ slug: "todo", name: "Todo", tables: {} });
    await registry.register({ slug: "notes", name: "Notes", tables: {} });

    const apps = await registry.listApps();
    expect(apps).toHaveLength(2);
    expect(apps.map((a) => a.slug).sort()).toEqual(["notes", "todo"]);
  });

  it("returns schema info for agent introspection", async () => {
    await registry.register({
      slug: "todo",
      name: "Todo",
      tables: {
        tasks: {
          columns: { title: "text", done: "boolean", due: "timestamptz" },
          indexes: ["due"],
        },
      },
    });

    const schema = await registry.getSchema("todo");
    expect(schema).toHaveProperty("tasks");
    expect(schema.tasks.columns).toHaveProperty("title");
  });

  it("unregisters an app and drops schema", async () => {
    await registry.register({ slug: "todo", name: "Todo", tables: {} });
    await registry.unregister("todo");

    const app = await registry.get("todo");
    expect(app).toBeNull();

    const schemas = await db.raw(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'todo'"
    );
    expect(schemas.rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `DATABASE_URL=... bun run vitest run tests/gateway/app-db-registry.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement AppRegistry**

```typescript
// packages/gateway/src/app-db-registry.ts
import { sql } from "kysely";
import type { AppDb } from "./app-db.js";

interface TableDef {
  columns: Record<string, string>;
  indexes?: string[];
}

interface RegisterOpts {
  slug: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  category?: string;
  tables: Record<string, TableDef>;
}

interface AppRecord {
  slug: string;
  name: string;
  description: string | null;
  version: string;
  author: string | null;
  category: string | null;
  tables: Record<string, TableDef>;
  created_at: string;
  updated_at: string;
}

export interface AppRegistry {
  register(opts: RegisterOpts): Promise<void>;
  unregister(slug: string): Promise<void>;
  get(slug: string): Promise<AppRecord | null>;
  listApps(): Promise<AppRecord[]>;
  getSchema(slug: string): Promise<Record<string, TableDef>>;
}

export function createAppRegistry(db: AppDb): AppRegistry {
  const { kysely } = db;

  return {
    async register(opts: RegisterOpts): Promise<void> {
      await db.createAppSchema(opts.slug);

      for (const [tableName, tableDef] of Object.entries(opts.tables)) {
        await db.createTable(opts.slug, tableName, tableDef.columns, tableDef.indexes);
      }

      await sql`
        INSERT INTO public._apps (slug, name, description, version, author, category, tables, updated_at)
        VALUES (
          ${opts.slug}, ${opts.name}, ${opts.description ?? null},
          ${opts.version ?? "1.0.0"}, ${opts.author ?? null},
          ${opts.category ?? null}, ${JSON.stringify(opts.tables)}::jsonb,
          now()
        )
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          version = EXCLUDED.version,
          tables = EXCLUDED.tables,
          updated_at = now()
      `.execute(kysely);
    },

    async unregister(slug: string): Promise<void> {
      await db.dropAppSchema(slug);
      await sql`DELETE FROM public._apps WHERE slug = ${slug}`.execute(kysely);
    },

    async get(slug: string): Promise<AppRecord | null> {
      const result = await sql<AppRecord>`
        SELECT * FROM public._apps WHERE slug = ${slug}
      `.execute(kysely);
      return (result.rows[0] as AppRecord) ?? null;
    },

    async listApps(): Promise<AppRecord[]> {
      const result = await sql<AppRecord>`
        SELECT * FROM public._apps ORDER BY name
      `.execute(kysely);
      return result.rows as AppRecord[];
    },

    async getSchema(slug: string): Promise<Record<string, TableDef>> {
      const app = await this.get(slug);
      if (!app) throw new Error(`App not found: ${slug}`);
      return app.tables;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/app-db-registry.ts tests/gateway/app-db-registry.test.ts
git commit -m "feat: app registry with schema-per-app provisioning"
```

---

## Chunk 2: Query Engine

### Task 4: Filter-to-Kysely translator and CRUD operations

**Files:**
- Create: `packages/gateway/src/app-db-query.ts`
- Test: `tests/gateway/app-db-query.test.ts`

- [ ] **Step 1: Write failing tests for CRUD + filter translation**

```typescript
// tests/gateway/app-db-query.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAppDb, type AppDb } from "../../packages/gateway/src/app-db.js";
import { createAppRegistry } from "../../packages/gateway/src/app-db-registry.js";
import { createQueryEngine, type QueryEngine } from "../../packages/gateway/src/app-db-query.js";
import { PGlite } from "@electric-sql/pglite";

describe("QueryEngine", () => {
  let db: AppDb;
  let engine: QueryEngine;
  let pglite: PGlite;

  beforeEach(async () => {
    pglite = new PGlite();
    db = createAppDb({ pool: pglite });
    await db.bootstrap();
    const registry = createAppRegistry(db);
    await registry.register({
      slug: "todo",
      name: "Todo",
      tables: {
        tasks: {
          columns: { title: "text", done: "boolean", due: "timestamptz", priority: "integer" },
          indexes: ["due"],
        },
      },
    });
    engine = createQueryEngine(db);
  });

  afterEach(async () => {
    await db.raw("DROP SCHEMA IF EXISTS todo CASCADE");
    await db.raw("DELETE FROM public._apps");
    await db.destroy();
    await pglite.close();
  });

  it("inserts a row and returns id", async () => {
    const result = await engine.insert("todo", "tasks", {
      title: "Buy milk",
      done: false,
      priority: 1,
    });
    expect(result.id).toBeDefined();
    expect(typeof result.id).toBe("string"); // uuid
  });

  it("finds rows with no filter", async () => {
    await engine.insert("todo", "tasks", { title: "A", done: false });
    await engine.insert("todo", "tasks", { title: "B", done: true });

    const rows = await engine.find("todo", "tasks");
    expect(rows).toHaveLength(2);
  });

  it("finds rows with equality filter", async () => {
    await engine.insert("todo", "tasks", { title: "A", done: false });
    await engine.insert("todo", "tasks", { title: "B", done: true });

    const rows = await engine.find("todo", "tasks", { filter: { done: false } });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("A");
  });

  it("finds rows with $lte filter", async () => {
    await engine.insert("todo", "tasks", { title: "Soon", due: "2026-03-20T00:00:00Z", done: false });
    await engine.insert("todo", "tasks", { title: "Later", due: "2026-04-01T00:00:00Z", done: false });

    const rows = await engine.find("todo", "tasks", {
      filter: { due: { $lte: "2026-03-21T00:00:00Z" } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Soon");
  });

  it("finds rows with $in filter", async () => {
    await engine.insert("todo", "tasks", { title: "A", priority: 1, done: false });
    await engine.insert("todo", "tasks", { title: "B", priority: 2, done: false });
    await engine.insert("todo", "tasks", { title: "C", priority: 3, done: false });

    const rows = await engine.find("todo", "tasks", {
      filter: { priority: { $in: [1, 3] } },
    });
    expect(rows).toHaveLength(2);
  });

  it("finds rows with $like filter", async () => {
    await engine.insert("todo", "tasks", { title: "Buy milk", done: false });
    await engine.insert("todo", "tasks", { title: "Buy eggs", done: false });
    await engine.insert("todo", "tasks", { title: "Clean house", done: false });

    const rows = await engine.find("todo", "tasks", {
      filter: { title: { $like: "Buy%" } },
    });
    expect(rows).toHaveLength(2);
  });

  it("supports orderBy and limit", async () => {
    await engine.insert("todo", "tasks", { title: "C", priority: 3, done: false });
    await engine.insert("todo", "tasks", { title: "A", priority: 1, done: false });
    await engine.insert("todo", "tasks", { title: "B", priority: 2, done: false });

    const rows = await engine.find("todo", "tasks", {
      orderBy: { priority: "asc" },
      limit: 2,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe("A");
    expect(rows[1].title).toBe("B");
  });

  it("supports offset for pagination", async () => {
    await engine.insert("todo", "tasks", { title: "A", priority: 1, done: false });
    await engine.insert("todo", "tasks", { title: "B", priority: 2, done: false });
    await engine.insert("todo", "tasks", { title: "C", priority: 3, done: false });

    const rows = await engine.find("todo", "tasks", {
      orderBy: { priority: "asc" },
      limit: 2,
      offset: 1,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe("B");
    expect(rows[1].title).toBe("C");
  });

  it("updates a row by id", async () => {
    const { id } = await engine.insert("todo", "tasks", { title: "Buy milk", done: false });
    await engine.update("todo", "tasks", id, { done: true });

    const rows = await engine.find("todo", "tasks", { filter: { id } });
    expect(rows[0].done).toBe(true);
  });

  it("deletes a row by id", async () => {
    const { id } = await engine.insert("todo", "tasks", { title: "Delete me", done: false });
    await engine.delete("todo", "tasks", id);

    const rows = await engine.find("todo", "tasks");
    expect(rows).toHaveLength(0);
  });

  it("counts rows with filter", async () => {
    await engine.insert("todo", "tasks", { title: "A", done: false });
    await engine.insert("todo", "tasks", { title: "B", done: true });
    await engine.insert("todo", "tasks", { title: "C", done: false });

    const total = await engine.count("todo", "tasks");
    expect(total).toBe(3);

    const undone = await engine.count("todo", "tasks", { done: false });
    expect(undone).toBe(2);
  });

  it("findOne returns single row or null", async () => {
    const { id } = await engine.insert("todo", "tasks", { title: "Only one", done: false });

    const row = await engine.findOne("todo", "tasks", id);
    expect(row).toBeDefined();
    expect(row!.title).toBe("Only one");

    const missing = await engine.findOne("todo", "tasks", "00000000-0000-0000-0000-000000000000");
    expect(missing).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL

- [ ] **Step 3: Implement QueryEngine**

```typescript
// packages/gateway/src/app-db-query.ts
import { sql, type Kysely } from "kysely";
import type { AppDb } from "./app-db.js";

const SAFE_NAME = /^[a-z][a-z0-9_-]{0,62}$/;

function validateName(name: string, label: string): void {
  if (!SAFE_NAME.test(name)) throw new Error(`Invalid ${label}: ${name}`);
}

// Intentional: sql.raw() is used for schema-qualified dynamic table names.
// Safety is enforced by validateName() which restricts to [a-z0-9_-].
// Hyphens are safe inside double-quoted identifiers ("my-app"."my-table").
function qualifiedTable(schema: string, table: string): string {
  return `"${schema}"."${table}"`;
}

type FilterValue =
  | string | number | boolean | null
  | { $eq?: unknown; $ne?: unknown; $lt?: unknown; $lte?: unknown;
      $gt?: unknown; $gte?: unknown; $in?: unknown[]; $like?: string; $ilike?: string };

interface FindOptions {
  filter?: Record<string, FilterValue>;
  orderBy?: Record<string, "asc" | "desc">;
  limit?: number;
  offset?: number;
}

export interface QueryEngine {
  find(schema: string, table: string, opts?: FindOptions): Promise<Record<string, unknown>[]>;
  findOne(schema: string, table: string, id: string): Promise<Record<string, unknown> | null>;
  insert(schema: string, table: string, data: Record<string, unknown>): Promise<{ id: string }>;
  update(schema: string, table: string, id: string, data: Record<string, unknown>): Promise<void>;
  delete(schema: string, table: string, id: string): Promise<void>;
  count(schema: string, table: string, filter?: Record<string, FilterValue>): Promise<number>;
}

export function createQueryEngine(db: AppDb): QueryEngine {
  const { kysely } = db;

  function buildWhere(filter: Record<string, FilterValue>): string[] {
    const clauses: string[] = [];
    for (const [col, val] of Object.entries(filter)) {
      validateName(col, "column");
      if (val === null) {
        clauses.push(`"${col}" IS NULL`);
      } else if (typeof val !== "object" || val instanceof Date) {
        // Plain equality: { done: false }
        clauses.push(`"${col}" = ${sql.lit(val)}`);
      } else {
        // Operator object: { due: { $lte: "2026-03-21" } }
        const ops = val as Record<string, unknown>;
        if ("$eq" in ops) clauses.push(`"${col}" = ${sql.lit(ops.$eq)}`);
        if ("$ne" in ops) clauses.push(`"${col}" != ${sql.lit(ops.$ne)}`);
        if ("$lt" in ops) clauses.push(`"${col}" < ${sql.lit(ops.$lt)}`);
        if ("$lte" in ops) clauses.push(`"${col}" <= ${sql.lit(ops.$lte)}`);
        if ("$gt" in ops) clauses.push(`"${col}" > ${sql.lit(ops.$gt)}`);
        if ("$gte" in ops) clauses.push(`"${col}" >= ${sql.lit(ops.$gte)}`);
        if ("$in" in ops && Array.isArray(ops.$in)) {
          const vals = ops.$in.map((v) => sql.lit(v)).join(", ");
          clauses.push(`"${col}" IN (${vals})`);
        }
        if ("$like" in ops) clauses.push(`"${col}" LIKE ${sql.lit(ops.$like)}`);
        if ("$ilike" in ops) clauses.push(`"${col}" ILIKE ${sql.lit(ops.$ilike)}`);
      }
    }
    return clauses;
  }

  return {
    async find(schema, table, opts) {
      validateName(schema, "schema"); validateName(table, "table");
      const qt = qualifiedTable(schema, table);

      let q = `SELECT * FROM ${qt}`;
      if (opts?.filter && Object.keys(opts.filter).length > 0) {
        q += ` WHERE ${buildWhere(opts.filter).join(" AND ")}`;
      }
      if (opts?.orderBy) {
        const parts = Object.entries(opts.orderBy).map(([col, dir]) => {
          validateName(col, "column");
          return `"${col}" ${dir === "desc" ? "DESC" : "ASC"}`;
        });
        q += ` ORDER BY ${parts.join(", ")}`;
      }
      if (opts?.limit) q += ` LIMIT ${Number(opts.limit)}`;
      if (opts?.offset) q += ` OFFSET ${Number(opts.offset)}`;

      const result = await db.raw(q);
      return result.rows;
    },

    async findOne(schema, table, id) {
      validateName(schema, "schema"); validateName(table, "table");
      const result = await db.raw(
        `SELECT * FROM ${qualifiedTable(schema, table)} WHERE id = $1`,
        [id],
      );
      return (result.rows[0] as Record<string, unknown>) ?? null;
    },

    async insert(schema, table, data) {
      validateName(schema, "schema"); validateName(table, "table");
      const cols = Object.keys(data).filter((c) => { validateName(c, "column"); return true; });
      const vals = cols.map((c) => data[c]);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      const colNames = cols.map((c) => `"${c}"`).join(", ");

      const result = await db.raw(
        `INSERT INTO ${qualifiedTable(schema, table)} (${colNames}) VALUES (${placeholders}) RETURNING id`,
        vals,
      );
      return { id: (result.rows[0] as any).id };
    },

    async update(schema, table, id, data) {
      validateName(schema, "schema"); validateName(table, "table");
      const cols = Object.keys(data).filter((c) => { validateName(c, "column"); return true; });
      const sets = cols.map((c, i) => `"${c}" = $${i + 1}`).join(", ");
      const vals = [...cols.map((c) => data[c]), id];

      await db.raw(
        `UPDATE ${qualifiedTable(schema, table)} SET ${sets}, updated_at = now() WHERE id = $${vals.length}`,
        vals,
      );
    },

    async delete(schema, table, id) {
      validateName(schema, "schema"); validateName(table, "table");
      await db.raw(`DELETE FROM ${qualifiedTable(schema, table)} WHERE id = $1`, [id]);
    },

    async count(schema, table, filter) {
      validateName(schema, "schema"); validateName(table, "table");
      let q = `SELECT count(*)::int as count FROM ${qualifiedTable(schema, table)}`;
      if (filter && Object.keys(filter).length > 0) {
        q += ` WHERE ${buildWhere(filter).join(" AND ")}`;
      }
      const result = await db.raw(q);
      return (result.rows[0] as any).count;
    },
  };
}
```

Key design decisions:
- Schema-qualified table: `"todo"."tasks"` -- hyphens are safe inside double-quoted identifiers
- Filter operators: `$eq`, `$ne`, `$lt`, `$lte`, `$gt`, `$gte`, `$in`, `$like`, `$ilike`
- Plain values treated as `$eq`
- All queries use parameterized placeholders (`$1`, `$2`, ...) where possible
- `sql.lit()` used for filter values in WHERE clauses (Kysely's safe literal interpolation)
- `id`, `created_at`, `updated_at` are auto-managed columns
- `validateName()` is the security boundary -- restricts identifiers to `[a-z0-9_-]`

- [ ] **Step 4: Run tests to verify they pass**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/app-db-query.ts tests/gateway/app-db-query.test.ts
git commit -m "feat: query engine with filter-to-Kysely translation"
```

---

### Task 5: Key-value compatibility layer (_kv table)

**Files:**
- Create: `packages/gateway/src/app-db-kv.ts`
- Test: `tests/gateway/app-db-kv.test.ts`

- [ ] **Step 1: Write failing tests for _kv compat**

Tests should verify:
- `read(app, key)` returns value or null
- `write(app, key, value)` upserts into `_kv` table
- `list(app)` returns all keys for an app
- Backwards-compatible with existing `readData()`/`writeData()` behavior
- Values stored as text (JSON strings), same as current file-based API

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement KvStore**

```typescript
// packages/gateway/src/app-db-kv.ts
import { sql } from "kysely";
import type { AppDb } from "./app-db.js";

export interface KvStore {
  read(app: string, key: string): Promise<string | null>;
  write(app: string, key: string, value: string): Promise<void>;
  list(app: string): Promise<string[]>;
}

export function createKvStore(db: AppDb): KvStore {
  const { kysely } = db;

  return {
    async read(app, key) {
      const result = await sql<{ value: string }>`
        SELECT value FROM public._kv WHERE app = ${app} AND key = ${key}
      `.execute(kysely);
      return (result.rows[0] as any)?.value ?? null;
    },

    async write(app, key, value) {
      await sql`
        INSERT INTO public._kv (app, key, value, updated_at)
        VALUES (${app}, ${key}, ${value}, now())
        ON CONFLICT (app, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `.execute(kysely);
    },

    async list(app) {
      const result = await sql<{ key: string }>`
        SELECT key FROM public._kv WHERE app = ${app} ORDER BY key
      `.execute(kysely);
      return result.rows.map((r: any) => r.key);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/app-db-kv.ts tests/gateway/app-db-kv.test.ts
git commit -m "feat: key-value compat layer backed by Postgres _kv table"
```

---

## Chunk 3: Integration (Gateway + IPC + Bridge)

### Task 6: Update app manifest schema with storage field

**Files:**
- Modify: `packages/gateway/src/app-manifest.ts`

- [ ] **Step 1: Add storage field to AppManifestSchema**

Add to the existing Zod schema:

```typescript
const StorageTableSchema = z.object({
  columns: z.record(z.string()),
  indexes: z.array(z.string()).optional(),
});

const StorageSchema = z.object({
  tables: z.record(StorageTableSchema).default({}),
}).optional();

// Add to AppManifestSchema:
storage: StorageSchema,
```

- [ ] **Step 2: Update existing tests to pass with new optional field**

Run: `bun run vitest run tests/gateway/app-manifest.test.ts` (if exists, else verify no regressions with `bun run test`)

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/app-manifest.ts
git commit -m "feat: add storage field to app manifest schema"
```

---

### Task 7: Wire AppDb into gateway server

**Files:**
- Modify: `packages/gateway/src/server.ts`

- [ ] **Step 1: Initialize AppDb on gateway boot**

In `createServer()`, after existing setup:

```typescript
import { createAppDb } from "./app-db.js";
import { createAppRegistry } from "./app-db-registry.js";
import { createQueryEngine } from "./app-db-query.js";
import { createKvStore } from "./app-db-kv.js";

// In createServer():
const databaseUrl = process.env.DATABASE_URL;
let appDb: AppDb | null = null;
let queryEngine: QueryEngine | null = null;
let kvStore: KvStore | null = null;
let appRegistry: AppRegistry | null = null;

if (databaseUrl) {
  appDb = createAppDb(databaseUrl);
  await appDb.bootstrap();
  queryEngine = createQueryEngine(appDb);
  kvStore = createKvStore(appDb);
  appRegistry = createAppRegistry(appDb);

  // Register apps that have storage in their manifest
  const apps = listApps(homePath);
  for (const app of apps) {
    const manifest = loadAppManifest(join(homePath, "apps", app.file.replace(/\/index\.html$/, "")));
    if (manifest?.storage?.tables) {
      await appRegistry.register({
        slug: app.file.replace(/\/index\.html$/, "").replace(/\.html$/, ""),
        name: app.name,
        description: app.description,
        tables: manifest.storage.tables,
      });
    }
  }
}
```

- [ ] **Step 2: Add POST /api/bridge/query endpoint**

```typescript
import { z } from "zod/v4";

const BridgeQuerySchema = z.object({
  app: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/),
  action: z.enum(["find", "findOne", "insert", "update", "delete", "count", "schema", "listApps"]),
  table: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/).optional(),
  filter: z.record(z.unknown()).optional(),
  data: z.record(z.unknown()).optional(),
  id: z.string().optional(),
  orderBy: z.record(z.enum(["asc", "desc"])).optional(),
  limit: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});

app.post("/api/bridge/query", async (c) => {
  if (!queryEngine || !appRegistry) return c.json({ error: "Database not configured" }, 503);

  const parsed = BridgeQuerySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const body = parsed.data;

  try {
    switch (body.action) {
      case "find":
        return c.json(await queryEngine.find(body.app, body.table!, {
          filter: body.filter,
          orderBy: body.orderBy,
          limit: body.limit,
          offset: body.offset,
        }));
      case "findOne":
        return c.json(await queryEngine.findOne(body.app, body.table!, body.id!));
      case "insert": {
        const result = await queryEngine.insert(body.app, body.table!, body.data!);
        broadcast({ type: "data:change", app: body.app, key: body.table! });
        return c.json(result, 201);
      }
      case "update": {
        await queryEngine.update(body.app, body.table!, body.id!, body.data!);
        broadcast({ type: "data:change", app: body.app, key: body.table! });
        return c.json({ ok: true });
      }
      case "delete": {
        await queryEngine.delete(body.app, body.table!, body.id!);
        broadcast({ type: "data:change", app: body.app, key: body.table! });
        return c.json({ ok: true });
      }
      case "count":
        return c.json({ count: await queryEngine.count(body.app, body.table!, body.filter) });
      case "schema":
        return c.json(await appRegistry.getSchema(body.app));
      case "listApps":
        return c.json(await appRegistry.listApps());
    }
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
```

- [ ] **Step 3: Update existing /api/bridge/data to use _kv when available**

Replace the file-based read/write in the existing `/api/bridge/data` handler. When `kvStore` is available, use it. Fall back to file-based for containers without Postgres.

```typescript
app.post("/api/bridge/data", async (c) => {
  const body = await c.req.json<{
    action: "read" | "write";
    app: string;
    key: string;
    value?: string;
  }>();

  const safeApp = body.app.replace(/[^a-zA-Z0-9_-]/g, "");
  const safeKey = body.key.replace(/[^a-zA-Z0-9_-]/g, "");

  // Use Postgres _kv when available, fall back to files
  if (kvStore) {
    if (body.action === "read") {
      const value = await kvStore.read(safeApp, safeKey);
      return c.json({ value });
    }
    await kvStore.write(safeApp, safeKey, body.value ?? "");
    broadcast({ type: "data:change", app: safeApp, key: safeKey });
    return c.json({ ok: true });
  }

  // ... existing file-based fallback (keep current code) ...
});
```

- [ ] **Step 4: Run full test suite**

Run: `bun run test`
Expected: All existing tests pass (file-based fallback still works without DATABASE_URL)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/server.ts
git commit -m "feat: wire AppDb into gateway with /api/bridge/query endpoint"
```

---

### Task 8: Update app_data IPC tool for kernel agents

**Files:**
- Modify: `packages/kernel/src/ipc-server.ts`
- Modify: `packages/kernel/src/app-data.ts`

- [ ] **Step 1: Extend app_data IPC tool with new actions**

Replace the existing `app_data` tool definition in `ipc-server.ts` with an expanded version that supports both legacy (read/write/list) and new (find/insert/update/delete/count/schema/list_apps) actions.

The tool should:
- Accept `action: "find" | "insert" | "update" | "delete" | "count" | "schema" | "list_apps" | "read" | "write" | "list"`
- For new actions: HTTP call to gateway's `/api/bridge/query` (the gateway runs Kysely, not the kernel)
- For legacy actions (read/write/list): HTTP call to gateway's `/api/bridge/data`
- `schema` action: returns the `tables` JSON from `_apps` for a given app slug
- `list_apps` action: returns all registered apps with their table schemas

Why HTTP instead of direct Kysely in the kernel? The gateway owns the Postgres connection. The kernel is an Agent SDK process that communicates via IPC. Keeping the DB connection in one place (gateway) avoids connection pool issues.

- [ ] **Step 2: Update tests**

Modify `tests/kernel/app-data-tool.test.ts` to test new actions. Since these require a running gateway, mark them as integration tests with `describe.skipIf(!process.env.GATEWAY_URL)`.

- [ ] **Step 3: Run tests**

Run: `bun run test`
Expected: PASS (unit tests still use file-based, integration tests use gateway)

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/src/ipc-server.ts packages/kernel/src/app-data.ts tests/kernel/app-data-tool.test.ts
git commit -m "feat: extend app_data IPC tool with query engine actions"
```

---

### Task 9: Update MatrixOS.db bridge client

**Files:**
- Modify: `shell/src/lib/os-bridge.ts`

- [ ] **Step 1: Add MatrixOS.db to the bridge script**

In `buildBridgeScript()`, add a `db` namespace to the `window.MatrixOS` object:

```javascript
db: {
  find: function(table, opts) {
    return fetch('/api/bridge/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app: app, action: 'find', table: table,
        filter: opts && opts.where, orderBy: opts && opts.orderBy,
        limit: opts && opts.limit, offset: opts && opts.offset
      })
    }).then(function(r) { return r.json(); });
  },

  findOne: function(table, id) {
    return fetch('/api/bridge/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: app, action: 'findOne', table: table, id: id })
    }).then(function(r) { return r.json(); });
  },

  insert: function(table, data) {
    return fetch('/api/bridge/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: app, action: 'insert', table: table, data: data })
    }).then(function(r) { return r.json(); });
  },

  update: function(table, id, data) {
    return fetch('/api/bridge/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: app, action: 'update', table: table, id: id, data: data })
    }).then(function(r) { return r.json(); });
  },

  delete: function(table, id) {
    return fetch('/api/bridge/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: app, action: 'delete', table: table, id: id })
    }).then(function(r) { return r.json(); });
  },

  count: function(table, filter) {
    return fetch('/api/bridge/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: app, action: 'count', table: table, filter: filter })
    }).then(function(r) { return r.json(); }).then(function(d) { return d.count; });
  },

  onChange: function(table, callback) {
    // Reuse existing dataChangeCallbacks mechanism
    var wrappedCb = function(key, changedApp) {
      if (key === table && changedApp === app) callback({ table: table });
    };
    dataChangeCallbacks.push(wrappedCb);
    return function() {
      var idx = dataChangeCallbacks.indexOf(wrappedCb);
      if (idx >= 0) dataChangeCallbacks.splice(idx, 1);
    };
  }
}
```

- [ ] **Step 2: Add BridgeMessage types for new query messages**

Update `BridgeMessage` type union if needed. The new `MatrixOS.db.*` calls go directly to the gateway (not via postMessage to shell), so no new bridge message types are needed -- they're direct `fetch()` calls from the iframe.

- [ ] **Step 3: Run shell build to verify no TypeScript errors**

Run: `cd shell && bun run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add shell/src/lib/os-bridge.ts
git commit -m "feat: add MatrixOS.db client API to bridge script"
```

---

## Chunk 4: Migration

### Task 10: JSON-to-Postgres migration script

**Files:**
- Create: `packages/gateway/src/app-db-migration.ts`
- Test: `tests/gateway/app-db-migration.test.ts`

- [ ] **Step 1: Write failing tests for migration**

Tests should verify:
- Reads all `~/data/{app}/{key}.json` files
- Creates a `_kv` entry for each file
- Idempotent: running twice doesn't duplicate data
- Handles malformed JSON gracefully (stores raw string)
- Reports migration stats (apps migrated, keys migrated, errors)

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement migration**

```typescript
// packages/gateway/src/app-db-migration.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { KvStore } from "./app-db-kv.js";

interface MigrationResult {
  apps: number;
  keys: number;
  errors: string[];
}

export async function migrateJsonToKv(
  homePath: string,
  kvStore: KvStore,
): Promise<MigrationResult> {
  const dataDir = join(homePath, "data");
  if (!existsSync(dataDir)) return { apps: 0, keys: 0, errors: [] };

  const result: MigrationResult = { apps: 0, keys: 0, errors: [] };

  const appDirs = readdirSync(dataDir).filter((f) =>
    statSync(join(dataDir, f)).isDirectory(),
  );

  for (const appSlug of appDirs) {
    const appDir = join(dataDir, appSlug);
    const jsonFiles = readdirSync(appDir).filter((f) => f.endsWith(".json"));

    if (jsonFiles.length === 0) continue;
    result.apps++;

    for (const file of jsonFiles) {
      const key = file.replace(/\.json$/, "");
      try {
        const content = readFileSync(join(appDir, file), "utf-8");
        await kvStore.write(appSlug, key, content);
        result.keys++;
      } catch (e) {
        result.errors.push(`${appSlug}/${file}: ${(e as Error).message}`);
      }
    }
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/app-db-migration.ts tests/gateway/app-db-migration.test.ts
git commit -m "feat: JSON-to-Postgres migration script for existing app data"
```

---

### Task 11: SQLite-to-Postgres migration

**Files:**
- Modify: `packages/gateway/src/app-db-migration.ts`

- [ ] **Step 1: Add SQLite migration function**

For apps that have `~/data/{app}/db.sqlite`:
- Read all tables from the SQLite database
- Create corresponding tables in the app's Postgres schema
- Copy all rows
- Report stats

```typescript
export async function migrateSqliteToPostgres(
  homePath: string,
  db: AppDb,
  registry: AppRegistry,
): Promise<MigrationResult> {
  // For each ~/data/{app}/db.sqlite:
  // 1. Open SQLite db with better-sqlite3
  // 2. Read table_list pragma
  // 3. For each table: read columns, create in Postgres, copy rows
  // 4. Register in _apps
}
```

- [ ] **Step 2: Write tests for SQLite migration**

Test with a test SQLite database created in a temp directory.

- [ ] **Step 3: Run tests**

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/app-db-migration.ts tests/gateway/app-db-migration.test.ts
git commit -m "feat: SQLite-to-Postgres migration for existing app databases"
```

---

### Task 12: Wire migration into gateway boot

**Files:**
- Modify: `packages/gateway/src/server.ts`

- [ ] **Step 1: Run migration on first boot**

After `appDb.bootstrap()` in the server init:

```typescript
if (databaseUrl && appDb && kvStore) {
  const { migrateJsonToKv, migrateSqliteToPostgres } = await import("./app-db-migration.js");

  // Check if migration already ran (marker in _kv)
  const migrated = await kvStore.read("_system", "migration_v1");
  if (!migrated) {
    console.log("[app-db] Running data migration...");
    const jsonResult = await migrateJsonToKv(homePath, kvStore);
    console.log(`[app-db] JSON migration: ${jsonResult.apps} apps, ${jsonResult.keys} keys`);

    if (appRegistry) {
      const sqliteResult = await migrateSqliteToPostgres(homePath, appDb, appRegistry);
      console.log(`[app-db] SQLite migration: ${sqliteResult.apps} apps, ${sqliteResult.keys} rows`);
    }

    await kvStore.write("_system", "migration_v1", new Date().toISOString());
    console.log("[app-db] Migration complete");
  }
}
```

- [ ] **Step 2: Test by running docker dev**

```bash
bun run docker
# Check logs for migration output
bun run docker:logs
```

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/server.ts
git commit -m "feat: auto-run data migration on first boot with Postgres"
```

---

## Chunk 5: Pre-installed App Migration + Skills

### Task 13: Migrate todo app to MatrixOS.db

**Files:**
- Modify: `home/apps/todo.html`
- Modify: `home/apps/todo.matrix.md` (add storage field to frontmatter)
- Modify: `packages/gateway/src/app-manifest.ts` -- extend `loadAppMeta()` to parse `storage` from `.matrix.md` frontmatter

Note: Keep the single-file structure (`todo.html` + `todo.matrix.md`). Do NOT convert to directory-based app -- it would change the URL path from `/files/apps/todo.html` to `/files/apps/todo/index.html`, breaking window layout persistence and bookmarks.

- [ ] **Step 1: Add storage field to todo.matrix.md frontmatter**

Update the existing `todo.matrix.md` frontmatter to include storage:

```yaml
---
name: Todo
description: Task manager with categories and due dates
icon: todo
category: productivity
storage:
  tables:
    tasks:
      columns:
        title: text
        done: boolean
        due: timestamptz
        category: text
        priority: integer
        notes: text
      indexes:
        - due
        - category
        - done
---
```

Also update the `loadAppMeta()` function in `packages/kernel/src/app-meta.ts` and the gateway's manifest loading to parse the `storage` field from `.matrix.md` YAML frontmatter (in addition to `matrix.json`).

- [ ] **Step 2: Update todo.html to use MatrixOS.db**

Replace `MatrixOS.readData('tasks')` / `MatrixOS.writeData('tasks', JSON.stringify(...))` with:

```javascript
// Load
async function loadTasks() {
  tasks = await MatrixOS.db.find('tasks', {
    orderBy: { due: 'asc', priority: 'desc' }
  });
  render();
}

// Add
async function addTask(title, category, due) {
  const task = await MatrixOS.db.insert('tasks', {
    title, category, due, done: false, priority: 0
  });
  tasks.push({ ...task, title, category, due, done: false });
  render();
}

// Toggle done
async function toggleTask(id) {
  const task = tasks.find(t => t.id === id);
  await MatrixOS.db.update('tasks', id, { done: !task.done });
  task.done = !task.done;
  render();
}

// Delete
async function deleteTask(id) {
  await MatrixOS.db.delete('tasks', id);
  tasks = tasks.filter(t => t.id !== id);
  render();
}

// Listen for changes from other channels
MatrixOS.db.onChange('tasks', loadTasks);
```

- [ ] **Step 3: Test in Docker**

```bash
bun run docker
# Open shell, launch todo app
# Add tasks, toggle done, delete
# Send "what's on my todo list?" via chat -- agent should use app_data to query
```

- [ ] **Step 4: Commit**

```bash
git add home/apps/todo.html home/apps/todo.matrix.md packages/kernel/src/app-meta.ts packages/gateway/src/app-manifest.ts
git commit -m "feat: migrate todo app to MatrixOS.db API"
```

---

### Task 14: Migrate notes and expense-tracker apps

Same pattern as Task 13 for:
- `home/apps/notes.html` -- storage: `{ tables: { entries: { columns: { title: "text", content: "text", pinned: "boolean" } } } }`
- `home/apps/expense-tracker.html` -- storage: `{ tables: { transactions: { columns: { amount: "float", description: "text", category: "text", date: "date", type: "text" } }, accounts: { columns: { name: "text", balance: "float" } } } }`

- [ ] **Step 1: Add matrix.json with storage for notes**
- [ ] **Step 2: Update notes.html to use MatrixOS.db**
- [ ] **Step 3: Add matrix.json with storage for expense-tracker**
- [ ] **Step 4: Update expense-tracker.html to use MatrixOS.db**
- [ ] **Step 5: Test all three apps in Docker**
- [ ] **Step 6: Commit**

```bash
git add home/apps/notes* home/apps/expense-tracker*
git commit -m "feat: migrate notes and expense-tracker to MatrixOS.db"
```

---

### Task 15: Update build-for-matrix skill

**Files:**
- Modify: `home/agents/skills/build-crud-app.md` (or equivalent)

- [ ] **Step 1: Update the skill to teach the AI about MatrixOS.db**

Add to the skill:
- How to declare `storage.tables` in matrix.json
- How to use `MatrixOS.db.find()`, `.insert()`, `.update()`, `.delete()`, `.count()`
- How `onChange` works for real-time updates across channels
- When to use `MatrixOS.readData()`/`writeData()` (simple preferences) vs `MatrixOS.db.*` (structured data)
- Example: complete todo app with MatrixOS.db

- [ ] **Step 2: Commit**

```bash
git add home/agents/skills/build-crud-app.md
git commit -m "docs: update app-building skill with MatrixOS.db patterns"
```

---

### Task 16: Update agent system prompt with app data awareness

**Files:**
- Modify: `packages/kernel/src/prompt.ts` (or wherever system prompt is built)

- [ ] **Step 1: Add app data context to system prompt**

When an agent receives a message, the system prompt should include a brief summary of registered apps and their tables. This allows agents from any channel to know what's queryable:

```
## Available App Data

The following apps have structured data you can query with the app_data tool:

- todo: tasks (title, done, due, category, priority)
- budget: transactions (amount, description, category, date, type)
- notes: entries (title, content, pinned)

Use app_data({ action: "find", app: "todo", table: "tasks", filter: { done: false } }) to query.
```

This is generated dynamically from the `_apps` registry.

- [ ] **Step 2: Run tests**

Expected: PASS (system prompt tests should validate the new section)

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/src/prompt.ts
git commit -m "feat: inject app data registry into agent system prompt"
```

---

## Chunk 6: Deprecation + Cleanup

### Task 17: Mark old code as deprecated

**Files:**
- Modify: `packages/gateway/src/bridge-sql.ts`
- Modify: `packages/gateway/src/postgres-manager.ts`
- Modify: `packages/kernel/src/app-data.ts`

- [ ] **Step 1: Add deprecation comments**

Add `@deprecated` JSDoc comments to:
- `createBridgeSql()` -- "Use AppDb query engine instead. Will be removed in v0.6.0."
- `createPostgresManager()` -- "Use AppDb schema-per-app model instead. Will be removed in v0.6.0."
- `appDataHandler()` -- "File-based handler. Gateway now uses Postgres via KvStore/QueryEngine."

Do NOT delete these files yet -- running containers may still use them during transition.

- [ ] **Step 2: Commit**

```bash
git add packages/gateway/src/bridge-sql.ts packages/gateway/src/postgres-manager.ts packages/kernel/src/app-data.ts
git commit -m "chore: mark bridge-sql, postgres-manager, and file-based app-data as deprecated"
```

---

### Task 18: Update CLAUDE.md and docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `specs/050-app-data-layer/spec.md` (mark completed sections)

- [ ] **Step 1: Add spec 050 to CLAUDE.md active specs list**

- [ ] **Step 2: Update tech stack to mention Kysely**

- [ ] **Step 3: Update "Running the Platform" section with Postgres info**

Add to environment variables:
- `DATABASE_URL`: Postgres connection string (optional for dev, required for cloud)

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with app data layer (spec 050)"
```

---

## Checkpoint

1. [ ] `bun run test` passes with all new + existing tests
2. [ ] Docker dev starts with Postgres, migration runs on first boot
3. [ ] Todo app works with MatrixOS.db (add, toggle, delete tasks)
4. [ ] From chat: "what tasks are due this week?" -- agent queries Postgres via app_data tool
5. [ ] From Telegram: same query works (agent uses same IPC tool)
6. [ ] Legacy apps using readData()/writeData() still work (backed by _kv table)
7. [ ] Cross-app query: agent can query multiple apps in one response
8. [ ] New app with `storage` in matrix.json gets tables created automatically on boot
9. [ ] Migration: existing JSON data accessible via _kv after first Postgres boot
10. [ ] No regressions in existing test suite
