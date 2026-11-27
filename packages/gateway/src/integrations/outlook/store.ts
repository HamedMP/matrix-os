import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { ConnectedServicesTable, PlatformDatabase } from "../../platform-db.js";
import { isOutlookService, type OutlookAccount, type OutlookService } from "./oauth.js";
import { OutlookError } from "./http.js";

const ID_PREFIX = "matrix_outlook_";
const MAX_ATTEMPTS_PER_OWNER = 8;

export function isNativeOutlookConnection(connection: { id: string; service: string; pipedream_account_id: string }): boolean {
  return isOutlookService(connection.service) && connection.pipedream_account_id === `${ID_PREFIX}${connection.id}`;
}

interface AuthorizationAttempt {
  userId: string;
  encryptedPayload: string;
}

interface StoredGrant {
  encrypted: string;
  revision: string;
}

interface LinkOutlookInput {
  userId: string;
  service: OutlookService;
  account: OutlookAccount;
  label?: string;
  scopes: readonly string[];
  encrypt: (connectionId: string) => string;
  replace?: { connectionId: string; expectedProviderRef: string; graphAccountId: string };
}

async function lockOwner(tx: Transaction<PlatformDatabase>, userId: string): Promise<void> {
  const owner = await tx.selectFrom("users").select("id").where("id", "=", userId)
    .where("status", "=", "active").forUpdate().executeTakeFirst();
  if (!owner) throw new OutlookError("unavailable");
}

export type OutlookStore = ReturnType<typeof createOutlookStore>;

