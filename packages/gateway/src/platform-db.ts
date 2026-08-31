import { Kysely, PostgresDialect, sql, type InsertObject } from "kysely";
import pg from "pg";
import { randomUUID } from "node:crypto";
import type {
  CustomMcpAuthMode,
  CustomMcpServer,
  CustomMcpStatus,
  CustomMcpTool,
} from "./integrations/custom-mcp/types.js";

// ---------------------------------------------------------------------------
// Kysely table types
// ---------------------------------------------------------------------------

export interface UsersTable {
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
}

export type ServiceStatus = "active" | "revoked" | "expired";

export interface ConnectedServicesTable {
  id: string;
  user_id: string;
  service: string;
  pipedream_account_id: string;
  account_label: string;
  account_email: string | null;
  scopes: string[];
  status: ServiceStatus;
  connected_at: Date;
  last_used_at: Date | null;
}

export interface UserAppsTable {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  description: string | null;
  services_used: string[];
  created_at: Date;
  updated_at: Date;
}

export interface EventSubscriptionsTable {
  id: string;
  user_id: string;
  service: string;
  event_type: string;
  status: string;
  created_at: Date;
}

export interface BillingTable {
  id: string;
  user_id: string;
  stripe_customer_id: string | null;
  plan: string;
  connected_services_count: number;
  period_start: Date | null;
  period_end: Date | null;
  status: string;
}

export interface CustomMcpServersTable {
  id: string;
  user_id: string;
  preset_id: string | null;
  name: string;
  url: string;
  auth_mode: CustomMcpAuthMode;
  status: CustomMcpStatus;
  enabled: boolean;
  revision: number;
  tools: CustomMcpTool[];
  enforcement_projection: CustomMcpTool[];
  encrypted_credentials: string | null;
  pending_expires_at: Date | null;
  action_required_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PlatformDatabase {
  users: UsersTable;
  connected_services: ConnectedServicesTable;
  user_apps: UserAppsTable;
  event_subscriptions: EventSubscriptionsTable;
  billing: BillingTable;
  custom_mcp_servers: CustomMcpServersTable;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  clerkId: string;
  handle: string;
  displayName: string;
  email: string;
  containerId: string;
  containerVersion?: string;
  plan?: string;
  pipedreamExternalId?: string;
}

export interface ConnectServiceInput {
  userId: string;
  service: string;
  pipedreamAccountId: string;
  accountLabel: string;
  accountEmail?: string;
  scopes: string[];
}

export interface CreateUserAppInput {
  userId: string;
  name: string;
  slug: string;
  description?: string;
  servicesUsed: string[];
}

export interface CreateEventSubscriptionInput {
  userId: string;
  service: string;
  eventType: string;
}

export interface CreateCustomMcpServerInput {
  id?: string;
  userId: string;
  name: string;
  url: string;
  authMode: CustomMcpAuthMode;
  encryptedCredentials?: string;
  pendingExpiresAt: Date;
  presetId?: string;
}

export interface UpdateCustomMcpServerInput {
  name?: string;
  enabled?: boolean;
  status?: CustomMcpStatus;
  tools?: CustomMcpTool[];
  encryptedCredentials?: string | null;
  pendingExpiresAt?: Date | null;
  actionRequiredReason?: string | null;
}

export type CustomMcpServerBrokerRow = CustomMcpServersTable;

// ---------------------------------------------------------------------------
// PlatformDb interface
// ---------------------------------------------------------------------------

export interface PlatformDb {
  migrate(): Promise<void>;

  createUser(input: CreateUserInput): Promise<UsersTable>;
  ensureUser(input: CreateUserInput): Promise<UsersTable>;
  getUserByClerkId(clerkId: string): Promise<UsersTable | null>;
  getUserById(id: string): Promise<UsersTable | null>;
  getUserByPipedreamExternalId(externalId: string): Promise<UsersTable | null>;
  updatePipedreamExternalId(userId: string, externalId: string): Promise<void>;

