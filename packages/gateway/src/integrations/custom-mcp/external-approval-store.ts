/**
 * External-client write approvals for Matrix Core MCP (spec 2691, layer 4).
 *
 * An external `/mcp` client holds no Matrix-issued receipt and can never
 * approve its own call. Its pending approval lives on a synthetic run lease
 * (`ext.<client>.<window>`) in the same tables, digest, single-use, and
 * 10-minute TTL as Chat approvals. Only the owner's Matrix session decides it,
 * and only the same owner + client lease can consume it, exactly once.
 */
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { PlatformDatabase } from "../../platform-db.js";
import { isCurrentServerPolicy } from "./approval-store.js";

export const EXTERNAL_RUN_PREFIX = "ext.";
/** Lease windows rotate so an expired lease never blocks a client (leases are not reusable). */
export const EXTERNAL_RUN_WINDOW_MS = 20 * 60_000;
/** Lease outlives its window by more than one approval TTL, so a late approval keeps 10 minutes. */
export const EXTERNAL_LEASE_GRACE_MS = 15 * 60_000;
const MAX_PENDING_LIST = 50;
const HEX_64 = /^[a-f0-9]{64}$/;

/** A stable, non-reversible key for one OAuth client of one owner. */
export function externalClientKey(userId: string, clientId: string): string {
  return createHash("sha256").update(`matrix-core-mcp-external-client:v1\0${userId}\0${clientId}`).digest("hex").slice(0, 32);
}

/** Current window first, then the previous one (an approval outlives at most one rotation). */
export function externalRunIds(clientKey: string, now: number): [string, string] {
  if (!/^[a-f0-9]{32}$/.test(clientKey)) throw new Error("Invalid external client key");
  const window = Math.floor(now / EXTERNAL_RUN_WINDOW_MS);
  return [`${EXTERNAL_RUN_PREFIX}${clientKey}.${window}`, `${EXTERNAL_RUN_PREFIX}${clientKey}.${window - 1}`];
}

export function externalLeaseExpiry(now: number): Date {
  return new Date((Math.floor(now / EXTERNAL_RUN_WINDOW_MS) + 1) * EXTERNAL_RUN_WINDOW_MS + EXTERNAL_LEASE_GRACE_MS);
}

export interface PendingExternalApproval {
  approvalId: string; serverId: string; toolName: string; createdAt: Date; expiresAt: Date;
}

export interface CustomMcpExternalApprovalStore {
  /** Owner-session decision only; refuses Chat-run approvals, which need a signed Chat proof. */
  decideExternalCustomMcpToolApproval(input: {
    userId: string; approvalId: string; decision: "approve" | "decline";
  }): Promise<{ status: "approved" | "denied" } | null>;
  /** Single-use consumption bound to owner + client lease + server revision + tool + argument digest. */
  consumeExternalCustomMcpToolApproval(input: {
    userId: string; actorId: string; runId: string; approvalId: string; serverId: string;
    serverRevision: number; toolName: string; argsDigest: string;
  }): Promise<boolean>;
  listPendingExternalCustomMcpToolApprovals(userId: string): Promise<PendingExternalApproval[]>;
}

const isExternalRun = (runId: string) => runId.startsWith(EXTERNAL_RUN_PREFIX);

