# Platform Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add platform-level integrations to Matrix OS so users can connect external services (Gmail, Calendar, Drive, GitHub, Slack, Discord) via settings UI or conversation, and the AI agent can call those services on their behalf.

**Architecture:** Pipedream Connect SDK handles OAuth, credential storage, and API proxying. A new platform Postgres database tracks users, connected services, user apps (local workspace metadata), and billing. Gateway exposes REST endpoints used by both the shell settings UI and the kernel's IPC tools. The kernel gets two new tools: `connect_service` and `call_service`.

**Tech Stack:** Pipedream Connect SDK (`@pipedream/sdk`), Postgres + Kysely (platform DB), Hono (gateway routes), React 19 (shell settings UI), Zod 4 (validation), Vitest (tests)

---

## File Structure

### New Files

```
packages/gateway/src/platform-db.ts            -- Kysely instance + types for platform DB
packages/gateway/src/platform-db-migrate.ts     -- Migration runner (create tables)
packages/gateway/src/integrations/registry.ts   -- Service registry (6 services, actions, params)
packages/gateway/src/integrations/pipedream.ts  -- Pipedream Connect SDK wrapper
packages/gateway/src/integrations/routes.ts     -- Hono routes for /api/integrations/*
packages/gateway/src/integrations/types.ts      -- Shared types for integrations

packages/kernel/src/tools/integrations.ts       -- connect_service + call_service IPC tools

shell/src/components/settings/sections/IntegrationsSection.tsx  -- Settings UI

tests/integrations/platform-db.test.ts          -- Platform DB tests
tests/integrations/registry.test.ts             -- Service registry tests
tests/integrations/pipedream.test.ts            -- Pipedream wrapper tests
tests/integrations/routes.test.ts               -- API route tests
tests/integrations/ipc-tools.test.ts            -- IPC tool tests
tests/integrations/settings-ui.test.ts          -- Shell UI tests
```

### Modified Files

```
packages/gateway/src/server.ts                  -- Mount integration routes, init platform DB
packages/gateway/package.json                   -- Add @pipedream/sdk dependency
packages/kernel/src/ipc-server.ts               -- Add connect_service + call_service tools
packages/kernel/src/options.ts                   -- Add new tool names to IPC_TOOL_NAMES
shell/src/components/settings/SettingsPanel.tsx  -- Add Integrations tab (or equivalent)
docker-compose.dev.yml                          -- Platform Postgres config (may reuse existing)
.env.example                                    -- Add PIPEDREAM_* env vars
```

---

## Task 1: Platform Database Schema + Migrations

**Files:**
- Create: `packages/gateway/src/platform-db.ts`
- Create: `packages/gateway/src/platform-db-migrate.ts`
- Create: `tests/integrations/platform-db.test.ts`

- [ ] **Step 1: Write failing test for platform DB bootstrap**

```typescript
// tests/integrations/platform-db.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";

// Uses pglite for in-memory Postgres in tests (already a devDep in gateway)
import { PGlite } from "@electric-sql/pglite";
import { KyselyPGliteDialect } from "kysely-pglite";

describe("PlatformDb", () => {
  let pg: PGlite;
  let db: PlatformDb;

  beforeEach(async () => {
    pg = await PGlite.create();
    db = createPlatformDb({ dialect: new KyselyPGliteDialect(pg) });
    await db.migrate();
  });

  afterEach(async () => {
    await db.destroy();
    await pg.close();
  });

  it("creates all tables on migrate", async () => {
    const result = await db.raw(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );
    const tables = result.rows.map((r) => r.table_name);
    expect(tables).toContain("users");
    expect(tables).toContain("connected_services");
    expect(tables).toContain("user_apps");
    expect(tables).toContain("event_subscriptions");
    expect(tables).toContain("billing");
  });

  it("inserts and retrieves a user", async () => {
    const user = await db.createUser({
      clerkId: "clerk_123",
      handle: "hamed",
      displayName: "Hamed",
      email: "hamed@matrix-os.com",
      containerId: "container-abc",
    });
    expect(user.id).toBeDefined();
    expect(user.plan).toBe("free");
    expect(user.status).toBe("active");

    const found = await db.getUserByClerkId("clerk_123");
    expect(found?.handle).toBe("hamed");
  });

  it("inserts and lists connected services", async () => {
    const user = await db.createUser({
      clerkId: "clerk_456",
      handle: "alice",
      displayName: "Alice",
      email: "alice@test.com",
      containerId: "container-def",
    });

    await db.connectService({
      userId: user.id,
      service: "gmail",
      pipedreamAccountId: "pd_acc_123",
      accountLabel: "Work Gmail",
      accountEmail: "alice@work.com",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    });

    const services = await db.listConnectedServices(user.id);
    expect(services).toHaveLength(1);
    expect(services[0].service).toBe("gmail");
    expect(services[0].accountLabel).toBe("Work Gmail");
    expect(services[0].status).toBe("active");
  });

  it("disconnects a service", async () => {
    const user = await db.createUser({
      clerkId: "clerk_789",
      handle: "bob",
      displayName: "Bob",
      email: "bob@test.com",
      containerId: "container-ghi",
    });

    const svc = await db.connectService({
      userId: user.id,
      service: "github",
      pipedreamAccountId: "pd_acc_456",
      accountLabel: "GitHub",
      accountEmail: "bob@github.com",
      scopes: ["repo"],
    });

    await db.disconnectService(svc.id);
    const services = await db.listConnectedServices(user.id);
    expect(services).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/hamed/dev/claude-tools/matrix-os && bun run vitest run tests/integrations/platform-db.test.ts`
Expected: FAIL -- `createPlatformDb` not found

- [ ] **Step 3: Implement platform DB module**

