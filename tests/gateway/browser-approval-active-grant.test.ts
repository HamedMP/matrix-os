import { randomUUID } from "node:crypto";
import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { expect, it } from "vitest";
import { bootstrapBrowserApprovalMetadata } from "../../packages/gateway/src/chat/browser-approval-database.js";
import { BrowserApprovalRepository } from "../../packages/gateway/src/chat/browser-approval-repository.js";
import type { ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import type { BrowserApprovalIdentity, BrowserDecisionTuple } from "@matrix-os/contracts";

it("keeps earlier approved work valid when another pending action receives the same active Chat grant", async () => {
  const pglite = await KyselyPGlite.create();
  const db = new Kysely<ChatDatabase>({ dialect: pglite.dialect });
  const epoch = randomUUID();
  const identity = (approvalId: string): BrowserApprovalIdentity => ({ ownerId: "owner_one", chatId: "chat_one", runId: "run_one",
    approvalId, leaseEpoch: epoch, actionDigest: "a".repeat(64), challengeRevision: 0, scopeVersion: 1 });
  const tuple = (approvalId: string): BrowserDecisionTuple => {
    const { ownerId, ...base } = identity(approvalId);
    return { ...base, handle: "pv-test", runtimeSlot: "pv-test", actorId: ownerId,
      clientRequestId: `req_${approvalId}`, browserDecision: "allow_in_chat" };
  };
  const repository = new BrowserApprovalRepository(db, { boundedConnectionAcquisition: true,
    verifyDecision: async expected => ({ ...expected, version: 1, bodyDigest: "b".repeat(64), nonce: randomUUID().replaceAll("-", ""), expiresAt: Date.now() + 60_000 }),
    verifyRevoke: async () => { throw new Error("Not used"); },
  });
  try {
    await sql`CREATE TABLE chats(id TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT, lifecycle TEXT, collaboration JSONB)`.execute(db);
    await sql`CREATE TABLE chat_runs(id TEXT PRIMARY KEY, chat_id TEXT REFERENCES chats(id), status TEXT)`.execute(db);
    await sql`INSERT INTO chats VALUES('chat_one','personal','owner_one','active',NULL)`.execute(db);
    await sql`INSERT INTO chat_runs VALUES('run_one','chat_one','running')`.execute(db);
    await bootstrapBrowserApprovalMetadata(db);
    await repository.reserve(identity("approval_first"), Date.now() + 60_000);
    await repository.reserve(identity("approval_second"), Date.now() + 60_000);
    const first = await repository.decide(tuple("approval_first"), "verified-fixture");
    const second = await repository.decide(tuple("approval_second"), "verified-fixture");
    expect(second.grant).toMatchObject({ id: first.grant!.id, revision: first.grant!.revision, state: "active" });
    await expect(repository.consume(identity("approval_first"))).resolves.toBeUndefined();
    await expect(repository.consume(identity("approval_second"))).resolves.toBeUndefined();
    await repository.sweep();
    expect(await repository.activeGrant("owner_one", "chat_one")).toMatchObject({ state: "active", id: first.grant!.id });
  } finally { await repository.close(); await db.destroy(); }
});
