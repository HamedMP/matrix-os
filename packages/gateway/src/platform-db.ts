import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { randomUUID } from "node:crypto";

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

export interface PlatformDatabase {
  users: UsersTable;
  connected_services: ConnectedServicesTable;
  user_apps: UserAppsTable;
  event_subscriptions: EventSubscriptionsTable;
  billing: BillingTable;
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

// ---------------------------------------------------------------------------
// PlatformDb interface
// ---------------------------------------------------------------------------

export interface PlatformDb {
  migrate(): Promise<void>;

  createUser(input: CreateUserInput): Promise<UsersTable>;
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

      // Indexes
      await sql`CREATE INDEX IF NOT EXISTS idx_connected_services_user ON connected_services(user_id)`.execute(kysely);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_connected_services_user_account ON connected_services(user_id, pipedream_account_id)`.execute(kysely);
      await sql`CREATE INDEX IF NOT EXISTS idx_user_apps_user ON user_apps(user_id)`.execute(kysely);
      await sql`CREATE INDEX IF NOT EXISTS idx_event_subs_user ON event_subscriptions(user_id)`.execute(kysely);
      await sql`CREATE INDEX IF NOT EXISTS idx_users_pipedream_ext_id ON users(pipedream_external_id)`.execute(kysely);
    },

    async createUser(input: CreateUserInput): Promise<UsersTable> {
      const result = await kysely
        .insertInto("users")
        .values({
          id: randomUUID(),
          clerk_id: input.clerkId,
          handle: input.handle,
          display_name: input.displayName,
          email: input.email,
          container_id: input.containerId,
          container_version: input.containerVersion ?? null,
          plan: input.plan ?? "free",
          status: "active",
          pipedream_external_id: input.pipedreamExternalId ?? null,
          created_at: sql`now()`,
          updated_at: sql`now()`,
        })
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
