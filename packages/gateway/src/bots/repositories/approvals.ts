/**
 * Action approvals (`bot_approvals`). An approval shares its interaction's ID
 * and binds the exact tool, argument hash, account, audience, and policy
 * revision. The person decides once; the run claims an approved action once,
 * and only when every bound field still matches. A changed binding marks the
 * approval `invalidated`, so the run must ask again.
 */
import { sql, type Selectable } from "kysely";
import type { BotApprovalsTable } from "../database.js";
import { BotStateError, isoTimestamp, optionalIsoTimestamp, toSafeInteger, type BotExecutor } from "./shared.js";

const MAX_EXPIRE_BATCH = 200;

export interface BotApprovalRecord {
  approvalId: string;
  ownerId: string;
  botId: string;
  runId: string;
  tool: string;
  argsHash: string;
  account: string;
  audience: string;
  policyRevision: number;
  status: BotApprovalsTable["status"];
  claimedAt: string | null;
  expiresAt: string;
  revision: number;
}

export interface BotApprovalBinding {
  runId: string;
  tool: string;
  argsHash: string;
  account: string;
  audience: string;
  policyRevision: number;
}

function fromRow(row: Selectable<BotApprovalsTable>): BotApprovalRecord {
  return {
    approvalId: row.approval_id,
    ownerId: row.owner_id,
    botId: row.bot_id,
    runId: row.run_id,
    tool: row.tool,
    argsHash: row.args_hash,
    account: row.account,
    audience: row.audience,
    policyRevision: toSafeInteger(row.policy_revision),
    status: row.status,
    claimedAt: optionalIsoTimestamp(row.claimed_at),
    expiresAt: isoTimestamp(row.expires_at),
    revision: toSafeInteger(row.revision),
  };
}

function matches(record: BotApprovalRecord, binding: BotApprovalBinding): boolean {
  return record.runId === binding.runId && record.tool === binding.tool && record.argsHash === binding.argsHash
    && record.account === binding.account && record.audience === binding.audience
    && record.policyRevision === binding.policyRevision;
}

export function createBotApprovalsRepository(db: BotExecutor) {
  async function get(input: { ownerId: string; approvalId: string }, executor: BotExecutor = db): Promise<BotApprovalRecord | undefined> {
    const row = await executor.selectFrom("bot_approvals").selectAll()
      .where("owner_id", "=", input.ownerId).where("approval_id", "=", input.approvalId)
      .executeTakeFirst();
    return row ? fromRow(row) : undefined;
  }

  return {
    get,
    /** Call in the transaction that creates the approval interaction; the IDs are the same. */
    async create(input: BotApprovalBinding & {
      ownerId: string;
      approvalId: string;
      botId: string;
      expiresAt: string;
      now: string;
    }, executor: BotExecutor = db): Promise<BotApprovalRecord> {
      if (!(Date.parse(input.expiresAt) > Date.parse(input.now))) throw new BotStateError("invalid_input");
      const row = await executor.insertInto("bot_approvals").values({
        approval_id: input.approvalId,
        owner_id: input.ownerId,
        bot_id: input.botId,
        run_id: input.runId,
        tool: input.tool,
        args_hash: input.argsHash,
        account: input.account,
        audience: input.audience,
        policy_revision: input.policyRevision,
        status: "pending",
        claimed_at: null,
        expires_at: input.expiresAt,
        created_at: input.now,
        updated_at: input.now,
      }).returningAll().executeTakeFirstOrThrow();
      return fromRow(row);
    },
    /** The person's decision, once, at the approval's revision and before expiry. */
    async decide(input: { ownerId: string; approvalId: string; baseRevision: number; decision: "approved" | "denied"; now: string }, executor: BotExecutor = db): Promise<BotApprovalRecord> {
      const row = await executor.updateTable("bot_approvals")
        .set({ status: input.decision, revision: sql<number>`revision + 1`, updated_at: input.now })
        .where("owner_id", "=", input.ownerId).where("approval_id", "=", input.approvalId)
        .where("status", "=", "pending").where("revision", "=", input.baseRevision).where("expires_at", ">", input.now)
        .returningAll()
        .executeTakeFirst();
      if (row) return fromRow(row);
      const current = await get(input, executor);
      if (!current) throw new BotStateError("not_found");
      throw new BotStateError(current.revision !== input.baseRevision ? "revision_conflict" : "invalid_transition");
    },
    /**
     * Claims an approved action once for dispatch. Every bound field must
     * still match; a mismatch invalidates the approval for good. Refusals are
     * returned, not thrown, so a caller's transaction commits the invalidation.
     */
    async claim(input: BotApprovalBinding & { ownerId: string; approvalId: string; now: string }, executor: BotExecutor = db): Promise<
      | { status: "claimed"; approval: BotApprovalRecord }
      | { status: "refused"; reason: "invalidated" | "not_claimable" }
    > {
      const row = await executor.updateTable("bot_approvals")
        .set({ claimed_at: input.now, revision: sql<number>`revision + 1`, updated_at: input.now })
        .where("owner_id", "=", input.ownerId).where("approval_id", "=", input.approvalId)
        .where("status", "=", "approved").where("claimed_at", "is", null).where("expires_at", ">", input.now)
        .where("run_id", "=", input.runId).where("tool", "=", input.tool).where("args_hash", "=", input.argsHash)
        .where("account", "=", input.account).where("audience", "=", input.audience)
        .where("policy_revision", "=", input.policyRevision)
        .returningAll()
        .executeTakeFirst();
      if (row) return { status: "claimed", approval: fromRow(row) };
      const current = await get(input, executor);
      if (!current) throw new BotStateError("not_found");
      if (current.status === "approved" && current.claimedAt === null && !matches(current, input)) {
        const invalidated = await executor.updateTable("bot_approvals")
          .set({ status: "invalidated", revision: sql<number>`revision + 1`, updated_at: input.now })
          .where("owner_id", "=", input.ownerId).where("approval_id", "=", input.approvalId)
          .where("status", "=", "approved").where("claimed_at", "is", null)
          .returning("approval_id")
          .executeTakeFirst();
        if (invalidated) return { status: "refused", reason: "invalidated" };
      }
      return { status: "refused", reason: current.status === "invalidated" ? "invalidated" : "not_claimable" };
    },
    /** Expires undecided approvals in a bounded batch. */
    async expireDue(input: { now: string; limit?: number }, executor: BotExecutor = db): Promise<string[]> {
      const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? MAX_EXPIRE_BATCH), MAX_EXPIRE_BATCH));
      const rows = await executor.updateTable("bot_approvals")
        .set({ status: "expired", revision: sql<number>`revision + 1`, updated_at: input.now })
        .where("approval_id", "in", (eb) => eb.selectFrom("bot_approvals").select("approval_id")
          .where("status", "in", ["pending", "approved"]).where("claimed_at", "is", null).where("expires_at", "<=", input.now)
          .orderBy("expires_at", "asc").limit(limit))
        .where("claimed_at", "is", null)
        .returning("approval_id")
        .execute();
      return rows.map((row) => row.approval_id);
    },
  };
}

export type BotApprovalsRepository = ReturnType<typeof createBotApprovalsRepository>;