  connectService(input: ConnectServiceInput): Promise<ConnectedServicesTable & { inserted: boolean }>;
  listConnectedServices(userId: string): Promise<ConnectedServicesTable[]>;
  getConnectedService(id: string): Promise<ConnectedServicesTable | null>;
  disconnectService(id: string): Promise<void>;
  updateServiceStatus(id: string, status: ServiceStatus): Promise<void>;
  updateAccountEmail(id: string, email: string): Promise<void>;
  updateAccountLabel(id: string, label: string): Promise<void>;
  touchServiceUsage(id: string): Promise<void>;

  createUserApp(input: CreateUserAppInput): Promise<UserAppsTable>;
  listUserApps(userId: string): Promise<UserAppsTable[]>;
  getUserApp(id: string): Promise<UserAppsTable | null>;

  createEventSubscription(input: CreateEventSubscriptionInput): Promise<EventSubscriptionsTable>;
  listEventSubscriptions(userId: string): Promise<EventSubscriptionsTable[]>;
  deleteEventSubscription(id: string): Promise<void>;

  createCustomMcpServer(input: CreateCustomMcpServerInput): Promise<CustomMcpServer>;
  listCustomMcpServers(userId: string): Promise<CustomMcpServer[]>;
  getCustomMcpServerForBroker(id: string, userId: string): Promise<CustomMcpServerBrokerRow | null>;
  getCustomMcpPresetForBroker(presetId: string, userId: string): Promise<CustomMcpServerBrokerRow | null>;
  updateCustomMcpServer(
    id: string,
    userId: string,
    revision: number,
    update: UpdateCustomMcpServerInput,
  ): Promise<CustomMcpServer | null>;
  updateCustomMcpCredentials(
    id: string,
    userId: string,
    revision: number,
    encryptedCredentials: string,
    status: CustomMcpStatus,
  ): Promise<boolean>;
  deleteCustomMcpServer(id: string, userId: string): Promise<boolean>;
  sweepPendingCustomMcpServers(now: Date): Promise<number>;