```typescript
// packages/gateway/src/platform-db.ts
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";

export interface PlatformDatabase {
  users: {
    id: string;
    clerk_id: string;
    handle: string;
    display_name: string;
    email: string;
    container_id: string;
    container_version: string | null;
    plan: string;
    status: string;
    pipedream_external_id: string | null;
    created_at: Date;
    updated_at: Date;
  };
  connected_services: {
    id: string;
    user_id: string;
    service: string;
    pipedream_account_id: string;
    account_label: string;
    account_email: string | null;
    scopes: string[];
    status: string;
    connected_at: Date;
    last_used_at: Date | null;
  };
  user_apps: {
    id: string;
    user_id: string;
    name: string;
    slug: string;
    description: string | null;
    services_used: string[];
    created_at: Date;
    updated_at: Date;
  };
  event_subscriptions: {
    id: string;
    user_id: string;
    service: string;
    event_type: string;
    status: string;
    created_at: Date;
  };
  billing: {
    id: string;
    user_id: string;
    stripe_customer_id: string | null;
    plan: string;
    connected_services_count: number;
    period_start: Date | null;
    period_end: Date | null;
    status: string;
  };
}

export interface PlatformDb {
  migrate(): Promise<void>;
  destroy(): Promise<void>;
  raw(query: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;

  createUser(input: {
    clerkId: string;
    handle: string;
    displayName: string;
    email: string;
    containerId: string;
  }): Promise<PlatformDatabase["users"]>;

  getUserByClerkId(clerkId: string): Promise<PlatformDatabase["users"] | undefined>;
  getUserById(id: string): Promise<PlatformDatabase["users"] | undefined>;

  connectService(input: {
    userId: string;
    service: string;
    pipedreamAccountId: string;
    accountLabel: string;
    accountEmail?: string;
    scopes: string[];
  }): Promise<PlatformDatabase["connected_services"]>;

  listConnectedServices(userId: string): Promise<PlatformDatabase["connected_services"][]>;
  getConnectedService(id: string): Promise<PlatformDatabase["connected_services"] | undefined>;
  disconnectService(id: string): Promise<void>;
  updateServiceStatus(id: string, status: string): Promise<void>;
  touchServiceUsage(id: string): Promise<void>;
}

export function createPlatformDb(opts: string | { dialect: any }): PlatformDb {
  let kysely: Kysely<PlatformDatabase>;
  let pool: pg.Pool | null = null;

  if (typeof opts === "string") {
    pool = new pg.Pool({ connectionString: opts, max: 10 });
    pool.on("error", (err) => {
      console.error("[platform-db] Idle pool client error:", err.message);
    });
    kysely = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool }) });
  } else {
    kysely = new Kysely<PlatformDatabase>({ dialect: opts.dialect });
  }

  return {
    async migrate() {
      await sql`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          clerk_id TEXT UNIQUE NOT NULL,
          handle TEXT UNIQUE NOT NULL,
          display_name TEXT NOT NULL,
          email TEXT NOT NULL,
          container_id TEXT UNIQUE NOT NULL,
          container_version TEXT,
          plan TEXT NOT NULL DEFAULT 'free',
          status TEXT NOT NULL DEFAULT 'active',
          pipedream_external_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `.execute(kysely);

      await sql`
        CREATE TABLE IF NOT EXISTS connected_services (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          service TEXT NOT NULL,
          pipedream_account_id TEXT NOT NULL,
          account_label TEXT NOT NULL,
          account_email TEXT,
          scopes TEXT[] NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'active',
          connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_used_at TIMESTAMPTZ
        )
      `.execute(kysely);

      await sql`
        CREATE TABLE IF NOT EXISTS user_apps (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          slug TEXT NOT NULL,
          description TEXT,
          services_used TEXT[] NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE(user_id, slug)
        )
      `.execute(kysely);

      await sql`
        CREATE TABLE IF NOT EXISTS event_subscriptions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          service TEXT NOT NULL,
          event_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `.execute(kysely);

      await sql`
        CREATE TABLE IF NOT EXISTS billing (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          stripe_customer_id TEXT,
          plan TEXT NOT NULL DEFAULT 'free',
          connected_services_count INTEGER NOT NULL DEFAULT 0,
          period_start TIMESTAMPTZ,
          period_end TIMESTAMPTZ,
          status TEXT NOT NULL DEFAULT 'active'
        )
      `.execute(kysely);

      await sql`CREATE INDEX IF NOT EXISTS idx_connected_services_user ON connected_services(user_id)`.execute(kysely);
      await sql`CREATE INDEX IF NOT EXISTS idx_user_apps_user ON user_apps(user_id)`.execute(kysely);
      await sql`CREATE INDEX IF NOT EXISTS idx_event_subs_user ON event_subscriptions(user_id)`.execute(kysely);
    },

    async destroy() {
      await kysely.destroy();
      if (pool) await pool.end();
    },

    async raw(query: string, params?: unknown[]) {
      const result = await sql.raw(query, params ?? []).execute(kysely);
      return { rows: result.rows as Record<string, unknown>[] };
    },

    async createUser(input) {
      const row = await kysely
        .insertInto("users")
        .values({
          clerk_id: input.clerkId,
          handle: input.handle,
          display_name: input.displayName,
          email: input.email,
          container_id: input.containerId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return row;
    },

    async getUserByClerkId(clerkId) {
      return kysely.selectFrom("users").selectAll().where("clerk_id", "=", clerkId).executeTakeFirst();
    },

    async getUserById(id) {
      return kysely.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirst();
    },

    async connectService(input) {
      return kysely
        .insertInto("connected_services")
        .values({
          user_id: input.userId,
          service: input.service,
          pipedream_account_id: input.pipedreamAccountId,
          account_label: input.accountLabel,
          account_email: input.accountEmail ?? null,
          scopes: input.scopes,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    async listConnectedServices(userId) {
      return kysely
        .selectFrom("connected_services")
        .selectAll()
        .where("user_id", "=", userId)
        .where("status", "!=", "disconnected")
        .orderBy("connected_at", "desc")
        .execute();
    },

    async getConnectedService(id) {
      return kysely.selectFrom("connected_services").selectAll().where("id", "=", id).executeTakeFirst();
    },

    async disconnectService(id) {
      await kysely.deleteFrom("connected_services").where("id", "=", id).execute();
    },

    async updateServiceStatus(id, status) {
      await kysely.updateTable("connected_services").set({ status }).where("id", "=", id).execute();
    },

    async touchServiceUsage(id) {
      await kysely.updateTable("connected_services").set({ last_used_at: new Date() }).where("id", "=", id).execute();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/hamed/dev/claude-tools/matrix-os && bun run vitest run tests/integrations/platform-db.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/platform-db.ts tests/integrations/platform-db.test.ts
git commit -m "feat(049): add platform database schema and migrations"
```

---

## Task 2: Service Registry

**Files:**
- Create: `packages/gateway/src/integrations/types.ts`
- Create: `packages/gateway/src/integrations/registry.ts`
- Create: `tests/integrations/registry.test.ts`

- [ ] **Step 1: Write failing test for service registry**

```typescript
// tests/integrations/registry.test.ts
import { describe, it, expect } from "vitest";
import { SERVICE_REGISTRY, getService, listServices, getAction } from "../../packages/gateway/src/integrations/registry.js";

describe("ServiceRegistry", () => {
  it("has 6 launch services", () => {
    const services = listServices();
    expect(services).toHaveLength(6);
    expect(services.map((s) => s.id)).toEqual(
      expect.arrayContaining(["gmail", "google_calendar", "google_drive", "github", "slack", "discord"])
    );
  });

  it("returns service by id", () => {
    const gmail = getService("gmail");
    expect(gmail).toBeDefined();
    expect(gmail!.name).toBe("Gmail");
    expect(gmail!.category).toBe("google");
    expect(gmail!.pipedreamApp).toBeDefined();
  });

  it("returns undefined for unknown service", () => {
    expect(getService("unknown_service")).toBeUndefined();
  });

  it("lists actions for a service", () => {
    const gmail = getService("gmail")!;
    expect(Object.keys(gmail.actions)).toContain("list_messages");
    expect(Object.keys(gmail.actions)).toContain("send_email");
    expect(gmail.actions.send_email.params).toHaveProperty("to");
    expect(gmail.actions.send_email.params).toHaveProperty("subject");
    expect(gmail.actions.send_email.params).toHaveProperty("body");
  });

  it("getAction returns action by service + action id", () => {
    const action = getAction("gmail", "send_email");
    expect(action).toBeDefined();
    expect(action!.description).toContain("email");
  });

  it("getAction returns undefined for unknown action", () => {
    expect(getAction("gmail", "nonexistent")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/hamed/dev/claude-tools/matrix-os && bun run vitest run tests/integrations/registry.test.ts`
Expected: FAIL -- cannot resolve module

- [ ] **Step 3: Implement types**

```typescript
// packages/gateway/src/integrations/types.ts
export interface ActionParam {
  type: "string" | "number" | "boolean" | "object";
  description?: string;
  required?: boolean;
}

export interface ServiceAction {
  description: string;
  params: Record<string, ActionParam>;
}

export interface ServiceDefinition {
  id: string;
  name: string;
  category: string;
  pipedreamApp: string;
  icon: string;
  actions: Record<string, ServiceAction>;
}

export interface ConnectRequest {
  service: string;
  label?: string;
}

export interface CallRequest {
  service: string;
  action: string;
  params?: Record<string, unknown>;
  label?: string;
}

export interface ConnectResult {
  url: string;
  service: string;
}

export interface CallResult {
  data: unknown;
  service: string;
  action: string;
}
```

- [ ] **Step 4: Implement service registry**

