import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { AoedeTranscript } from "@matrix-os/contracts";

export type SessionState = "connecting" | "active" | "closing" | "closed" | "interrupted" | "superseded" | "error";
export interface SessionRecord {
  id: string; owner_id: string; runtime_id: string; invocation_id: string; fingerprint: string;
  state: SessionState; provider_id: string | null; answer: string | null; chat_id: string | null;
  started_at: Date; ended_at: Date | null; expires_at: Date | null;
  finalization_confirmed: boolean;
  checkpoint_epoch: number;
  checkpoint: AoedeTranscript[]; checkpoint_until: Date | null;
}
export interface DelegationRecord {
  session_id: string; delegation_id: string; request_id: string; state: "pending" | "done" | "uncertain";
  chat_id: string | null; run_id: string | null; queued_turn_id: string | null;
}
export class AoedeConflictError extends Error {}

// Wrap the existing owner AppDbWithKysely.kysely. This wrapper never destroys its borrowed pool.
export function createAoedeRepository(db: Kysely<any>, identity: { ownerId: string; runtimeId: string }) {
  const scope = (id: string) => db.selectFrom("aoede_sessions").selectAll()
    .where("owner_id", "=", identity.ownerId).where("id", "=", id);
  return {
    ...identity,
    async bootstrap() {
      await sql`CREATE TABLE IF NOT EXISTS aoede_sessions (
        id uuid PRIMARY KEY, owner_id text NOT NULL, runtime_id text NOT NULL,
        invocation_id uuid NOT NULL, fingerprint text NOT NULL, state text NOT NULL,
        provider_id text, answer text, chat_id text, started_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz, expires_at timestamptz, checkpoint jsonb NOT NULL DEFAULT '[]',
        checkpoint_until timestamptz, UNIQUE(owner_id, invocation_id)
      )`.execute(db);
      await sql`ALTER TABLE aoede_sessions ADD COLUMN IF NOT EXISTS finalization_confirmed boolean NOT NULL DEFAULT false`.execute(db);
      await sql`ALTER TABLE aoede_sessions ADD COLUMN IF NOT EXISTS checkpoint_epoch integer NOT NULL DEFAULT 0`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS aoede_one_active ON aoede_sessions(owner_id)
        WHERE state IN ('connecting', 'active', 'closing')`.execute(db);
      await sql`CREATE TABLE IF NOT EXISTS aoede_delegations (
        session_id uuid NOT NULL REFERENCES aoede_sessions(id) ON DELETE CASCADE,
        delegation_id text NOT NULL, request_id uuid NOT NULL, state text NOT NULL,
        chat_id text, run_id text, queued_turn_id text, PRIMARY KEY(session_id, delegation_id)
      )`.execute(db);
    },
    async reserve(invocationId: string, fingerprint: string) {
      return db.transaction().execute(async (tx) => {
        // Serialize owner singleton creation across processes, without holding a lock during provider I/O.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity.ownerId}, 0))`.execute(tx);
        const existing = await tx.selectFrom("aoede_sessions").selectAll()
          .where("owner_id", "=", identity.ownerId).where("invocation_id", "=", invocationId).executeTakeFirst();
        if (existing) {
          if (existing.fingerprint !== fingerprint || existing.runtime_id !== identity.runtimeId) throw new AoedeConflictError();
          return { record: existing as SessionRecord, created: false, superseded: undefined };
        }
        const old = await tx.selectFrom("aoede_sessions").selectAll().where("owner_id", "=", identity.ownerId)
          .where("state", "in", ["connecting", "active", "closing"]).executeTakeFirst();
        if (old) await tx.updateTable("aoede_sessions").set({ state: "superseded", ended_at: new Date(), answer: null })
          .where("id", "=", old.id).execute();
        const record = await tx.insertInto("aoede_sessions").values({ id: randomUUID(), owner_id: identity.ownerId,
          runtime_id: identity.runtimeId, invocation_id: invocationId, fingerprint, state: "connecting" })
          .returningAll().executeTakeFirstOrThrow();
        return { record: record as SessionRecord, created: true, superseded: old as SessionRecord | undefined };
      });
    },
    async get(id: string) { return await scope(id).executeTakeFirst() as SessionRecord | undefined; },
    async latest() {
      return await db.selectFrom("aoede_sessions").selectAll().where("owner_id", "=", identity.ownerId)
        .orderBy("started_at", "desc").limit(1).executeTakeFirst() as SessionRecord | undefined;
    },
    async update(id: string, values: Partial<Pick<SessionRecord, "state" | "provider_id" | "answer" | "chat_id" | "expires_at" | "ended_at" | "finalization_confirmed">>, expected?: SessionState) {
      let q = db.updateTable("aoede_sessions").set(values).where("owner_id", "=", identity.ownerId).where("id", "=", id);
      if (expected) q = q.where("state", "=", expected);
      return Number((await q.executeTakeFirst()).numUpdatedRows) === 1;
    },
    async checkpoint(id: string, text: AoedeTranscript[], epoch: number) {
      await db.transaction().execute(async (tx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity.ownerId}, 0))`.execute(tx);
        // Only the newest session can replace owner recovery; stale callbacks cannot restore deleted text.
        const latest = await tx.selectFrom("aoede_sessions").select(["id", "checkpoint_epoch"]).where("owner_id", "=", identity.ownerId)
          .orderBy("started_at", "desc").limit(1).forUpdate().executeTakeFirst();
        if (latest?.id !== id || latest.checkpoint_epoch !== epoch) return;
        await tx.updateTable("aoede_sessions").set({ checkpoint: sql`'[]'::jsonb`, checkpoint_until: null })
          .where("owner_id", "=", identity.ownerId).execute();
        await tx.updateTable("aoede_sessions").set({ checkpoint: JSON.stringify(text),
          checkpoint_until: new Date(Date.now() + 86_400_000) }).where("id", "=", id).execute();
      });
    },
    async clearRecovery() {
      return await db.updateTable("aoede_sessions").set({ checkpoint: sql`'[]'::jsonb`, checkpoint_until: null,
        checkpoint_epoch: sql`checkpoint_epoch + 1` })
        .where("owner_id", "=", identity.ownerId).returning(["id", "checkpoint_epoch"]).execute();
    },
    async expireRecovery() {
      await db.updateTable("aoede_sessions").set({ checkpoint: sql`'[]'::jsonb`, checkpoint_until: null })
        .where("owner_id", "=", identity.ownerId).where("checkpoint_until", "<=", new Date()).execute();
    },
    async claim(id: string, delegationId: string) {
      return db.transaction().execute(async (tx) => {
        const row = await tx.selectFrom("aoede_sessions").selectAll().where("owner_id", "=", identity.ownerId)
          .where("id", "=", id).forUpdate().executeTakeFirst();
        if (!row || row.runtime_id !== identity.runtimeId || row.state !== "active") return undefined;
        return await tx.insertInto("aoede_delegations").values({ session_id: id, delegation_id: delegationId,
          request_id: randomUUID(), state: "pending" }).onConflict((oc) => oc.columns(["session_id", "delegation_id"]).doNothing())
          .returningAll().executeTakeFirst() as DelegationRecord | undefined;
      });
    },
    async delegationResult(id: string, delegationId: string, result: Partial<Pick<DelegationRecord, "state" | "chat_id" | "run_id" | "queued_turn_id">>) {
      await db.transaction().execute(async (tx) => {
        if (!await tx.selectFrom("aoede_sessions").select("id").where("owner_id", "=", identity.ownerId)
          .where("id", "=", id).executeTakeFirst()) throw new AoedeConflictError();
        await tx.updateTable("aoede_delegations").set(result).where("session_id", "=", id)
          .where("delegation_id", "=", delegationId).execute();
        if (result.chat_id) await tx.updateTable("aoede_sessions").set({ chat_id: result.chat_id }).where("id", "=", id).execute();
      });
    },
    async delegations(id: string) {
      if (!await scope(id).executeTakeFirst()) return [];
      return await db.selectFrom("aoede_delegations as d").innerJoin("aoede_sessions as s", "s.id", "d.session_id")
        .selectAll("d").where("s.owner_id", "=", identity.ownerId)
        .where((eb) => eb.or([eb("d.session_id", "=", id), eb("d.state", "in", ["pending", "uncertain"])]))
        .limit(128).execute() as DelegationRecord[];
    },
    async beginClose(id: string, state: SessionState) {
      await db.transaction().execute(async (tx) => {
        // Lock session first, as claim does; close and pending-work fencing are one atomic transition.
        const updated = await tx.updateTable("aoede_sessions").set({ state, answer: null }).where("owner_id", "=", identity.ownerId)
          .where("id", "=", id).executeTakeFirst();
        if (Number(updated.numUpdatedRows) !== 1) throw new AoedeConflictError();
        await tx.updateTable("aoede_delegations").set({ state: "uncertain" })
          .where("session_id", "=", id).where("state", "=", "pending").execute();
      });
    },
    async interrupt() {
      return db.transaction().execute(async (tx) => {
        const rows = await tx.updateTable("aoede_sessions").set({ state: "interrupted", answer: null, ended_at: new Date() })
          .where("owner_id", "=", identity.ownerId).where("state", "in", ["connecting", "active", "closing"])
          .returningAll().execute() as SessionRecord[];
        if (rows.length) await tx.updateTable("aoede_delegations").set({ state: "uncertain" })
          .where("session_id", "in", rows.map((r) => r.id)).where("state", "=", "pending").execute();
        return rows;
      });
    },
  };
}
export type AoedeRepository = ReturnType<typeof createAoedeRepository>;