  // Escape hatch for queries that Kysely's builder doesn't express cleanly
  // (e.g. RETURNING with custom projections, system columns, or pg-specific
  // features). The `params` array is REQUIRED even when empty -- passing
  // user-controlled input as part of `query` is a SQL injection sink and
  // the required-array shape forces callers to stop and think about what
  // they're interpolating. The previous no-params overload silently accepted
  // any string via `sql.raw(query)`, which is a classic footgun.
  raw(query: string, params: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  destroy(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

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

  function buildUserValues(input: CreateUserInput): InsertObject<PlatformDatabase, "users"> {
    return {
      id: randomUUID(),
      clerk_id: input.clerkId,
      handle: input.handle,
      display_name: input.displayName,
      email: input.email,
      container_id: input.containerId,
      container_version: input.containerVersion ?? null,
      plan: input.plan ?? "free",
      status: "active" as const,
      pipedream_external_id: input.pipedreamExternalId ?? null,
      created_at: sql`now()`,
      updated_at: sql`now()`,
    };
  }

  function publicCustomMcpServer(row: CustomMcpServersTable): CustomMcpServer {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      authMode: row.auth_mode,
      status: row.status,
      enabled: row.enabled,
      revision: row.revision,
      tools: row.tools,
    };
  }

  const db: PlatformDb = {
    async migrate(): Promise<void> {
      await sql`
        CREATE TABLE IF NOT EXISTS users (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          clerk_id             TEXT UNIQUE NOT NULL,
          handle               TEXT UNIQUE NOT NULL,
          display_name         TEXT NOT NULL,
          email                TEXT NOT NULL,
          container_id         TEXT UNIQUE NOT NULL,
          container_version    TEXT,
          plan                 TEXT NOT NULL DEFAULT 'free',
          status               TEXT NOT NULL DEFAULT 'active',
          pipedream_external_id TEXT,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `.execute(kysely);

      await sql`
        CREATE TABLE IF NOT EXISTS connected_services (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          service              TEXT NOT NULL,
          pipedream_account_id TEXT NOT NULL,
          account_label        TEXT NOT NULL,
          account_email        TEXT,
          scopes               TEXT[] NOT NULL DEFAULT '{}',
          status               TEXT NOT NULL DEFAULT 'active',
          connected_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_used_at         TIMESTAMPTZ,
          UNIQUE(user_id, pipedream_account_id)
        )
      `.execute(kysely);

      await sql`
        CREATE TABLE IF NOT EXISTS user_apps (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name                 TEXT NOT NULL,
          slug                 TEXT NOT NULL,
          description          TEXT,
          services_used        TEXT[] NOT NULL DEFAULT '{}',
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE(user_id, slug)
        )
      `.execute(kysely);

      await sql`
        CREATE TABLE IF NOT EXISTS event_subscriptions (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          service              TEXT NOT NULL,
          event_type           TEXT NOT NULL,
          status               TEXT NOT NULL DEFAULT 'active',
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `.execute(kysely);

      await sql`
        CREATE TABLE IF NOT EXISTS billing (
          id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          stripe_customer_id        TEXT,
          plan                      TEXT NOT NULL DEFAULT 'free',
          connected_services_count  INTEGER NOT NULL DEFAULT 0,
          period_start              TIMESTAMPTZ,
          period_end                TIMESTAMPTZ,
          status                    TEXT NOT NULL DEFAULT 'active'
        )
      `.execute(kysely);

      await sql`
        CREATE TABLE IF NOT EXISTS custom_mcp_servers (
          id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          preset_id                TEXT,
          name                     TEXT NOT NULL,
          url                      TEXT NOT NULL,
          auth_mode                TEXT NOT NULL CHECK (auth_mode IN ('none', 'oauth', 'bearer', 'api_key')),
          status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'auth_required', 'ready', 'degraded', 'disabled', 'action_required')),
          enabled                  BOOLEAN NOT NULL DEFAULT false,
          revision                 INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
          tools                    JSONB NOT NULL DEFAULT '[]'::jsonb,
          enforcement_projection   JSONB NOT NULL DEFAULT '[]'::jsonb,
          encrypted_credentials    TEXT,
          pending_expires_at       TIMESTAMPTZ,
          action_required_reason   TEXT,
          created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `.execute(kysely);
      await sql`ALTER TABLE custom_mcp_servers ADD COLUMN IF NOT EXISTS preset_id TEXT`.execute(kysely);

      // Indexes
      await sql`CREATE INDEX IF NOT EXISTS idx_connected_services_user ON connected_services(user_id)`.execute(kysely);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_connected_services_user_account ON connected_services(user_id, pipedream_account_id)`.execute(kysely);
      await sql`CREATE INDEX IF NOT EXISTS idx_user_apps_user ON user_apps(user_id)`.execute(kysely);
      await sql`CREATE INDEX IF NOT EXISTS idx_event_subs_user ON event_subscriptions(user_id)`.execute(kysely);
      await sql`CREATE INDEX IF NOT EXISTS idx_users_pipedream_ext_id ON users(pipedream_external_id)`.execute(kysely);
      await sql`CREATE INDEX IF NOT EXISTS idx_custom_mcp_servers_user ON custom_mcp_servers(user_id)`.execute(kysely);
      await sql`CREATE INDEX IF NOT EXISTS idx_custom_mcp_pending_expiry ON custom_mcp_servers(pending_expires_at) WHERE status = 'pending'`.execute(kysely);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_mcp_user_preset ON custom_mcp_servers(user_id, preset_id) WHERE preset_id IS NOT NULL`.execute(kysely);
    },

    async createUser(input: CreateUserInput): Promise<UsersTable> {
      const result = await kysely
        .insertInto("users")
        .values(buildUserValues(input))
        .returningAll()
        .executeTakeFirstOrThrow();
      return result;
    },

    async ensureUser(input: CreateUserInput): Promise<UsersTable> {
      const result = await kysely
        .insertInto("users")
        .values(buildUserValues(input))
        .onConflict((oc) =>
          oc.column("clerk_id").doUpdateSet({
            handle: input.handle,
            display_name: input.displayName,
            email: input.email,
            container_id: input.containerId,
            container_version: input.containerVersion ?? null,
            plan: input.plan ?? "free",
            status: "active",
            pipedream_external_id: sql`COALESCE(users.pipedream_external_id, EXCLUDED.pipedream_external_id)`,
            updated_at: sql`now()`,
          })
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return result;
    },

    async getUserByClerkId(clerkId: string): Promise<UsersTable | null> {
      const result = await kysely
        .selectFrom("users")
        .selectAll()
        .where("clerk_id", "=", clerkId)
        .executeTakeFirst();
      return result ?? null;
    },

    async getUserById(id: string): Promise<UsersTable | null> {
      const result = await kysely
        .selectFrom("users")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return result ?? null;
    },

    async getUserByPipedreamExternalId(externalId: string): Promise<UsersTable | null> {
      const result = await kysely
        .selectFrom("users")
        .selectAll()
        .where("pipedream_external_id", "=", externalId)
        .executeTakeFirst();
      return result ?? null;
    },

    async updatePipedreamExternalId(userId: string, externalId: string): Promise<void> {
      await kysely
        .updateTable("users")
        .set({ pipedream_external_id: externalId })
        .where("id", "=", userId)
        .execute();
    },

    async connectService(input: ConnectServiceInput): Promise<ConnectedServicesTable & { inserted: boolean }> {
      // Postgres exposes a system column `xmax` that's 0 on a fresh INSERT
      // and the txid of the updater on UPDATE (including ON CONFLICT DO
      // UPDATE). Returning the insert-vs-update flag lets callers distinguish
      // a new row from an upsert-that-was-actually-an-update without a
      // separate query. Used by /sync and /webhook/connected to suppress
      // duplicate `integration:connected` events when concurrent callers
      // race over the same Pipedream account.
      //
      // The comparison `xmax = 0` works at first but breaks after autovacuum
      // freezes the row -- frozen xmax is replaced with FrozenTransactionId
      // (internal txid 2), making `xmax = 0` return false on subsequent
      // upserts of long-lived rows. That would silently suppress
      // integration:connected events (false "not inserted"). Casting through
      // text -- `xmax::text::bigint = 0` -- bypasses the freeze bookkeeping
      // because the text representation of a frozen row's xmax is "0" for
      // visibility purposes, matching the expected insert-vs-update semantics.
      const result = await sql<ConnectedServicesTable & { inserted: boolean }>`
        INSERT INTO connected_services
          (user_id, service, pipedream_account_id, account_label, account_email, scopes)
        VALUES
          (${input.userId}, ${input.service}, ${input.pipedreamAccountId},
           ${input.accountLabel}, ${input.accountEmail ?? null}, ${input.scopes})
        ON CONFLICT (user_id, pipedream_account_id) DO UPDATE SET
          account_email = EXCLUDED.account_email,
          scopes        = EXCLUDED.scopes,
          status        = 'active'
        RETURNING *, (xmax::text::bigint = 0) AS inserted
      `.execute(kysely);
      const row = result.rows[0];
      if (!row) {
        throw new Error("connectService upsert returned no row");
      }
      return row;
    },

    async listConnectedServices(userId: string): Promise<ConnectedServicesTable[]> {
      return kysely
        .selectFrom("connected_services")
        .selectAll()
        .where("user_id", "=", userId)
        .where("status", "=", "active")
        .orderBy("connected_at", "desc")
        .execute();
    },

    async getConnectedService(id: string): Promise<ConnectedServicesTable | null> {
      const result = await kysely
        .selectFrom("connected_services")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return result ?? null;
    },

    async disconnectService(id: string): Promise<void> {
      await kysely
        .updateTable("connected_services")
        .set({ status: "revoked" })
        .where("id", "=", id)
        .execute();
    },

    async updateServiceStatus(id: string, status: ServiceStatus): Promise<void> {
      await kysely
        .updateTable("connected_services")
        .set({ status })
        .where("id", "=", id)
        .execute();
    },

    async updateAccountEmail(id: string, email: string): Promise<void> {
      await kysely
        .updateTable("connected_services")
        .set({ account_email: email })
        .where("id", "=", id)
        .execute();
    },

    async updateAccountLabel(id: string, label: string): Promise<void> {
      await kysely
        .updateTable("connected_services")
        .set({ account_label: label })
        .where("id", "=", id)
        .execute();
    },

    async touchServiceUsage(id: string): Promise<void> {
      await kysely
        .updateTable("connected_services")
        .set({ last_used_at: sql`now()` })
        .where("id", "=", id)
        .execute();
    },

    async createUserApp(input: CreateUserAppInput): Promise<UserAppsTable> {
      const result = await kysely
        .insertInto("user_apps")
        .values({
          id: randomUUID(),
          user_id: input.userId,
          name: input.name,
          slug: input.slug,
          description: input.description ?? null,
          services_used: input.servicesUsed,
          created_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .onConflict((oc) =>
          oc.columns(["user_id", "slug"]).doUpdateSet({
            name: input.name,
            description: input.description ?? null,
            services_used: input.servicesUsed,
            updated_at: sql`now()`,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return result;
    },

    async listUserApps(userId: string): Promise<UserAppsTable[]> {
      return kysely
        .selectFrom("user_apps")
        .selectAll()
        .where("user_id", "=", userId)
        .orderBy("created_at", "desc")
        .execute();
    },

    async getUserApp(id: string): Promise<UserAppsTable | null> {
      const result = await kysely
        .selectFrom("user_apps")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return result ?? null;
    },

    async createEventSubscription(input: CreateEventSubscriptionInput): Promise<EventSubscriptionsTable> {
      const result = await kysely
        .insertInto("event_subscriptions")
        .values({
          id: randomUUID(),
          user_id: input.userId,
          service: input.service,
          event_type: input.eventType,
          status: "active",
          created_at: sql`now()`,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return result;
    },

    async listEventSubscriptions(userId: string): Promise<EventSubscriptionsTable[]> {
      return kysely
        .selectFrom("event_subscriptions")
        .selectAll()
        .where("user_id", "=", userId)
        .where("status", "=", "active")
        .orderBy("created_at", "desc")
        .execute();
    },

    async deleteEventSubscription(id: string): Promise<void> {
      await kysely
        .deleteFrom("event_subscriptions")
        .where("id", "=", id)
        .execute();
    },

    async createCustomMcpServer(input: CreateCustomMcpServerInput): Promise<CustomMcpServer> {
      const row = await kysely.transaction().execute(async (trx) => {
        const owner = await trx
          .selectFrom("users")
          .select("id")
          .where("id", "=", input.userId)
          .forUpdate()
          .executeTakeFirst();
        if (!owner) throw new Error("Custom MCP owner not found");
        const count = await trx
          .selectFrom("custom_mcp_servers")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("user_id", "=", input.userId)
          .where("preset_id", "is", null)
          .executeTakeFirstOrThrow();
        if (Number(count.count) >= 20) throw new Error("Custom MCP server limit reached");
        return trx
          .insertInto("custom_mcp_servers")
          .values({
            id: input.id ?? randomUUID(),
            user_id: input.userId,
            preset_id: input.presetId ?? null,
            name: input.name,
            url: input.url,
            auth_mode: input.authMode,
            status: "pending",
            enabled: false,
            revision: 1,
            tools: sql`'[]'::jsonb`,
            enforcement_projection: sql`'[]'::jsonb`,
            encrypted_credentials: input.encryptedCredentials ?? null,
            pending_expires_at: input.pendingExpiresAt,
            action_required_reason: null,
            created_at: sql`now()`,
            updated_at: sql`now()`,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      });
      return publicCustomMcpServer(row);
    },

    async listCustomMcpServers(userId: string): Promise<CustomMcpServer[]> {
      const rows = await kysely
        .selectFrom("custom_mcp_servers")
        .selectAll()
        .where("user_id", "=", userId)
        .where("preset_id", "is", null)
        .orderBy("created_at", "asc")
        .execute();
      return rows.map(publicCustomMcpServer);
    },

    async getCustomMcpServerForBroker(id: string, userId: string): Promise<CustomMcpServerBrokerRow | null> {
      return await kysely
        .selectFrom("custom_mcp_servers")
        .selectAll()
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .executeTakeFirst() ?? null;
    },

    async getCustomMcpPresetForBroker(presetId: string, userId: string): Promise<CustomMcpServerBrokerRow | null> {
      return await kysely
        .selectFrom("custom_mcp_servers")
        .selectAll()
        .where("preset_id", "=", presetId)
        .where("user_id", "=", userId)
        .executeTakeFirst() ?? null;
    },

    async updateCustomMcpServer(
      id: string,
      userId: string,
      revision: number,
      update: UpdateCustomMcpServerInput,
    ): Promise<CustomMcpServer | null> {
      const values: Record<string, unknown> = {
        revision: sql`revision + 1`,
        updated_at: sql`now()`,
      };
      if (update.name !== undefined) values.name = update.name;
      if (update.enabled !== undefined) values.enabled = update.enabled;
      if (update.status !== undefined) values.status = update.status;
      if (update.tools !== undefined) {
        values.tools = sql`${JSON.stringify(update.tools)}::jsonb`;
        values.enforcement_projection = sql`${JSON.stringify(update.tools)}::jsonb`;
      }
      if (update.encryptedCredentials !== undefined) values.encrypted_credentials = update.encryptedCredentials;
      if (update.pendingExpiresAt !== undefined) values.pending_expires_at = update.pendingExpiresAt;
      if (update.actionRequiredReason !== undefined) values.action_required_reason = update.actionRequiredReason;

      const row = await kysely
        .updateTable("custom_mcp_servers")
        .set(values as never)
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .where("revision", "=", revision)
        .returningAll()
        .executeTakeFirst();
      return row ? publicCustomMcpServer(row) : null;
    },

    async deleteCustomMcpServer(id: string, userId: string): Promise<boolean> {
      const rows = await kysely
        .deleteFrom("custom_mcp_servers")
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .returning("id")
        .execute();
      return rows.length === 1;
    },

    async updateCustomMcpCredentials(
      id: string,
      userId: string,
      revision: number,
      encryptedCredentials: string,
      status: CustomMcpStatus,
    ): Promise<boolean> {
      const row = await kysely
        .updateTable("custom_mcp_servers")
        .set({
          encrypted_credentials: encryptedCredentials,
          status,
          updated_at: sql`now()`,
        })
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .where("revision", "=", revision)
        .returning("id")
        .executeTakeFirst();
      return Boolean(row);
    },

    async sweepPendingCustomMcpServers(now: Date): Promise<number> {
      const rows = await kysely
        .deleteFrom("custom_mcp_servers")
        .where("status", "=", "pending")
        .where("pending_expires_at", "<", now)
        .returning("id")
        .execute();
      return rows.length;
    },

    async raw(query: string, params: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
      if (pool) {
        // pg driver: parameterized query -- $1/$2/... are bound via the
        // second argument, the query string itself is expected to be a
        // developer-authored template, never user input.
        const result = await pool.query(query, params as unknown[]);
        return { rows: result.rows };
      }
      // Test path: Kysely dialect (e.g. KyselyPGlite). Split the query on
      // $N placeholders and rebuild as a tagged-template call so Kysely
      // parameterizes correctly. Empty params still go through this path
      // (strings.length === 1, no interpolations); the `sql.raw` no-params
      // fallback was removed because it's a silent injection sink any
      // caller could trip by passing user input as `query`.
      const parts = query.split(/\$\d+/);
      const strings = Object.assign([...parts], { raw: [...parts] }) as unknown as TemplateStringsArray;
      const compiled = sql(strings, ...params);
      const result = await compiled.execute(kysely);
      return { rows: (result.rows ?? []) as Record<string, unknown>[] };
    },

    async destroy(): Promise<void> {
      await kysely.destroy();
      if (pool) {
        await pool.end();
        pool = null;
      }
    },
  };

  return db;
}