```typescript
// packages/gateway/src/integrations/registry.ts
import type { ServiceDefinition, ServiceAction } from "./types.js";

export const SERVICE_REGISTRY: Record<string, ServiceDefinition> = {
  gmail: {
    id: "gmail",
    name: "Gmail",
    category: "google",
    pipedreamApp: "gmail",
    icon: "gmail",
    actions: {
      list_messages: {
        description: "List emails matching a query",
        params: {
          query: { type: "string", description: "Gmail search query (e.g. is:unread)", required: false },
          maxResults: { type: "number", description: "Max emails to return (default 10)", required: false },
        },
      },
      get_message: {
        description: "Read a specific email by ID",
        params: {
          messageId: { type: "string", description: "Gmail message ID", required: true },
        },
      },
      send_email: {
        description: "Send an email",
        params: {
          to: { type: "string", description: "Recipient email address", required: true },
          subject: { type: "string", description: "Email subject", required: true },
          body: { type: "string", description: "Email body (plain text or HTML)", required: true },
          cc: { type: "string", description: "CC recipients (comma-separated)", required: false },
        },
      },
      search: {
        description: "Search emails",
        params: {
          query: { type: "string", description: "Search query", required: true },
          maxResults: { type: "number", description: "Max results", required: false },
        },
      },
      list_labels: {
        description: "List email labels/folders",
        params: {},
      },
    },
  },
  google_calendar: {
    id: "google_calendar",
    name: "Google Calendar",
    category: "google",
    pipedreamApp: "google_calendar",
    icon: "calendar",
    actions: {
      list_events: {
        description: "List upcoming calendar events",
        params: {
          timeMin: { type: "string", description: "Start time (ISO 8601)", required: false },
          timeMax: { type: "string", description: "End time (ISO 8601)", required: false },
          maxResults: { type: "number", description: "Max events to return", required: false },
        },
      },
      create_event: {
        description: "Create a calendar event",
        params: {
          summary: { type: "string", description: "Event title", required: true },
          start: { type: "string", description: "Start datetime (ISO 8601)", required: true },
          end: { type: "string", description: "End datetime (ISO 8601)", required: true },
          description: { type: "string", description: "Event description", required: false },
          location: { type: "string", description: "Event location", required: false },
        },
      },
      update_event: {
        description: "Update an existing calendar event",
        params: {
          eventId: { type: "string", description: "Calendar event ID", required: true },
          summary: { type: "string", description: "New event title", required: false },
          start: { type: "string", description: "New start datetime", required: false },
          end: { type: "string", description: "New end datetime", required: false },
        },
      },
      delete_event: {
        description: "Delete a calendar event",
        params: {
          eventId: { type: "string", description: "Calendar event ID", required: true },
        },
      },
    },
  },
  google_drive: {
    id: "google_drive",
    name: "Google Drive",
    category: "google",
    pipedreamApp: "google_drive",
    icon: "drive",
    actions: {
      list_files: {
        description: "List files in Drive",
        params: {
          query: { type: "string", description: "Drive search query", required: false },
          maxResults: { type: "number", description: "Max files to return", required: false },
          folderId: { type: "string", description: "Folder ID to list", required: false },
        },
      },
      get_file: {
        description: "Get file metadata and content",
        params: {
          fileId: { type: "string", description: "Drive file ID", required: true },
        },
      },
      upload_file: {
        description: "Upload a file to Drive",
        params: {
          name: { type: "string", description: "File name", required: true },
          content: { type: "string", description: "File content", required: true },
          mimeType: { type: "string", description: "MIME type", required: false },
          folderId: { type: "string", description: "Parent folder ID", required: false },
        },
      },
      share_file: {
        description: "Share a file with someone",
        params: {
          fileId: { type: "string", description: "Drive file ID", required: true },
          email: { type: "string", description: "Email to share with", required: true },
          role: { type: "string", description: "Permission role (reader/writer/commenter)", required: false },
        },
      },
    },
  },
  github: {
    id: "github",
    name: "GitHub",
    category: "developer",
    pipedreamApp: "github",
    icon: "github",
    actions: {
      list_repos: {
        description: "List your repositories",
        params: {
          sort: { type: "string", description: "Sort by (updated/created/pushed)", required: false },
          per_page: { type: "number", description: "Results per page", required: false },
        },
      },
      list_issues: {
        description: "List issues in a repository",
        params: {
          repo: { type: "string", description: "Repository (owner/name)", required: true },
          state: { type: "string", description: "Filter by state (open/closed/all)", required: false },
        },
      },
      create_issue: {
        description: "Create an issue in a repository",
        params: {
          repo: { type: "string", description: "Repository (owner/name)", required: true },
          title: { type: "string", description: "Issue title", required: true },
          body: { type: "string", description: "Issue body (markdown)", required: false },
          labels: { type: "string", description: "Comma-separated labels", required: false },
        },
      },
      list_prs: {
        description: "List pull requests in a repository",
        params: {
          repo: { type: "string", description: "Repository (owner/name)", required: true },
          state: { type: "string", description: "Filter by state (open/closed/all)", required: false },
        },
      },
      get_notifications: {
        description: "Get your GitHub notifications",
        params: {
          all: { type: "boolean", description: "Include read notifications", required: false },
        },
      },
    },
  },
  slack: {
    id: "slack",
    name: "Slack",
    category: "communication",
    pipedreamApp: "slack",
    icon: "slack",
    actions: {
      send_message: {
        description: "Send a message to a Slack channel",
        params: {
          channel: { type: "string", description: "Channel name or ID", required: true },
          text: { type: "string", description: "Message text", required: true },
        },
      },
      list_channels: {
        description: "List Slack channels",
        params: {
          limit: { type: "number", description: "Max channels to return", required: false },
        },
      },
      list_messages: {
        description: "Read messages from a channel",
        params: {
          channel: { type: "string", description: "Channel name or ID", required: true },
          limit: { type: "number", description: "Max messages to return", required: false },
        },
      },
      search: {
        description: "Search Slack messages",
        params: {
          query: { type: "string", description: "Search query", required: true },
        },
      },
      react: {
        description: "Add a reaction to a message",
        params: {
          channel: { type: "string", description: "Channel ID", required: true },
          timestamp: { type: "string", description: "Message timestamp", required: true },
          emoji: { type: "string", description: "Emoji name (without colons)", required: true },
        },
      },
    },
  },
  discord: {
    id: "discord",
    name: "Discord",
    category: "communication",
    pipedreamApp: "discord",
    icon: "discord",
    actions: {
      send_message: {
        description: "Send a message to a Discord channel",
        params: {
          channelId: { type: "string", description: "Discord channel ID", required: true },
          content: { type: "string", description: "Message content", required: true },
        },
      },
      list_servers: {
        description: "List Discord servers you belong to",
        params: {},
      },
      list_channels: {
        description: "List channels in a Discord server",
        params: {
          serverId: { type: "string", description: "Discord server (guild) ID", required: true },
        },
      },
      list_messages: {
        description: "Read messages from a Discord channel",
        params: {
          channelId: { type: "string", description: "Discord channel ID", required: true },
          limit: { type: "number", description: "Max messages to return", required: false },
        },
      },
    },
  },
};

export function getService(id: string): ServiceDefinition | undefined {
  return SERVICE_REGISTRY[id];
}

export function listServices(): ServiceDefinition[] {
  return Object.values(SERVICE_REGISTRY);
}

export function getAction(serviceId: string, actionId: string): ServiceDefinition["actions"][string] | undefined {
  return SERVICE_REGISTRY[serviceId]?.actions[actionId];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/hamed/dev/claude-tools/matrix-os && bun run vitest run tests/integrations/registry.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/integrations/types.ts packages/gateway/src/integrations/registry.ts tests/integrations/registry.test.ts
git commit -m "feat(049): add service registry with 6 launch integrations"
```

---

## Task 3: Pipedream Connect SDK Wrapper

