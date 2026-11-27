import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { PlatformDB } from "./db.js";
import type { ManagedTerminalOwnerProof } from "./managed-terminal-owner-proof.js";

type Source = Pick<ManagedTerminalOwnerProof, "ownerId" | "sourceMachineId" | "sourceRuntimeSlot" | "sourceEpoch">;
type Grant = Pick<ManagedTerminalOwnerProof, "chatId" | "clientRequestId" | "workspaceId" | "tabId" | "revision"
  | "worktreeId" | "activateBefore" | "expiresAt" | "nonce" | "bodyDigest"> & Source & { runId: string };

const REVOKE_TTL_MS = 15 * 60_000;
const RETAIN_EXPIRED_MS = 15 * 60_000;
const SWEEP_BATCH_SIZE = 512;

function digest(domain: string, fields: readonly unknown[]) {
  return createHash("sha256").update(JSON.stringify(["matrix-terminal-control", domain, ...fields])).digest("hex");
}

function sourceTuple(input: Source, chatId: string) {
  return [input.ownerId, input.sourceMachineId, input.sourceRuntimeSlot, input.sourceEpoch, chatId] as const;
}

export function createManagedTerminalGrantClaims(db: PlatformDB, now = Date.now) {
  return {
    async claim(input: Grant): Promise<boolean> {
      const clock = now();
      if (input.expiresAt <= clock) return false;
      await db.ready;
      const source = sourceTuple(input, input.chatId);
      // Same browser turn can be signed twice during a client retry. The signed
      // request identity prevents either proof from starting a second run.
      const turnHash = digest("claimed-turn", [...source, input.clientRequestId]);
      const runHash = digest("run", [...source, input.runId]);
      const nonceHash = digest("nonce", [input.nonce]);
      const selectionHash = digest("selection", [input.worktreeId, input.workspaceId, input.tabId, input.revision, input.bodyDigest]);
      if (now() < input.activateBefore) {
        await sql`
          INSERT INTO managed_terminal_grant_claims (turn_hash, run_hash, nonce_hash, selection_hash, expires_at)
          SELECT ${turnHash}, ${runHash}, ${nonceHash}, ${selectionHash}, ${new Date(input.expiresAt).toISOString()}
          WHERE clock_timestamp() < ${new Date(input.activateBefore).toISOString()}::timestamptz
          ON CONFLICT DO NOTHING
        `.execute(db.executor);
      }
      const row = await db.executor.selectFrom("managed_terminal_grant_claims").select("expires_at")
        .where("turn_hash", "=", turnHash).where("run_hash", "=", runHash)
        .where("selection_hash", "=", selectionHash).where("revoked_at", "is", null).executeTakeFirst();
      return Boolean(row && Date.parse(row.expires_at) > now() && input.expiresAt > now());
    },
    async revoke(source: Source, chatId: string, runId: string): Promise<void> {
      await db.ready;
      const runHash = digest("run", [...sourceTuple(source, chatId), runId]);
      const timestamp = now();
      const revokedAt = new Date(timestamp).toISOString();
      // A Stop can race the first tool action. A tombstone uses the same unique
      // run key so it can block a grant even before that action attempts a claim.
      await db.executor.insertInto("managed_terminal_grant_claims").values({
        turn_hash: digest("revoked-before-claim", [runHash]), run_hash: runHash, nonce_hash: null, selection_hash: null,
        expires_at: new Date(timestamp + REVOKE_TTL_MS).toISOString(), revoked_at: revokedAt,
      }).onConflict(conflict => conflict.column("run_hash").doUpdateSet({ revoked_at: revokedAt })).execute();
    },
    async sweep(): Promise<void> {
      await db.ready;
      const cutoff = new Date(now() - RETAIN_EXPIRED_MS).toISOString();
      await db.executor.deleteFrom("managed_terminal_grant_claims").where("turn_hash", "in", query =>
        query.selectFrom("managed_terminal_grant_claims").select("turn_hash")
          .where("expires_at", "<=", cutoff).orderBy("expires_at").limit(SWEEP_BATCH_SIZE)).execute();
    },
  };
}
