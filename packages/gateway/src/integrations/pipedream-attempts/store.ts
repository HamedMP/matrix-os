import { sql, type Kysely } from "kysely";
import type { PlatformDatabase } from "../../platform-db.js";

export interface PipedreamAttempt {
  id: string; userId: string | null; externalUserId: string; environment: string;
  nonceHash: string; tokenHash: string | null; label: string | null;
  status: "preparing" | "pending" | "succeeded" | "failed"; accountId: string | null; expiresAt: Date;
}
const projection = sql`id,user_id AS "userId",external_user_id AS "externalUserId",environment,
  nonce_hash AS "nonceHash",token_hash AS "tokenHash",label,status,account_id AS "accountId",expires_at AS "expiresAt"`;
export type PipedreamAttemptStore = ReturnType<typeof createPipedreamAttemptStore>;

/** The injected database is owned by PlatformDb; this store drains only its own sweep. */
export function createPipedreamAttemptStore(db: Kysely<PlatformDatabase>) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweep: Promise<unknown> | undefined;
  const cleanup = async (now = new Date()) => {
    await sql`DELETE FROM gmail_pipedream_attempts WHERE expires_at <= ${now}`.execute(db);
  };
  return {
    async migrate() {
      await sql`CREATE TABLE IF NOT EXISTS gmail_pipedream_attempts (
        id UUID PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        external_user_id TEXT NOT NULL, app TEXT NOT NULL DEFAULT 'gmail' CHECK(app='gmail'),
        environment TEXT NOT NULL CHECK(environment IN ('production','development')),
        nonce_hash TEXT NOT NULL, token_hash TEXT, label TEXT,
        status TEXT NOT NULL CHECK(status IN ('preparing','pending','succeeded','failed')),
        account_id UUID REFERENCES connected_services(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS gmail_pipedream_attempt_expiry ON gmail_pipedream_attempts(expires_at)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS gmail_pipedream_attempt_owner ON gmail_pipedream_attempts(user_id)`.execute(db);
      await cleanup();
      if (!timer) {
        timer = setInterval(() => {
          if (!sweep) sweep = cleanup().catch(error => console.warn("[gmail-attempt] Sweep failed:", error instanceof Error ? error.name : "UnknownError"))
            .finally(() => { sweep = undefined; });
        }, 300_000);
        timer.unref();
      }
    },
    async prepare(input: { id: string; userId: string; externalUserId: string; environment: string; nonceHash: string; label?: string; now: Date; expiresAt: Date }) {
      await db.transaction().execute(async tx => {
        // Serialize the global count+insert as well as each owner's count. No READ COMMITTED cap race.
        await sql`SELECT pg_advisory_xact_lock(5510355)`.execute(tx);
        const owner = await sql`SELECT id FROM users WHERE id=${input.userId} AND pipedream_external_id=${input.externalUserId} FOR UPDATE`.execute(tx);
        if (!owner.rows.length) throw new Error("Connection unavailable");
        await sql`DELETE FROM gmail_pipedream_attempts WHERE expires_at <= ${input.now}`.execute(tx);
        const counts = await sql<{ total: number; owned: number }>`SELECT count(*)::int AS total,
          count(*) FILTER (WHERE user_id=${input.userId})::int AS owned FROM gmail_pipedream_attempts`.execute(tx);
        if (counts.rows[0]!.total >= 10_000 || counts.rows[0]!.owned >= 8) throw new Error("Connection unavailable");
        await sql`INSERT INTO gmail_pipedream_attempts(id,user_id,external_user_id,environment,nonce_hash,label,status,created_at,expires_at)
          VALUES(${input.id},${input.userId},${input.externalUserId},${input.environment},${input.nonceHash},${input.label ?? null},'preparing',${input.now},${input.expiresAt})`.execute(tx);
      });
    },
    async activate(id: string, tokenHash: string, expiresAt: Date) {
      const result = await sql`UPDATE gmail_pipedream_attempts SET token_hash=${tokenHash},expires_at=LEAST(expires_at,${expiresAt}),status='pending'
        WHERE id=${id} AND status='preparing' AND expires_at > now() RETURNING id`.execute(db);
      if (!result.rows.length) throw new Error("Connection unavailable");
    },
    async inspect(id: string): Promise<PipedreamAttempt | null> {
      return (await sql<PipedreamAttempt>`SELECT ${projection} FROM gmail_pipedream_attempts WHERE id=${id}`.execute(db)).rows[0] ?? null;
    },
    async status(id: string, userId: string, now = new Date()) {
      const result = await sql<PipedreamAttempt & { active: boolean }>`SELECT a.id,a.status,a.account_id AS "accountId",a.expires_at AS "expiresAt",
        EXISTS(SELECT 1 FROM connected_services c WHERE c.id=a.account_id AND c.user_id=a.user_id AND c.service='gmail' AND c.status='active') AS active
        FROM gmail_pipedream_attempts a JOIN users u ON u.id=a.user_id AND u.pipedream_external_id=a.external_user_id
        WHERE a.id=${id} AND a.user_id=${userId}`.execute(db);
      const row = result.rows[0];
      if (!row) return null;
      if (row.expiresAt <= now) return { status: "expired" as const };
      if (row.status === "succeeded") return row.active && row.accountId ? { status: "succeeded" as const, accountId: row.accountId } : { status: "failed" as const };
      return { status: row.status === "failed" ? "failed" as const : "pending" as const };
    },
    async fail(id: string) {
      await sql`UPDATE gmail_pipedream_attempts SET status='failed' WHERE id=${id} AND status IN ('preparing','pending')`.execute(db);
    },
    async complete(attempt: PipedreamAttempt, providerAccountId: string, email?: string) {
      return db.transaction().execute(async tx => {
        const owner = await sql`SELECT id FROM users WHERE id=${attempt.userId} AND pipedream_external_id=${attempt.externalUserId} FOR UPDATE`.execute(tx);
        if (!owner.rows.length) throw new Error("Connection unavailable");
        const locked = await sql<PipedreamAttempt>`SELECT ${projection} FROM gmail_pipedream_attempts WHERE id=${attempt.id} FOR UPDATE`.execute(tx);
        const row = locked.rows[0];
        if (!row || row.status !== "pending" || row.expiresAt <= new Date()) return null;
        const result = await sql<{ id: string; inserted: boolean; account_label: string }>`INSERT INTO connected_services
          (user_id,service,pipedream_account_id,account_label,account_email,scopes)
          VALUES(${row.userId},'gmail',${providerAccountId},${row.label ?? 'gmail'},${email ?? null},ARRAY[]::text[])
          ON CONFLICT(user_id,pipedream_account_id) DO UPDATE SET status='active',
            account_label=COALESCE(${row.label},connected_services.account_label),
            account_email=COALESCE(${email ?? null},connected_services.account_email)
          WHERE connected_services.service='gmail'
          RETURNING id,account_label,(xmax::text::bigint=0) AS inserted`.execute(tx);
        const connection = result.rows[0];
        if (!connection) throw new Error("Connection unavailable");
        await sql`UPDATE gmail_pipedream_attempts SET status='succeeded',account_id=${connection.id} WHERE id=${row.id} AND status='pending'`.execute(tx);
        return connection;
      });
    },
    cleanup,
    async shutdown() { if (timer) clearInterval(timer); timer = undefined; await sweep; },
  };
}