**Files:**
- Create: `packages/gateway/src/integrations/pipedream.ts`
- Create: `tests/integrations/pipedream.test.ts`
- Modify: `packages/gateway/package.json` (add `@pipedream/sdk`)

- [ ] **Step 1: Install Pipedream SDK**

```bash
cd /Users/hamed/dev/claude-tools/matrix-os && pnpm add @pipedream/sdk --filter @matrix-os/gateway
```

- [ ] **Step 2: Write failing test for Pipedream wrapper**

```typescript
// tests/integrations/pipedream.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPipedreamClient, type PipedreamClient } from "../../packages/gateway/src/integrations/pipedream.js";

// Mock the SDK -- we don't call Pipedream in tests
vi.mock("@pipedream/sdk", () => ({
  createBackendClient: vi.fn(() => ({
    connectTokenCreate: vi.fn(async (opts: any) => ({
      token: "pd_token_mock_123",
      expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    })),
    connectAccount: vi.fn(async () => ({
      id: "pd_acc_mock_456",
      app: { name_slug: "gmail" },
      email: "user@gmail.com",
    })),
    makeProxyRequest: vi.fn(async () => ({
      status: 200,
      data: { messages: [{ id: "msg1", snippet: "Hello" }] },
    })),
  })),
}));

describe("PipedreamClient", () => {
  let client: PipedreamClient;

  beforeEach(() => {
    client = createPipedreamClient({
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      projectId: "test_project_id",
    });
  });

  it("creates a connect token for a user", async () => {
    const result = await client.createConnectToken("user_123");
    expect(result.token).toBeDefined();
    expect(typeof result.token).toBe("string");
  });

  it("gets the OAuth URL for a service", () => {
    const url = client.getOAuthUrl("pd_token_123", "gmail");
    expect(url).toContain("pipedream.com");
    expect(url).toContain("gmail");
  });

  it("calls a service action via proxy", async () => {
    const result = await client.callAction({
      externalUserId: "user_123",
      app: "gmail",
      action: "list_messages",
      params: { query: "is:unread" },
    });
    expect(result).toBeDefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/hamed/dev/claude-tools/matrix-os && bun run vitest run tests/integrations/pipedream.test.ts`
Expected: FAIL -- `createPipedreamClient` not found

- [ ] **Step 4: Implement Pipedream wrapper**

