import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { PlatformDatabase } from "../../platform-db.js";
import type { NativeGmailConnection, NativeGmailState, NativeGmailStore } from "./types.js";

const projection = sql`c.user_id AS "userId", u.pipedream_external_id AS "externalUserId",
  c.id AS "connectionId", c.pipedream_account_id AS "accountId", c.account_label AS "accountLabel",
  c.status, n.account_email AS email, n.encrypted_credentials AS "encryptedCredentials", n.revision`;

/** Injected platform DB belongs to the caller; this store never closes it. */
export function createNativeGmailStore(db: Kysely<PlatformDatabase>): NativeGmailStore {
  return {
    async migrate() {
      await sql`CREATE TABLE IF NOT EXISTS native_gmail_credentials (
        connection_id UUID PRIMARY KEY REFERENCES connected_services(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_email TEXT NOT NULL, encrypted_credentials TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1, lease_id UUID, lease_expires_at TIMESTAMPTZ,
        UNIQUE(user_id, account_email))`.execute(db);
      await sql`ALTER TABLE native_gmail_credentials ADD COLUMN IF NOT EXISTS lease_operation TEXT
        CHECK (lease_operation IN ('refresh','revoke'))`.execute(db);
      await sql`CREATE TABLE IF NOT EXISTS native_gmail_owner_leases (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        lease_id UUID NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`.execute(db);
      await sql`CREATE TABLE IF NOT EXISTS native_gmail_oauth_states (
        state_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        external_user_id TEXT NOT NULL, encrypted_verifier TEXT NOT NULL, account_label TEXT NOT NULL,
        redirect_uri TEXT, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS native_gmail_state_expiry ON native_gmail_oauth_states(expires_at)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS native_gmail_state_owner ON native_gmail_oauth_states(user_id, created_at)`.execute(db);
    },
    async acquireOwnerLease(userId, now) {
      const leaseId = randomUUID();
      await sql`DELETE FROM native_gmail_owner_leases WHERE expires_at <= ${now}`.execute(db);
      const result = await sql`INSERT INTO native_gmail_owner_leases (user_id,lease_id,expires_at)
        VALUES (${userId},${leaseId},${new Date(now.getTime()+30_000)}) ON CONFLICT (user_id) DO NOTHING
        RETURNING user_id`.execute(db);
      return result.rows.length ? leaseId : null;
    },
    async releaseOwnerLease(userId, leaseId) {
      await sql`DELETE FROM native_gmail_owner_leases WHERE user_id=${userId} AND lease_id=${leaseId}`.execute(db);
    },
    async startState(input) {
      await db.transaction().execute(async (tx) => {
        const owner = await sql`SELECT id FROM users WHERE id=${input.userId}
          AND pipedream_external_id=${input.externalUserId} FOR UPDATE`.execute(tx);
        if (!owner.rows.length) throw new Error("Gmail owner unavailable");
        await sql`DELETE FROM native_gmail_oauth_states WHERE expires_at <= ${input.now}`.execute(tx);
        // The owner row serializes competing starts. Remove oldest sessions before inserting the eighth.
        await sql`DELETE FROM native_gmail_oauth_states WHERE state_hash IN
          (SELECT state_hash FROM native_gmail_oauth_states WHERE user_id=${input.userId}
           ORDER BY created_at DESC, state_hash DESC OFFSET 7)`.execute(tx);
        await sql`INSERT INTO native_gmail_oauth_states
          (state_hash,user_id,external_user_id,encrypted_verifier,account_label,redirect_uri,created_at,expires_at)
          VALUES (${input.hash},${input.userId},${input.externalUserId},${input.encryptedVerifier},
            ${input.label},${input.redirectUri ?? null},${input.now},${input.expiresAt})`.execute(tx);
      });
    },
    async inspectState(hash, now) {
      const result = await sql<NativeGmailState>`SELECT s.state_hash AS hash,s.user_id AS "userId",
        s.external_user_id AS "externalUserId",s.encrypted_verifier AS "encryptedVerifier",
        s.account_label AS label,s.redirect_uri AS "redirectUri",s.expires_at AS "expiresAt"
        FROM native_gmail_oauth_states s JOIN users u ON u.id=s.user_id
        AND u.pipedream_external_id=s.external_user_id WHERE s.state_hash=${hash} AND s.expires_at > ${now}`.execute(db);
      return result.rows[0] ?? null;
    },
    async consumeState(hash, now) {
      const result = await sql<NativeGmailState>`DELETE FROM native_gmail_oauth_states WHERE state_hash=${hash}
        RETURNING state_hash AS hash,user_id AS "userId",external_user_id AS "externalUserId",
        encrypted_verifier AS "encryptedVerifier",account_label AS label,redirect_uri AS "redirectUri",expires_at AS "expiresAt"`.execute(db);
      const row = result.rows[0];
      return row && row.expiresAt.getTime() > now.getTime() ? row : null;
    },
    async connect(input) {
      return db.transaction().execute(async (tx) => {
        const owner = await sql`SELECT id FROM users WHERE id=${input.userId}
          AND pipedream_external_id=${input.externalUserId} FOR UPDATE`.execute(tx);
        if (!owner.rows.length) throw new Error("Gmail owner unavailable");
        if (input.ownerLease) {
          const admitted = await sql`SELECT user_id FROM native_gmail_owner_leases WHERE user_id=${input.userId}
            AND lease_id=${input.ownerLease} AND expires_at > ${input.now} FOR UPDATE`.execute(tx);
          if (!admitted.rows.length) throw new Error("Gmail connection busy");
        }
        const prior = await sql<{ connectionId: string; accountId: string; accountLabel: string }>`SELECT c.id AS "connectionId",
          c.pipedream_account_id AS "accountId", c.account_label AS "accountLabel" FROM native_gmail_credentials n
          JOIN connected_services c ON c.id=n.connection_id AND c.user_id=n.user_id
          WHERE n.user_id=${input.userId} AND n.account_email=${input.email}`.execute(tx);
        if (prior.rows[0]) {
          // Same order as refresh settlement: canonical service first, then credential row.
          await sql`SELECT id FROM connected_services WHERE id=${prior.rows[0].connectionId} FOR UPDATE`.execute(tx);
          const busy = await sql<{ lease_id: string | null; lease_expires_at: Date | null }>`SELECT lease_id,lease_expires_at
            FROM native_gmail_credentials WHERE connection_id=${prior.rows[0].connectionId} FOR UPDATE`.execute(tx);
          if (busy.rows[0]?.lease_id && busy.rows[0].lease_expires_at && busy.rows[0].lease_expires_at > input.now)
            throw new Error("Gmail connection busy");
        }
        const connectionId = prior.rows[0]?.connectionId ?? randomUUID();
        const accountId = prior.rows[0]?.accountId ?? `gmail_${randomUUID()}`;
        let accountLabel = input.label ?? prior.rows[0]?.accountLabel;
        if (!accountLabel) {
          const available = await sql<{ label: string }>`SELECT CASE WHEN n=1 THEN 'Gmail' ELSE 'Gmail ' || n END AS label
            FROM generate_series(1,1000) n WHERE NOT EXISTS (SELECT 1 FROM connected_services
              WHERE user_id=${input.userId} AND service='gmail'
              AND LOWER(account_label)=LOWER(CASE WHEN n=1 THEN 'Gmail' ELSE 'Gmail ' || n END))
            ORDER BY n LIMIT 1`.execute(tx);
          accountLabel = available.rows[0]?.label;
          if (!accountLabel) throw new Error("Gmail connection unavailable");
        }
        const encrypted = input.encrypt(accountId);
        await sql`INSERT INTO connected_services (id,user_id,service,pipedream_account_id,account_label,account_email,scopes,status,connected_at)
          VALUES (${connectionId},${input.userId},'gmail',${accountId},${accountLabel},${input.email},${input.scopes},'active',${input.now})
          ON CONFLICT (user_id,pipedream_account_id) DO UPDATE SET account_label=EXCLUDED.account_label,
            scopes=EXCLUDED.scopes,status='active',connected_at=EXCLUDED.connected_at`.execute(tx);
        await sql`INSERT INTO native_gmail_credentials (connection_id,user_id,account_email,encrypted_credentials)
          VALUES (${connectionId},${input.userId},${input.email},${encrypted})
          ON CONFLICT (user_id,account_email) DO UPDATE SET encrypted_credentials=EXCLUDED.encrypted_credentials,
            revision=native_gmail_credentials.revision+1,lease_id=NULL,lease_expires_at=NULL,lease_operation=NULL`.execute(tx);
        const row = await sql<NativeGmailConnection>`SELECT ${projection} FROM native_gmail_credentials n
          JOIN connected_services c ON c.id=n.connection_id AND c.user_id=n.user_id
          JOIN users u ON u.id=n.user_id WHERE c.id=${connectionId}`.execute(tx);
        return row.rows[0]!;
      });
    },
    async lookup(binding, now = new Date()) {
      const row = await sql<NativeGmailConnection>`SELECT ${projection} FROM native_gmail_credentials n
        JOIN connected_services c ON c.id=n.connection_id AND c.user_id=n.user_id JOIN users u ON u.id=n.user_id
        WHERE u.pipedream_external_id=${binding.externalUserId} AND c.pipedream_account_id=${binding.accountId}
        AND c.service='gmail' AND c.status='active' AND (n.lease_id IS NULL OR n.lease_expires_at <= ${now})`.execute(db);
      return row.rows[0] ?? null;
    },
    async refreshPending(binding, now) {
      const result = await sql`SELECT n.connection_id FROM native_gmail_credentials n
        JOIN connected_services c ON c.id=n.connection_id AND c.user_id=n.user_id JOIN users u ON u.id=n.user_id
        WHERE u.pipedream_external_id=${binding.externalUserId} AND c.pipedream_account_id=${binding.accountId}
        AND c.service='gmail' AND c.status='active' AND n.lease_id IS NOT NULL
        AND n.lease_operation='refresh' AND n.lease_expires_at > ${now}`.execute(db);
      return result.rows.length > 0;
    },
    async byConnection(binding) {
      const row = await sql<NativeGmailConnection>`SELECT ${projection} FROM native_gmail_credentials n
        JOIN connected_services c ON c.id=n.connection_id AND c.user_id=n.user_id JOIN users u ON u.id=n.user_id
        WHERE c.user_id=${binding.userId} AND c.id=${binding.connectionId} AND c.service='gmail'`.execute(db);
      return row.rows[0] ?? null;
    },
    async acquireLease(row, now, operation = "refresh") {
      if (operation === "refresh" && row.status !== "active") return null;
      const leaseId = randomUUID();
      const result = await sql`UPDATE native_gmail_credentials n SET lease_id=${leaseId},
        lease_expires_at=${new Date(now.getTime() + 30_000)},lease_operation=${operation}
        WHERE n.connection_id=${row.connectionId} AND n.user_id=${row.userId} AND n.revision=${row.revision}
        AND (n.lease_id IS NULL OR n.lease_expires_at <= ${now})
        AND EXISTS (SELECT 1 FROM connected_services c JOIN users u ON u.id=c.user_id
          WHERE c.id=n.connection_id AND c.user_id=n.user_id AND c.pipedream_account_id=${row.accountId}
          AND u.pipedream_external_id=${row.externalUserId} AND c.service='gmail'
          AND (${operation}='revoke' OR c.status='active'))
        RETURNING n.connection_id`.execute(db);
      return result.rows.length ? { ...row, leaseId } : null;
    },
    async settle(lease, encrypted, status, now) {
      return db.transaction().execute(async (tx) => {
        // Lock the canonical service too: concurrent revoke cannot race the active check below.
        const current = await sql`SELECT id FROM connected_services WHERE id=${lease.connectionId}
          AND user_id=${lease.userId} AND service='gmail' AND status='active' FOR UPDATE`.execute(tx);
        if (!current.rows.length) return false;
        const result = await sql`UPDATE native_gmail_credentials SET encrypted_credentials=${encrypted},
          revision=revision+1,lease_id=NULL,lease_expires_at=NULL,lease_operation=NULL WHERE connection_id=${lease.connectionId}
          AND user_id=${lease.userId} AND revision=${lease.revision} AND lease_id=${lease.leaseId}
          AND lease_operation='refresh' AND lease_expires_at > ${now} RETURNING connection_id`.execute(tx);
        if (!result.rows.length) return false;
        if (status === "expired") await sql`UPDATE connected_services SET status='expired'
          WHERE id=${lease.connectionId} AND user_id=${lease.userId} AND status='active'`.execute(tx);
        return true;
      });
    },
    async releaseLease(lease) {
      await sql`UPDATE native_gmail_credentials SET lease_id=NULL,lease_expires_at=NULL,lease_operation=NULL
        WHERE connection_id=${lease.connectionId} AND user_id=${lease.userId}
        AND revision=${lease.revision} AND lease_id=${lease.leaseId}`.execute(db);
    },
    async remove(lease, now) {
      const result = await sql`DELETE FROM connected_services c WHERE c.id=${lease.connectionId}
        AND c.user_id=${lease.userId} AND c.service='gmail' AND EXISTS
        (SELECT 1 FROM native_gmail_credentials n WHERE n.connection_id=c.id AND n.user_id=c.user_id
          AND n.revision=${lease.revision} AND n.lease_id=${lease.leaseId} AND n.lease_operation='revoke' AND n.lease_expires_at > ${now})
        RETURNING c.id`.execute(db);
      return Boolean(result.rows.length);
    },
    async assertCurrent(row, now) {
      const current = await this.lookup(row, now);
      return current?.connectionId === row.connectionId && current.revision === row.revision;
    },
  };
}