/** Platform owns the database. Its injected executor is shared with the integration registry. */
export function createOutlookStore(db: Kysely<PlatformDatabase>) {
  return {
    async migrate() {
      await db.transaction().execute(async tx => {
        // Different Cloud Run revisions may start at the same time.
        await sql`SELECT pg_advisory_xact_lock(731111104)`.execute(tx);
        await sql`CREATE TABLE IF NOT EXISTS matrix_outlook_attempts (
          state_hash TEXT PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          encrypted_payload TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL
        )`.execute(tx);
        await sql`CREATE INDEX IF NOT EXISTS idx_matrix_outlook_owner_attempts
          ON matrix_outlook_attempts(user_id, created_at DESC)`.execute(tx);
        await sql`CREATE INDEX IF NOT EXISTS idx_matrix_outlook_attempt_expiry
          ON matrix_outlook_attempts(expires_at)`.execute(tx);
        await sql`CREATE TABLE IF NOT EXISTS matrix_outlook_grants (
          connection_id UUID PRIMARY KEY REFERENCES connected_services(id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          service TEXT NOT NULL CHECK (service IN ('microsoft_outlook', 'microsoft_outlook_calendar')),
          graph_account_id TEXT NOT NULL,
          encrypted_credential TEXT NOT NULL,
          revision UUID NOT NULL,
          UNIQUE (user_id, service, graph_account_id)
        )`.execute(tx);
        await sql`CREATE TABLE IF NOT EXISTS matrix_outlook_retired_accounts (
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider_account_id TEXT NOT NULL,
          retired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          cleaned_at TIMESTAMPTZ,
          retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, provider_account_id)
        )`.execute(tx);
        await sql`ALTER TABLE matrix_outlook_retired_accounts ADD COLUMN IF NOT EXISTS
          retry_at TIMESTAMPTZ NOT NULL DEFAULT now()`.execute(tx);
        await sql`CREATE INDEX IF NOT EXISTS idx_matrix_outlook_cleanup_retry
          ON matrix_outlook_retired_accounts(retry_at, retired_at) WHERE cleaned_at IS NULL`.execute(tx);
      });
    },

    async saveAttempt(input: AuthorizationAttempt & { hash: string; now: Date; expiresAt: Date }) {
      await db.transaction().execute(async tx => {
        await lockOwner(tx, input.userId);
        await sql`DELETE FROM matrix_outlook_attempts WHERE user_id = ${input.userId} AND
          (expires_at <= ${input.now} OR state_hash IN (
            SELECT state_hash FROM matrix_outlook_attempts
            WHERE user_id = ${input.userId} AND expires_at > ${input.now}
            ORDER BY created_at DESC, state_hash DESC OFFSET ${MAX_ATTEMPTS_PER_OWNER - 1}
          ))`.execute(tx);
        await sql`INSERT INTO matrix_outlook_attempts (state_hash, user_id, encrypted_payload, created_at, expires_at)
          VALUES (${input.hash}, ${input.userId}, ${input.encryptedPayload}, ${input.now}, ${input.expiresAt})`.execute(tx);
      });
    },

    async getAttempt(hash: string, userId: string, now: Date) {
      const result = await sql<AuthorizationAttempt>`SELECT user_id AS "userId", encrypted_payload AS "encryptedPayload"
        FROM matrix_outlook_attempts WHERE state_hash = ${hash} AND user_id = ${userId} AND expires_at > ${now}`.execute(db);
      return result.rows[0] ?? null;
    },

    async consumeAttempt(hash: string, userId: string, now: Date) {
      const result = await sql<AuthorizationAttempt>`DELETE FROM matrix_outlook_attempts
        WHERE state_hash = ${hash} AND user_id = ${userId} AND expires_at > ${now}
        RETURNING user_id AS "userId", encrypted_payload AS "encryptedPayload"`.execute(db);
      return result.rows[0] ?? null;
    },

    async sweepAttempts(now: Date) {
      await sql`DELETE FROM matrix_outlook_attempts WHERE state_hash IN (
        SELECT state_hash FROM matrix_outlook_attempts WHERE expires_at <= ${now} ORDER BY expires_at LIMIT 500
      )`.execute(db);
    },

    async link(input: LinkOutlookInput): Promise<ConnectedServicesTable> {
      const { userId, service, account, replace } = input;
      return db.transaction().execute(async tx => {
        await lockOwner(tx, userId);
        const currentResult = await sql<{ id: string }>`SELECT connection_id AS id
          FROM matrix_outlook_grants WHERE user_id = ${userId} AND service = ${service} AND graph_account_id = ${account.id}`.execute(tx);
        const currentId = currentResult.rows[0]?.id;
        const id = replace?.connectionId ?? currentId ?? randomUUID();
        const row = (replace || currentId) ? await tx.selectFrom("connected_services").selectAll()
          .where("id", "=", id).where("user_id", "=", userId).where("service", "=", service)
          .where("status", "=", "active").forUpdate().executeTakeFirst() : undefined;
        if ((replace || currentId) && !row) throw new OutlookError("consent_required");
        if (replace && (replace.graphAccountId !== account.id || replace.expectedProviderRef !== row?.pipedream_account_id
          || ((currentId !== undefined || (row && isNativeOutlookConnection(row))) && currentId !== id))) throw new OutlookError("consent_required");

        const providerRef = `${ID_PREFIX}${id}`;
        const next = {
          pipedream_account_id: providerRef,
          account_email: row ? row.account_email : account.email,
          account_label: input.label ?? row?.account_label ?? account.email ?? service,
          scopes: [...input.scopes],
          status: "active" as const,
          connected_at: sql<Date>`now()`,
        };
        const connection = row
          ? await tx.updateTable("connected_services").set(next).where("id", "=", id).returningAll().executeTakeFirstOrThrow()
          : await tx.insertInto("connected_services").values({
            ...next, id, user_id: userId, service, last_used_at: null,
          }).returningAll().executeTakeFirstOrThrow();

        const encrypted = input.encrypt(id);
        const revision = randomUUID();
        await sql`INSERT INTO matrix_outlook_grants
          (connection_id, user_id, service, graph_account_id, encrypted_credential, revision)
          VALUES (${id}, ${userId}, ${service}, ${account.id}, ${encrypted}, ${revision})
          ON CONFLICT (connection_id) DO UPDATE SET encrypted_credential = EXCLUDED.encrypted_credential,
            revision = EXCLUDED.revision`.execute(tx);

        if (row && !isNativeOutlookConnection(row)) {
          await sql`INSERT INTO matrix_outlook_retired_accounts (user_id, provider_account_id)
            VALUES (${userId}, ${row.pipedream_account_id}) ON CONFLICT DO NOTHING`.execute(tx);
        }
        return connection;
      });
    },

    async getGrant(userId: string, service: OutlookService, connectionId: string) {
      const result = await sql<StoredGrant & { accountId: string }>`SELECT g.encrypted_credential AS encrypted,
        g.revision, g.graph_account_id AS "accountId" FROM matrix_outlook_grants g
        JOIN connected_services c ON c.id = g.connection_id AND c.user_id = g.user_id AND c.service = g.service
        WHERE g.user_id = ${userId} AND g.service = ${service} AND c.id = ${connectionId}
        AND c.status = 'active' AND c.pipedream_account_id = ${ID_PREFIX + connectionId}`.execute(db);
      return result.rows[0] ?? null;
    },

    async refreshGrant(userId: string, connectionId: string, previousRevision: string, encrypted: string) {
      const result = await sql`UPDATE matrix_outlook_grants SET encrypted_credential = ${encrypted}, revision = ${randomUUID()}
        WHERE user_id = ${userId} AND connection_id = ${connectionId} AND revision = ${previousRevision}
        RETURNING revision`.execute(db);
      return result.rows.length === 1;
    },

    async disconnect(userId: string, connectionId: string) {
      return db.transaction().execute(async tx => {
        await lockOwner(tx, userId);
        const row = await tx.selectFrom("connected_services").selectAll()
          .where("id", "=", connectionId).where("user_id", "=", userId).where("status", "=", "active")
          .forUpdate().executeTakeFirst();
        if (!row || !isNativeOutlookConnection(row)) return false;
        await sql`DELETE FROM matrix_outlook_grants WHERE connection_id = ${connectionId} AND user_id = ${userId}`.execute(tx);
        await tx.updateTable("connected_services").set({ status: "revoked" }).where("id", "=", connectionId).execute();
        return true;
      });
    },

    async claimPendingLegacyCleanup(now: Date) {
      const retryAt = new Date(now.getTime() + 60_000);
      const result = await sql<{ userId: string; providerAccountId: string }>`
        WITH candidates AS (
          SELECT user_id, provider_account_id FROM matrix_outlook_retired_accounts
          WHERE cleaned_at IS NULL AND retry_at <= ${now} ORDER BY retry_at, retired_at
          LIMIT 5 FOR UPDATE SKIP LOCKED
        )
        UPDATE matrix_outlook_retired_accounts AS retired SET retry_at = ${retryAt}
        FROM candidates
        WHERE retired.user_id = candidates.user_id AND retired.provider_account_id = candidates.provider_account_id
        RETURNING retired.user_id AS "userId", retired.provider_account_id AS "providerAccountId"`.execute(db);
      return result.rows;
    },

    async markLegacyCleaned(userId: string, providerAccountId: string) {
      await sql`UPDATE matrix_outlook_retired_accounts SET cleaned_at = now()
        WHERE user_id = ${userId} AND provider_account_id = ${providerAccountId} AND cleaned_at IS NULL`.execute(db);
    },
  };
}