```typescript
// packages/gateway/src/integrations/pipedream.ts
import { createBackendClient } from "@pipedream/sdk";
import { getService } from "./registry.js";

export interface PipedreamConfig {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment?: "development" | "production";
}

export interface PipedreamClient {
  createConnectToken(externalUserId: string): Promise<{ token: string; expiresAt: string }>;
  getOAuthUrl(token: string, app: string): string;
  callAction(opts: {
    externalUserId: string;
    app: string;
    action: string;
    params?: Record<string, unknown>;
  }): Promise<unknown>;
  revokeAccount(externalUserId: string, accountId: string): Promise<void>;
}

export function createPipedreamClient(config: PipedreamConfig): PipedreamClient {
  const client = createBackendClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    projectId: config.projectId,
    environment: config.environment ?? "production",
  });

  return {
    async createConnectToken(externalUserId) {
      const result = await client.connectTokenCreate({
        external_user_id: externalUserId,
      });
      return {
        token: result.token,
        expiresAt: result.expires_at,
      };
    },

    getOAuthUrl(token, app) {
      return `https://pipedream.com/connect/${config.projectId}?token=${encodeURIComponent(token)}&app=${encodeURIComponent(app)}`;
    },

    async callAction({ externalUserId, app, action, params }) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const result = await client.makeProxyRequest({
          externalUserId,
          app,
          path: `/${action}`,
          method: "POST",
          body: params ?? {},
          signal: controller.signal,
        });
        return result.data;
      } finally {
        clearTimeout(timeout);
      }
    },

    async revokeAccount(externalUserId, accountId) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        await client.connectAccount({
          externalUserId,
          accountId,
          action: "delete",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
```

Note: The exact Pipedream SDK method names may differ from what's shown. After installing the SDK, check the actual TypeScript types in `node_modules/@pipedream/sdk` and adjust the wrapper accordingly. The interface (`PipedreamClient`) stays the same -- only the implementation details inside `createPipedreamClient` may need updating. Run `pnpm add @pipedream/sdk --filter @matrix-os/gateway` first, then verify the SDK's exported API before finalizing.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/hamed/dev/claude-tools/matrix-os && bun run vitest run tests/integrations/pipedream.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/integrations/pipedream.ts tests/integrations/pipedream.test.ts packages/gateway/package.json pnpm-lock.yaml
git commit -m "feat(049): add Pipedream Connect SDK wrapper"
```

---

## Task 4: Gateway Integration Routes

**Files:**
- Create: `packages/gateway/src/integrations/routes.ts`
- Create: `tests/integrations/routes.test.ts`

- [ ] **Step 1: Write failing test for integration routes**

```typescript
// tests/integrations/routes.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { createIntegrationRoutes } from "../../packages/gateway/src/integrations/routes.js";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { PGlite } from "@electric-sql/pglite";
import { KyselyPGliteDialect } from "kysely-pglite";

// Mock Pipedream client
const mockPipedream = {
  createConnectToken: vi.fn(async () => ({ token: "pd_tok_123", expiresAt: "2026-04-06T00:00:00Z" })),
  getOAuthUrl: vi.fn(() => "https://pipedream.com/connect/test?token=pd_tok_123&app=gmail"),
  callAction: vi.fn(async () => ({ messages: [{ id: "1", snippet: "Hello" }] })),
  revokeAccount: vi.fn(async () => {}),
};

describe("Integration Routes", () => {
  let pg: PGlite;
  let platformDb: PlatformDb;
  let app: Hono;
  let userId: string;

  beforeEach(async () => {
    pg = await PGlite.create();
    platformDb = createPlatformDb({ dialect: new KyselyPGliteDialect(pg) });
    await platformDb.migrate();

    const user = await platformDb.createUser({
      clerkId: "clerk_test",
      handle: "testuser",
      displayName: "Test User",
      email: "test@test.com",
      containerId: "container-test",
    });
    userId = user.id;

    const routes = createIntegrationRoutes({
      platformDb,
      pipedream: mockPipedream as any,
      getUserId: async () => userId,
    });
    app = new Hono();
    app.route("/api/integrations", routes);
  });

  afterEach(async () => {
    await platformDb.destroy();
    await pg.close();
    vi.clearAllMocks();
  });

  it("GET /api/integrations/available returns service list", async () => {
    const res = await app.request("/api/integrations/available");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(6);
    expect(data[0]).toHaveProperty("id");
    expect(data[0]).toHaveProperty("name");
    expect(data[0]).toHaveProperty("actions");
  });

  it("POST /api/integrations/connect returns OAuth URL", async () => {
    const res = await app.request("/api/integrations/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "gmail", label: "Work Gmail" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.url).toContain("pipedream.com");
    expect(data.service).toBe("gmail");
    expect(mockPipedream.createConnectToken).toHaveBeenCalledWith(userId);
  });

  it("POST /api/integrations/connect rejects unknown service", async () => {
    const res = await app.request("/api/integrations/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "unknown_service" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/integrations returns user connections", async () => {
    await platformDb.connectService({
      userId,
      service: "gmail",
      pipedreamAccountId: "pd_acc_1",
      accountLabel: "Work Gmail",
      accountEmail: "test@work.com",
      scopes: ["gmail.modify"],
    });

    const res = await app.request("/api/integrations");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].service).toBe("gmail");
  });

  it("DELETE /api/integrations/:id disconnects", async () => {
    const svc = await platformDb.connectService({
      userId,
      service: "github",
      pipedreamAccountId: "pd_acc_2",
      accountLabel: "GitHub",
      scopes: ["repo"],
    });

    const res = await app.request(`/api/integrations/${svc.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const services = await platformDb.listConnectedServices(userId);
    expect(services).toHaveLength(0);
  });

  it("POST /api/integrations/call proxies to Pipedream", async () => {
    await platformDb.connectService({
      userId,
      service: "gmail",
      pipedreamAccountId: "pd_acc_3",
      accountLabel: "Gmail",
      scopes: ["gmail.modify"],
    });

    const res = await app.request("/api/integrations/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "gmail", action: "list_messages", params: { query: "is:unread" } }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data).toBeDefined();
    expect(mockPipedream.callAction).toHaveBeenCalled();
  });

  it("POST /api/integrations/call rejects unconnected service", async () => {
    const res = await app.request("/api/integrations/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "gmail", action: "list_messages" }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/hamed/dev/claude-tools/matrix-os && bun run vitest run tests/integrations/routes.test.ts`
Expected: FAIL -- `createIntegrationRoutes` not found

- [ ] **Step 3: Implement integration routes**

```typescript
// packages/gateway/src/integrations/routes.ts
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { listServices, getService, getAction } from "./registry.js";
import type { PlatformDb } from "../platform-db.js";
import type { PipedreamClient } from "./pipedream.js";

const ConnectSchema = z.object({
  service: z.string(),
  label: z.string().optional(),
});

const CallSchema = z.object({
  service: z.string(),
  action: z.string(),
  params: z.record(z.unknown()).optional(),
  label: z.string().optional(),
});

export function createIntegrationRoutes(opts: {
  platformDb: PlatformDb;
  pipedream: PipedreamClient;
  getUserId: (c: any) => Promise<string>;
}) {
  const { platformDb, pipedream, getUserId } = opts;
  const app = new Hono();

  // List available services
  app.get("/available", (c) => {
    return c.json(listServices());
  });

  // List user's connected services
  app.get("/", async (c) => {
    const userId = await getUserId(c);
    const services = await platformDb.listConnectedServices(userId);
    return c.json(services);
  });

  // Initiate OAuth connection
  app.post("/connect", bodyLimit({ maxSize: 1024 }), async (c) => {
    const body = await c.req.json();
    const parsed = ConnectSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }

    const { service, label } = parsed.data;
    if (!getService(service)) {
      return c.json({ error: `Unknown service: ${service}` }, 400);
    }

    const userId = await getUserId(c);
    const { token } = await pipedream.createConnectToken(userId);
    const url = pipedream.getOAuthUrl(token, getService(service)!.pipedreamApp);

    return c.json({ url, service });
  });

  // Handle OAuth callback webhook from Pipedream
  app.post("/webhook/connected", bodyLimit({ maxSize: 4096 }), async (c) => {
    // Verify Pipedream webhook signature (HMAC)
    const signature = c.req.header("x-pd-signature");
    const webhookSecret = process.env.PIPEDREAM_WEBHOOK_SECRET;
    if (webhookSecret) {
      const rawBody = await c.req.text();
      const { createHmac, timingSafeEqual } = await import("node:crypto");
      const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
      if (!signature || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return c.json({ error: "Invalid webhook signature" }, 401);
      }
      // Re-parse body after consuming as text
      var body = JSON.parse(rawBody);
    } else {
      var body = await c.req.json();
      console.warn("[integrations] PIPEDREAM_WEBHOOK_SECRET not set -- webhook signature verification disabled");
    }

    // Pipedream sends: { external_id, account: { id, app, ... }, ... }
    const externalUserId = body.external_id;
    const account = body.account;

    if (!externalUserId || !account?.id) {
      return c.json({ error: "Invalid webhook payload" }, 400);
    }

    const user = await platformDb.getUserById(externalUserId);
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    await platformDb.connectService({
      userId: user.id,
      service: account.app?.name_slug ?? account.app,
      pipedreamAccountId: account.id,
      accountLabel: body.label ?? account.app?.name_slug ?? "Default",
      accountEmail: account.email,
      scopes: account.scopes ?? [],
    });

    return c.json({ ok: true });
  });

  // Call a connected service action
  app.post("/call", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const body = await c.req.json();
    const parsed = CallSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }

    const { service, action, params, label } = parsed.data;
    if (!getService(service)) {
      return c.json({ error: `Unknown service: ${service}` }, 400);
    }
    if (!getAction(service, action)) {
      return c.json({ error: `Unknown action: ${service}.${action}` }, 400);
    }

    const userId = await getUserId(c);
    const connections = await platformDb.listConnectedServices(userId);
    const match = connections.find(
      (s) => s.service === service && (label ? s.account_label === label : true)
    );
    if (!match) {
      return c.json({ error: `Service not connected: ${service}. Connect it first.` }, 400);
    }

    const data = await pipedream.callAction({
      externalUserId: userId,
      app: getService(service)!.pipedreamApp,
      action,
      params,
    });

    await platformDb.touchServiceUsage(match.id);

    return c.json({ data, service, action });
  });

  // Check connection status
  app.get("/:id/status", async (c) => {
    const id = c.req.param("id");
    const svc = await platformDb.getConnectedService(id);
    if (!svc) return c.json({ error: "Not found" }, 404);
    return c.json({ id: svc.id, service: svc.service, status: svc.status });
  });

  // Disconnect a service
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const svc = await platformDb.getConnectedService(id);
    if (!svc) return c.json({ error: "Not found" }, 404);

    try {
      const userId = await getUserId(c);
      await pipedream.revokeAccount(userId, svc.pipedream_account_id);
    } catch (err) {
      console.error("[integrations] Pipedream revocation failed for", svc.pipedream_account_id, ":", err instanceof Error ? err.message : err);
    }

    await platformDb.disconnectService(id);
    return c.json({ ok: true });
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/hamed/dev/claude-tools/matrix-os && bun run vitest run tests/integrations/routes.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/integrations/routes.ts tests/integrations/routes.test.ts
git commit -m "feat(049): add gateway integration API routes"
```

---

## Task 5: Wire Integration Routes into Gateway Server

**Files:**
- Modify: `packages/gateway/src/server.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add env vars to .env.example**

Add to `.env.example`:
```
# Platform Integrations (Pipedream Connect)
PIPEDREAM_CLIENT_ID=
PIPEDREAM_CLIENT_SECRET=
PIPEDREAM_PROJECT_ID=
PIPEDREAM_ENVIRONMENT=development
PIPEDREAM_WEBHOOK_SECRET=
# Platform DB (can reuse DATABASE_URL or separate)
PLATFORM_DATABASE_URL=
```

- [ ] **Step 2: Wire into server.ts**

Add imports near the top of `packages/gateway/src/server.ts` (after the existing app-db imports around line 56-59):

```typescript
import { createPlatformDb, type PlatformDb } from "./platform-db.js";
import { createPipedreamClient } from "./integrations/pipedream.js";
import { createIntegrationRoutes } from "./integrations/routes.js";
```

Inside `createGateway()`, after the existing app-db initialization block (around where `appDb`, `queryEngine`, `kvStore` are created), add:

```typescript
  // Platform DB + Integrations
  let platformDb: PlatformDb | null = null;
  const platformDbUrl = process.env.PLATFORM_DATABASE_URL || process.env.DATABASE_URL;
  if (platformDbUrl && process.env.PIPEDREAM_CLIENT_ID) {
    platformDb = createPlatformDb(platformDbUrl);
    await platformDb.migrate();
    console.log("[gateway] Platform DB initialized");

    const pipedream = createPipedreamClient({
      clientId: process.env.PIPEDREAM_CLIENT_ID,
      clientSecret: process.env.PIPEDREAM_CLIENT_SECRET!,
      projectId: process.env.PIPEDREAM_PROJECT_ID!,
      environment: (process.env.PIPEDREAM_ENVIRONMENT as "development" | "production") ?? "production",
    });

    const integrationRoutes = createIntegrationRoutes({
      platformDb,
      pipedream,
      getUserId: async (c) => {
        // In single-user mode, look up by container. In multi-user mode, resolve from auth.
        const user = await platformDb!.getUserByClerkId(c.get("clerkId") ?? "default");
        if (!user) throw new Error("User not found in platform DB");
        return user.id;
      },
    });
    app.route("/api/integrations", integrationRoutes);
    console.log("[gateway] Integration routes mounted");
  }
```

- [ ] **Step 3: Verify the gateway still starts**

Run: `cd /Users/hamed/dev/claude-tools/matrix-os && bun run vitest run tests/integrations/`
Expected: All integration tests still pass

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/server.ts .env.example
git commit -m "feat(049): wire platform DB and integration routes into gateway"
```

---

## Task 6: Kernel IPC Tools (connect_service + call_service)

**Files:**
- Create: `packages/kernel/src/tools/integrations.ts`
- Modify: `packages/kernel/src/ipc-server.ts`
- Modify: `packages/kernel/src/options.ts`
- Create: `tests/integrations/ipc-tools.test.ts`

- [ ] **Step 1: Write failing test for IPC tools**

```typescript
// tests/integrations/ipc-tools.test.ts
import { describe, it, expect, vi } from "vitest";
import { createIntegrationTools } from "../../packages/kernel/src/tools/integrations.js";

describe("Integration IPC Tools", () => {
  it("creates connect_service and call_service tools", () => {
    const tools = createIntegrationTools("http://localhost:4000");
    expect(tools).toHaveLength(2);
    expect(tools.map((t: any) => t.name ?? t[0])).toEqual(
      expect.arrayContaining(["connect_service", "call_service"])
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/hamed/dev/claude-tools/matrix-os && bun run vitest run tests/integrations/ipc-tools.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement integration IPC tools**

```typescript
// packages/kernel/src/tools/integrations.ts
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

export function createIntegrationTools(gatewayUrl: string) {
  const authToken = process.env.MATRIX_AUTH_TOKEN ?? "";

  async function gatewayFetch(path: string, opts?: RequestInit) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${gatewayUrl}${path}`, {
        ...opts,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
          ...opts?.headers,
        },
      });
      if (!res.ok) {
        const body = await res.text();
        return { error: `HTTP ${res.status}: ${body}` };
      }
      return res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  return [
    tool(
      "connect_service",
      "Connect an external service (Gmail, Calendar, Drive, GitHub, Slack, Discord). Returns an OAuth URL for the user to authorize.",
      {
        service: z.enum(["gmail", "google_calendar", "google_drive", "github", "slack", "discord"]),
        label: z.string().optional().describe("Label for multiple accounts, e.g. 'Work Gmail'"),
      },
      async ({ service, label }) => {
        const result = await gatewayFetch("/api/integrations/connect", {
          method: "POST",
          body: JSON.stringify({ service, label }),
        });
        if (result.error) {
          return { content: [{ type: "text" as const, text: `Failed to connect: ${result.error}` }] };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Please authorize ${service} by opening this link:\n\n${result.url}\n\nOnce authorized, I'll be able to use ${service} on your behalf.`,
            },
          ],
        };
      }
    ),

    tool(
      "call_service",
      "Call an action on a connected service. Use connect_service first if the service is not connected.",
      {
        service: z.enum(["gmail", "google_calendar", "google_drive", "github", "slack", "discord"]),
        action: z.string().describe("Action to perform (e.g. list_messages, send_email, list_events)"),
        params: z.record(z.unknown()).optional().describe("Parameters for the action"),
        label: z.string().optional().describe("Which account to use if multiple are connected"),
      },
      async ({ service, action, params, label }) => {
        const result = await gatewayFetch("/api/integrations/call", {
          method: "POST",
          body: JSON.stringify({ service, action, params, label }),
        });
        if (result.error) {
          return { content: [{ type: "text" as const, text: `Integration error: ${result.error}` }] };
        }
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result.data, null, 2) },
          ],
        };
      }
    ),
  ];
}
```

- [ ] **Step 4: Add tools to ipc-server.ts**

In `packages/kernel/src/ipc-server.ts`, add import at top:

```typescript
import { createIntegrationTools } from "./tools/integrations.js";
```

Inside `createIpcServer`, add the integration tools to the tools array. After the last existing `tool(...)` entry and before the closing `]` of the tools array:

```typescript
      // Integration tools -- connect and call external services
      ...createIntegrationTools(process.env.GATEWAY_URL ?? "http://localhost:4000"),