export function createCustomMcpExternalApprovalStore(
  db: Kysely<PlatformDatabase>,
  now: () => Date = () => new Date(),
): CustomMcpExternalApprovalStore {
  return {
    async decideExternalCustomMcpToolApproval(input) {
      return db.transaction().execute(async (trx) => {
        const candidate = await trx.selectFrom("custom_mcp_tool_approvals").select(["lease_id", "run_id"])
          .where("id", "=", input.approvalId).where("user_id", "=", input.userId).executeTakeFirst();
        if (!candidate || !isExternalRun(candidate.run_id)) return null;
        // Lease first, then approval: the same lock order as the Chat decision path.
        const lease = await trx.selectFrom("custom_mcp_run_leases").selectAll()
          .where("id", "=", candidate.lease_id).where("user_id", "=", input.userId).forUpdate().executeTakeFirst();
        const approval = await trx.selectFrom("custom_mcp_tool_approvals").selectAll()
          .where("id", "=", input.approvalId).where("user_id", "=", input.userId).forUpdate().executeTakeFirst();
        const current = now();
        if (!lease || !approval || lease.status !== "active" || lease.expires_at <= current
          || approval.lease_id !== lease.id || approval.lease_generation !== lease.generation
          || approval.status !== "pending" || approval.expires_at <= current) return null;
        const server = await trx.selectFrom("custom_mcp_servers").selectAll()
          .where("id", "=", approval.server_id).where("user_id", "=", input.userId).forUpdate().executeTakeFirst();
        if (!isCurrentServerPolicy(server, { serverRevision: approval.server_revision, toolName: approval.tool_name })) return null;
        const status = input.decision === "approve" ? "approved" as const : "denied" as const;
        const updated = await trx.updateTable("custom_mcp_tool_approvals")
          .set({ status, receipt_hash: null, decided_at: current })
          .where("id", "=", approval.id).where("status", "=", "pending").where("expires_at", ">", current)
          .returning("id").executeTakeFirst();
        return updated ? { status } : null;
      });
    },

    async consumeExternalCustomMcpToolApproval(input) {
      if (!isExternalRun(input.runId) || input.runId.length > 256 || !input.actorId
        || input.actorId.length > 256 || !HEX_64.test(input.argsDigest)) return false;
      return db.transaction().execute(async (trx) => {
        const lease = await trx.selectFrom("custom_mcp_run_leases").selectAll()
          .where("user_id", "=", input.userId).where("run_id", "=", input.runId).forUpdate().executeTakeFirst();
        const current = now();
        if (!lease || lease.status !== "active" || lease.actor_id !== input.actorId || lease.expires_at <= current) return false;
        const approval = await trx.selectFrom("custom_mcp_tool_approvals").selectAll()
          .where("id", "=", input.approvalId).where("user_id", "=", input.userId).forUpdate().executeTakeFirst();
        if (!approval || approval.status !== "approved" || approval.expires_at <= current
          || approval.lease_id !== lease.id || approval.lease_generation !== lease.generation
          || approval.actor_id !== input.actorId || approval.run_id !== input.runId
          || approval.server_id !== input.serverId || approval.server_revision !== input.serverRevision
          || approval.tool_name !== input.toolName || approval.args_digest !== input.argsDigest) return false;
        const server = await trx.selectFrom("custom_mcp_servers").selectAll()
          .where("id", "=", input.serverId).where("user_id", "=", input.userId).forUpdate().executeTakeFirst();
        if (!isCurrentServerPolicy(server, input)) return false;
        const consumed = await trx.updateTable("custom_mcp_tool_approvals")
          .set({ status: "consumed", consumed_at: current })
          .where("id", "=", approval.id).where("status", "=", "approved").where("expires_at", ">", current)
          .returning("id").executeTakeFirst();
        return Boolean(consumed);
      });
    },

    async listPendingExternalCustomMcpToolApprovals(userId) {
      const rows = await db.selectFrom("custom_mcp_tool_approvals")
        .select(["id", "server_id", "tool_name", "created_at", "expires_at"])
        .where("user_id", "=", userId).where("status", "=", "pending")
        .where("run_id", "like", `${EXTERNAL_RUN_PREFIX}%`).where("expires_at", ">", now())
        .orderBy("created_at", "desc").limit(MAX_PENDING_LIST).execute();
      return rows.map(row => ({ approvalId: row.id, serverId: row.server_id, toolName: row.tool_name,
        createdAt: row.created_at, expiresAt: row.expires_at }));
    },
  };
}