```

- [ ] **Step 5: Add tool names to options.ts**

In `packages/kernel/src/options.ts`, add to `IPC_TOOL_NAMES` array:

```typescript
  "mcp__matrix-os-ipc__connect_service",
  "mcp__matrix-os-ipc__call_service",
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /Users/hamed/dev/claude-tools/matrix-os && bun run vitest run tests/integrations/ipc-tools.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/kernel/src/tools/integrations.ts packages/kernel/src/ipc-server.ts packages/kernel/src/options.ts tests/integrations/ipc-tools.test.ts
git commit -m "feat(049): add connect_service and call_service IPC tools"
```

---

## Task 7: Shell Settings UI -- Integrations Section

**Files:**
- Create: `shell/src/components/settings/sections/IntegrationsSection.tsx`
- Modify: Shell settings panel to include the new tab

- [ ] **Step 1: Identify the settings panel component**

Find and read the component that renders settings tabs (the parent that includes `ChannelsSection`, `SkillsSection`, etc.). Look in:
- `shell/src/components/settings/SettingsPanel.tsx`
- `shell/src/components/settings/SettingsWindow.tsx`
- Or whatever renders the settings section tabs

Run: `grep -r "ChannelsSection\|SkillsSection" shell/src/ --include="*.tsx" -l`

- [ ] **Step 2: Implement IntegrationsSection**

```tsx
// shell/src/components/settings/sections/IntegrationsSection.tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY = getGatewayUrl();

interface ServiceDef {
  id: string;
  name: string;
  category: string;
  icon: string;
  actions: Record<string, unknown>;
}

interface ConnectedService {
  id: string;
  service: string;
  account_label: string;
  account_email: string | null;
  status: string;
  connected_at: string;
}

const SERVICE_ICONS: Record<string, string> = {
  gmail: "M",
  google_calendar: "C",
  google_drive: "D",
  github: "G",
  slack: "S",
  discord: "D",
};

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-500",
  expired: "bg-yellow-500",
  revoked: "bg-red-500",
};

export function IntegrationsSection() {
  const [available, setAvailable] = useState<ServiceDef[]>([]);
  const [connected, setConnected] = useState<ConnectedService[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    const [avRes, conRes] = await Promise.all([
      fetch(`${GATEWAY}/api/integrations/available`),
      fetch(`${GATEWAY}/api/integrations`),
    ]);
    if (avRes.ok) setAvailable(await avRes.json());
    if (conRes.ok) setConnected(await conRes.json());
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function handleConnect(serviceId: string) {
    setConnecting(serviceId);
    try {
      const res = await fetch(`${GATEWAY}/api/integrations/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: serviceId }),
      });
      if (!res.ok) return;
      const { url } = await res.json();
      window.open(url, "_blank", "width=600,height=700");
      // Poll for connection completion
      const poll = setInterval(async () => {
        const updated = await fetch(`${GATEWAY}/api/integrations`);
        if (updated.ok) {
          const services = await updated.json();
          setConnected(services);
          const isNowConnected = services.some(
            (s: ConnectedService) => s.service === serviceId
          );
          if (isNowConnected) {
            clearInterval(poll);
            setConnecting(null);
          }
        }
      }, 2000);
      // Stop polling after 5 minutes
      setTimeout(() => {
        clearInterval(poll);
        setConnecting(null);
      }, 5 * 60 * 1000);
    } catch {
      setConnecting(null);
    }
  }

  async function handleDisconnect(id: string) {
    const res = await fetch(`${GATEWAY}/api/integrations/${id}`, { method: "DELETE" });
    if (res.ok) {
      setConnected((prev) => prev.filter((s) => s.id !== id));
    }
  }

  const connectedIds = new Set(connected.map((s) => s.service));

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h2 className="text-lg font-semibold">Integrations</h2>
      <p className="text-sm text-muted-foreground">
        Connect your tools so your AI agent can read, write, and build apps with them.
      </p>

      {connected.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Connected</h3>
          {connected.map((svc) => (
            <div key={svc.id} className="flex items-center justify-between p-3 rounded-lg border bg-card">
              <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${STATUS_COLORS[svc.status] ?? "bg-gray-400"}`} />
                <div>
                  <div className="font-medium">{svc.account_label}</div>
                  <div className="text-xs text-muted-foreground">
                    {svc.account_email ?? svc.service} -- connected{" "}
                    {new Date(svc.connected_at).toLocaleDateString()}
                  </div>
                </div>
              </div>
              <button
                onClick={() => handleDisconnect(svc.id)}
                className="text-sm text-destructive hover:underline"
              >
                Disconnect
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Available</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {available
            .filter((s) => !connectedIds.has(s.id))
            .map((svc) => (
              <button
                key={svc.id}
                onClick={() => handleConnect(svc.id)}
                disabled={connecting === svc.id}
                className="flex flex-col items-center gap-2 p-4 rounded-lg border bg-card hover:bg-accent transition-colors disabled:opacity-50"
              >
                <span className="text-2xl font-bold text-muted-foreground">
                  {SERVICE_ICONS[svc.id] ?? svc.name[0]}
                </span>
                <span className="text-sm font-medium">{svc.name}</span>
                <span className="text-xs text-primary">
                  {connecting === svc.id ? "Connecting..." : "Connect"}
                </span>
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add Integrations tab to settings panel**

Find the settings panel component (from step 1) and add:

Import:
```typescript
import { IntegrationsSection } from "./sections/IntegrationsSection";
```

Add a new tab entry (following the existing pattern for ChannelsSection, SkillsSection, etc.):
```typescript
{ id: "integrations", label: "Integrations", component: <IntegrationsSection /> }
```

Place it as the first or second tab, since it's a primary feature.

- [ ] **Step 4: Test manually in dev**

Run: `cd /Users/hamed/dev/claude-tools/matrix-os && bun run dev`
Navigate to Settings > Integrations. Verify:
- Available services grid shows 6 services
- Click Connect opens a popup (will fail without Pipedream creds, but the flow should work)
- Connected section shows empty state initially

- [ ] **Step 5: Commit**

```bash
git add shell/src/components/settings/sections/IntegrationsSection.tsx
# also add the modified settings panel file
git commit -m "feat(049): add Settings > Integrations UI"
```

---

## Task 8: Environment and Docker Configuration

**Files:**
- Modify: `docker-compose.dev.yml` (if platform DB needs separate config)
- Modify: `.env.example`

- [ ] **Step 1: Verify Docker Postgres can be shared**

The existing `docker-compose.dev.yml` already has a Postgres service. The platform DB can use the same instance -- just a different database or the same one (different tables, no schema conflicts since platform tables are in the `public` schema with distinct names).

Check if `DATABASE_URL` already points to the dev Postgres. If so, `PLATFORM_DATABASE_URL` can default to the same value.

- [ ] **Step 2: Update .env.example with all required vars**

Ensure `.env.example` has:
```
# Platform Integrations (Pipedream Connect)
# Get these from https://pipedream.com/settings → Connect
PIPEDREAM_CLIENT_ID=
PIPEDREAM_CLIENT_SECRET=
PIPEDREAM_PROJECT_ID=
PIPEDREAM_ENVIRONMENT=development

# Platform Database (defaults to DATABASE_URL if not set)
PLATFORM_DATABASE_URL=
```

- [ ] **Step 3: Commit**

```bash
git add .env.example docker-compose.dev.yml
git commit -m "chore(049): add integration env vars and Docker config"
```

---

## Task 9: Integration Test -- Full Connect + Call Flow

**Files:**
- Create: `tests/integrations/e2e-flow.test.ts`

- [ ] **Step 1: Write integration test for the full flow**

```typescript
// tests/integrations/e2e-flow.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { createIntegrationRoutes } from "../../packages/gateway/src/integrations/routes.js";
import { PGlite } from "@electric-sql/pglite";
import { KyselyPGliteDialect } from "kysely-pglite";

const mockPipedream = {
  createConnectToken: vi.fn(async () => ({ token: "tok_123", expiresAt: "2026-04-06T00:00:00Z" })),
  getOAuthUrl: vi.fn((tok: string, app: string) => `https://pipedream.com/connect?token=${tok}&app=${app}`),
  callAction: vi.fn(async ({ action }: any) => {
    if (action === "list_messages") return { messages: [{ id: "1", subject: "Test", snippet: "Hello world" }] };
    if (action === "list_events") return { events: [{ summary: "Meeting", start: "2026-04-05T10:00:00Z" }] };
    return {};
  }),
  revokeAccount: vi.fn(async () => {}),
};

describe("Integration E2E Flow", () => {
  let pg: PGlite;
  let platformDb: PlatformDb;
  let app: Hono;
  let userId: string;

  beforeEach(async () => {
    pg = await PGlite.create();
    platformDb = createPlatformDb({ dialect: new KyselyPGliteDialect(pg) });
    await platformDb.migrate();

    const user = await platformDb.createUser({
      clerkId: "clerk_e2e",
      handle: "e2e_user",
      displayName: "E2E User",
      email: "e2e@test.com",
      containerId: "container-e2e",
    });
    userId = user.id;

    const routes = createIntegrationRoutes({
      platformDb,
      pipedream: mockPipedream as any,
      getUserId: async () => userId,
    });
    app = new Hono();
    app.route("/api/integrations", routes);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await platformDb.destroy();
    await pg.close();
  });

  it("full flow: connect Gmail, call list_messages, disconnect", async () => {
    // 1. Check available services
    const availRes = await app.request("/api/integrations/available");
    const available = await availRes.json();
    expect(available.some((s: any) => s.id === "gmail")).toBe(true);

    // 2. Initiate connection
    const connectRes = await app.request("/api/integrations/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "gmail", label: "Work Gmail" }),
    });
    expect(connectRes.status).toBe(200);
    const { url } = await connectRes.json();
    expect(url).toContain("gmail");

    // 3. Simulate Pipedream webhook callback (user completed OAuth)
    const webhookRes = await app.request("/api/integrations/webhook/connected", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        external_id: userId,
        account: {
          id: "pd_acc_e2e",
          app: { name_slug: "gmail" },
          email: "user@gmail.com",
          scopes: ["gmail.modify"],
        },
        label: "Work Gmail",
      }),
    });
    expect(webhookRes.status).toBe(200);

    // 4. Verify connection exists
    const listRes = await app.request("/api/integrations");
    const connections = await listRes.json();
    expect(connections).toHaveLength(1);
    expect(connections[0].service).toBe("gmail");
    expect(connections[0].account_label).toBe("Work Gmail");

    // 5. Call Gmail API
    const callRes = await app.request("/api/integrations/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "gmail", action: "list_messages", params: { query: "is:unread" } }),
    });
    expect(callRes.status).toBe(200);
    const callData = await callRes.json();
    expect(callData.data.messages).toHaveLength(1);

    // 6. Disconnect
    const disconnectRes = await app.request(`/api/integrations/${connections[0].id}`, { method: "DELETE" });
    expect(disconnectRes.status).toBe(200);

    // 7. Verify disconnected
    const finalList = await app.request("/api/integrations");
    const finalConnections = await finalList.json();
    expect(finalConnections).toHaveLength(0);
  });

  it("connecting multiple accounts for the same service", async () => {
    // Connect "Work Gmail"
    await platformDb.connectService({
      userId,
      service: "gmail",
      pipedreamAccountId: "pd_work",
      accountLabel: "Work Gmail",
      accountEmail: "work@company.com",
      scopes: ["gmail.modify"],
    });

    // Connect "Personal Gmail"
    await platformDb.connectService({
      userId,
      service: "gmail",
      pipedreamAccountId: "pd_personal",
      accountLabel: "Personal Gmail",
      accountEmail: "personal@gmail.com",
      scopes: ["gmail.readonly"],
    });

    const listRes = await app.request("/api/integrations");
    const connections = await listRes.json();
    expect(connections).toHaveLength(2);

    // Call with label disambiguation
    const callRes = await app.request("/api/integrations/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: "gmail",
        action: "list_messages",
        label: "Work Gmail",
      }),
    });
    expect(callRes.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the full test suite**

Run: `cd /Users/hamed/dev/claude-tools/matrix-os && bun run vitest run tests/integrations/`
Expected: ALL tests pass across all test files

- [ ] **Step 3: Commit**

```bash
git add tests/integrations/e2e-flow.test.ts
git commit -m "test(049): add E2E integration flow tests"
```

---

## Summary

| Task | What it delivers | Files |
|------|-----------------|-------|
| 1 | Platform database (users, services, user_apps, billing) | `platform-db.ts` + tests |
| 2 | Service registry (6 services, actions, params) | `integrations/registry.ts` + `types.ts` + tests |
| 3 | Pipedream Connect SDK wrapper | `integrations/pipedream.ts` + tests |
| 4 | Gateway REST API routes | `integrations/routes.ts` + tests |
| 5 | Wire into gateway server | `server.ts` + `.env.example` |
| 6 | Kernel IPC tools | `tools/integrations.ts` + `ipc-server.ts` + `options.ts` + tests |
| 7 | Shell settings UI | `IntegrationsSection.tsx` + settings panel |
| 8 | Environment and Docker config | `.env.example` + `docker-compose.dev.yml` |
| 9 | Full E2E integration test | `e2e-flow.test.ts` |

Tasks 1-4 can be parallelized (no dependencies between them). Task 5 depends on 1, 3, 4. Task 6 depends on 4 (routes must exist). Task 7 depends on 4 (API must exist). Tasks 8-9 are final wiring and validation.

---

## Task 10: Pipedream Actions API Integration (Phase 2)

**Goal:** Replace the proxy-based `callAction` with Pipedream's Actions API (`client.actions.run()`) so `call_service` actually works end-to-end.

**Files:**
- Modify: `packages/gateway/src/integrations/pipedream.ts`
- Modify: `packages/gateway/src/integrations/registry.ts`
- Modify: `packages/gateway/src/integrations/types.ts`
- Modify: `packages/gateway/src/integrations/routes.ts`
- Create: `tests/integrations/actions.test.ts`

### Step 1: Add Actions API methods to Pipedream client

In `packages/gateway/src/integrations/pipedream.ts`, add:

```typescript
// Add to PipedreamConnectClient interface:
discoverActions(appSlug: string): Promise<Array<{
  key: string;          // e.g. "gmail-send-email"
  name: string;         // e.g. "Send Email"
  description?: string;
}>>;

runAction(opts: {
  externalUserId: string;
  componentKey: string;      // e.g. "gmail-send-email"
  configuredProps: Record<string, unknown>;  // includes { gmail: { authProvisionId: "apn_..." } }
}): Promise<{ exports: Record<string, unknown>; ret: unknown }>;

// Implementation:
async discoverActions(appSlug: string) {
  const result = await sdk.actions.list(
    { app: appSlug } as any,
    { timeoutInSeconds: API_TIMEOUT_SECONDS },
  );
  const items = (result as any)?.data ?? [];
  return items.map((a: any) => ({
    key: a.key ?? a.name_slug,
    name: a.name ?? a.key,
    description: a.description,
  }));
},

async runAction({ externalUserId, componentKey, configuredProps }) {
  const result = await sdk.actions.run(
    { externalUserId, id: componentKey, configuredProps } as any,
    { timeoutInSeconds: 30 },  // actions can be slow
  );
  return {
    exports: (result as any)?.exports ?? {},
    ret: (result as any)?.ret ?? (result as any)?.data ?? result,
  };
},
```

### Step 2: Add component key mappings to registry

In `packages/gateway/src/integrations/types.ts`, add `componentKey` to `ServiceAction`:

```typescript
export interface ServiceAction {
  description: string;
  componentKey?: string;  // Pipedream component key, e.g. "gmail-send-email"
  params: Record<string, ActionParam>;
}
```

In `packages/gateway/src/integrations/registry.ts`, add a startup discovery function:

```typescript
export async function discoverComponentKeys(
  pipedream: PipedreamConnectClient,
): Promise<void> {
  for (const service of listServices()) {
    try {
      const actions = await pipedream.discoverActions(service.pipedreamApp);
      for (const [actionId, actionDef] of Object.entries(service.actions)) {
        // Try exact match: "{app}-{action}" e.g. "gmail-send_email" or "gmail-send-email"
        const candidates = [
          `${service.pipedreamApp}-${actionId}`,
          `${service.pipedreamApp}-${actionId.replace(/_/g, "-")}`,
        ];
        const match = actions.find((a) => candidates.includes(a.key));
        if (match) {
          actionDef.componentKey = match.key;
        }
      }
    } catch (err) {
      console.error(`[registry] Failed to discover actions for ${service.id}:`, err);
    }
  }
}
```

### Step 3: Update POST /call route to use Actions API

In `packages/gateway/src/integrations/routes.ts`, change the POST /call handler:

```typescript
// Instead of:
//   await pipedream.callAction({ externalUserId, accountId, url, body })
// Use:
const actionDef = getAction(service, action);
if (!actionDef?.componentKey) {
  return c.json({ error: `Action ${action} not available for ${service}` }, 400);
}

const configuredProps: Record<string, unknown> = {
  [def.pipedreamApp]: { authProvisionId: match.pipedream_account_id },
  ...params,
};

const result = await pipedream.runAction({
  externalUserId: externalId,
  componentKey: actionDef.componentKey,
  configuredProps,
});

return c.json({ data: result.ret, summary: result.exports["$summary"], service, action });
```

### Step 4: Call discoverComponentKeys at startup

In `packages/gateway/src/server.ts`, after mounting integration routes:

```typescript
import { discoverComponentKeys } from "./integrations/registry.js";

// After: app.route("/api/integrations", integrationRoutes);
discoverComponentKeys(pipedream).then(() => {
  console.log("[platform-db] Action component keys discovered");
}).catch((err) => {
  console.error("[platform-db] Action discovery failed:", err.message);
});
```

### Step 5: Write tests

Create `tests/integrations/actions.test.ts`:
- Mock `sdk.actions.list()` and `sdk.actions.run()`
- Test `discoverActions` returns mapped keys
- Test `runAction` passes correct configuredProps with authProvisionId
- Test POST /call with discovered component key returns action result
- Test POST /call with unknown action (no component key) returns 400

### Step 6: E2E test

Add to `tests/integrations/e2e-flow.test.ts`:
- Connect gmail -> discover actions -> call send_email with mocked action -> verify response has `summary` and `ret`
