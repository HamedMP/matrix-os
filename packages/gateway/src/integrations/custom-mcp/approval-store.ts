import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { PlatformDatabase } from "../../platform-db.js";

export interface CustomMcpRunLeasesTable {
  id: string;
  user_id: string;
  actor_id: string;
  run_id: string;
  status: "active" | "revoked";
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface CustomMcpToolApprovalsTable {
  id: string;
  user_id: string;
  actor_id: string;
  run_id: string;
  lease_id: string;
  native_request_id: string;
  server_id: string;
  server_revision: number;
  tool_name: string;
  args_digest: string;
  status: "pending" | "approved" | "denied" | "consumed" | "revoked";
  receipt_hash: string | null;
  expires_at: Date;
  created_at: Date;
  decided_at: Date | null;
  consumed_at: Date | null;
}

export interface CustomMcpApprovalStore {
  registerCustomMcpRunLease(input: {
    userId: string; actorId: string; runId: string; expiresAt: Date;
  }): Promise<{ id: string } | null>;
  reserveCustomMcpToolApproval(input: {
    userId: string; actorId: string; runId: string; nativeRequestId: string;
    serverId: string; serverRevision: number; toolName: string; argsDigest: string;
    expiresAt: Date;
  }): Promise<{ approvalId: string; expiresAt: Date } | null>;
  decideCustomMcpToolApproval(input: {
    userId: string; actorId: string; runId: string; approvalId: string;
    decision: "approve" | "decline" | "cancel";
    validateDecisionProof?: () => boolean;
  }): Promise<{ receipt?: string } | null>;
  consumeCustomMcpToolApproval(input: {
    userId: string; actorId: string; runId: string; serverId: string;
    serverRevision: number; toolName: string; argsDigest: string;
    receipt: string;
  }): Promise<boolean>;
  revokeCustomMcpRunLease(input: {
    userId: string; actorId: string; runId: string;
  }): Promise<boolean>;
  sweepCustomMcpApprovals(now: Date): Promise<number>;
}

const MAX_ACTIVE_LEASES_PER_OWNER = 128;
const MAX_PENDING_PER_RUN = 16;
const MAX_RUN_TTL_MS = 35 * 60_000;
const MAX_APPROVAL_TTL_MS = 10 * 60_000;
const RETAIN_TERMINAL_MS = 24 * 60 * 60_000;
const MAX_SWEEP_ROWS = 100;
const HEX_64 = /^[a-f0-9]{64}$/;

function receiptHash(receipt: string): string {
  return createHash("sha256").update(`matrix-custom-mcp-receipt:v1\0${receipt}`).digest("hex");
}

function validIdentity(actorId: string, runId: string): boolean {
  return actorId.length > 0 && actorId.length <= 256 && runId.length > 0 && runId.length <= 256;
}

function isCurrentServerPolicy(row: PlatformDatabase["custom_mcp_servers"] | undefined, input: {
  serverRevision: number; toolName: string;
}): boolean {
  if (!row || !row.enabled || row.status !== "ready" || row.revision !== input.serverRevision) return false;
  const tool = row.enforcement_projection.find((candidate) => candidate.name === input.toolName);
  return Boolean(tool?.enabled && tool.approval === "always_ask");
}

export function createCustomMcpApprovalStore(
  db: Kysely<PlatformDatabase>,
  now: () => Date = () => new Date(),
): CustomMcpApprovalStore {
  return {
    async registerCustomMcpRunLease(input) {
      if (!validIdentity(input.actorId, input.runId)) return null;
      return db.transaction().execute(async (trx) => {
        // Serialize registrations for distinct Run IDs before the owner cap.
        const owner = await trx.selectFrom("users").select("id")
          .where("id", "=", input.userId).forUpdate().executeTakeFirst();
        if (!owner) return null;
        const current = now();
        if (input.expiresAt <= current) return null;
        const existing = await trx.selectFrom("custom_mcp_run_leases")
          .selectAll().where("user_id", "=", input.userId)
          .where("run_id", "=", input.runId).forUpdate().executeTakeFirst();
        if (existing) return existing.status === "active"
          && existing.actor_id === input.actorId && existing.expires_at > current
          ? { id: existing.id } : null;
        const count = await trx.selectFrom("custom_mcp_run_leases")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("user_id", "=", input.userId)
          .where("status", "=", "active")
          .where("expires_at", ">", current).executeTakeFirstOrThrow();
        if (Number(count.count) >= MAX_ACTIVE_LEASES_PER_OWNER) return null;
        if (input.expiresAt <= now()) return null;
        const id = randomUUID();
        await trx.insertInto("custom_mcp_run_leases").values({
          id, user_id: input.userId, actor_id: input.actorId, run_id: input.runId,
          status: "active", expires_at: new Date(Math.min(input.expiresAt.getTime(), current.getTime() + MAX_RUN_TTL_MS)),
          created_at: current, updated_at: current,
        }).onConflict((conflict) => conflict.columns(["user_id", "run_id"]).doNothing()).execute();
        return { id };
      });
    },

    async reserveCustomMcpToolApproval(input) {
      if (!validIdentity(input.actorId, input.runId) || !input.nativeRequestId
        || input.nativeRequestId.length > 256 || !HEX_64.test(input.argsDigest)) return null;
      return db.transaction().execute(async (trx) => {
        const lease = await trx.selectFrom("custom_mcp_run_leases")
          .selectAll().where("user_id", "=", input.userId)
          .where("run_id", "=", input.runId).forUpdate().executeTakeFirst();
        const current = now();
        if (!lease || lease.status !== "active" || lease.actor_id !== input.actorId
          || lease.expires_at <= current || input.expiresAt <= current) return null;
        const server = await trx.selectFrom("custom_mcp_servers")
          .selectAll().where("id", "=", input.serverId)
          .where("user_id", "=", input.userId).forUpdate().executeTakeFirst();
        if (!isCurrentServerPolicy(server, input)) return null;
        const existing = await trx.selectFrom("custom_mcp_tool_approvals")
          .selectAll().where("lease_id", "=", lease.id)
          .where("native_request_id", "=", input.nativeRequestId).executeTakeFirst();
        if (existing) return existing.status === "pending" && existing.expires_at > now()
          && lease.expires_at > now()
          && existing.server_id === input.serverId
          && existing.server_revision === input.serverRevision
          && existing.tool_name === input.toolName && existing.args_digest === input.argsDigest
          ? { approvalId: existing.id, expiresAt: existing.expires_at } : null;
        const count = await trx.selectFrom("custom_mcp_tool_approvals")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("lease_id", "=", lease.id)
          .where("status", "in", ["pending", "approved"])
          .where("expires_at", ">", current).executeTakeFirstOrThrow();
        if (Number(count.count) >= MAX_PENDING_PER_RUN) return null;
        const admissionTime = now();
        if (lease.expires_at <= admissionTime || input.expiresAt <= admissionTime) return null;
        const expiresAt = new Date(Math.min(input.expiresAt.getTime(), lease.expires_at.getTime(),
          admissionTime.getTime() + MAX_APPROVAL_TTL_MS));
        const id = randomUUID();
        await trx.insertInto("custom_mcp_tool_approvals").values({
          id, user_id: input.userId, actor_id: input.actorId, run_id: input.runId,
          lease_id: lease.id, native_request_id: input.nativeRequestId,
          server_id: input.serverId, server_revision: input.serverRevision,
          tool_name: input.toolName, args_digest: input.argsDigest,
          status: "pending", receipt_hash: null, expires_at: expiresAt,
          created_at: admissionTime, decided_at: null, consumed_at: null,
        }).onConflict((conflict) => conflict.columns(["lease_id", "native_request_id"]).doNothing()).execute();
        return { approvalId: id, expiresAt };
      });
    },

    async decideCustomMcpToolApproval(input) {
      if (!validIdentity(input.actorId, input.runId)) return null;
      return db.transaction().execute(async (trx) => {
        const lease = await trx.selectFrom("custom_mcp_run_leases")
          .selectAll().where("user_id", "=", input.userId)
          .where("run_id", "=", input.runId).forUpdate().executeTakeFirst();
        const current = now();
        if (!lease || lease.status !== "active" || lease.actor_id !== input.actorId
          || lease.expires_at <= current) return null;
        const approval = await trx.selectFrom("custom_mcp_tool_approvals")
          .selectAll().where("id", "=", input.approvalId)
          .where("user_id", "=", input.userId).forUpdate().executeTakeFirst();
        if (!approval || approval.lease_id !== lease.id || approval.actor_id !== input.actorId
          || approval.run_id !== input.runId) return null;
        if (input.decision === "cancel") {
          const cancelTime = now();
          if (lease.expires_at <= cancelTime || approval.expires_at <= cancelTime
            || (input.validateDecisionProof && !input.validateDecisionProof())) return null;
          const cancelled = await trx.updateTable("custom_mcp_tool_approvals")
            .set({ status: "revoked", receipt_hash: null,
              decided_at: approval.decided_at ?? cancelTime })
            .where("id", "=", approval.id).where("status", "in", ["pending", "approved"])
            .returning("id").executeTakeFirst();
          return cancelled ? {} : null;
        }
        if (approval.status !== "pending" || approval.expires_at <= current) return null;
        const server = await trx.selectFrom("custom_mcp_servers")
          .selectAll().where("id", "=", approval.server_id)
          .where("user_id", "=", input.userId).forUpdate().executeTakeFirst();
        if (!isCurrentServerPolicy(server, {
          serverRevision: approval.server_revision, toolName: approval.tool_name,
        })) return null;
        const decisionTime = now();
        if (lease.expires_at <= decisionTime || approval.expires_at <= decisionTime
          || (input.validateDecisionProof && !input.validateDecisionProof())) return null;
        const receipt = input.decision === "approve" ? randomBytes(32).toString("hex") : undefined;
        const result = await trx.updateTable("custom_mcp_tool_approvals")
          .set({ status: receipt ? "approved" : "denied",
            receipt_hash: receipt ? receiptHash(receipt) : null, decided_at: decisionTime })
          .where("id", "=", approval.id).where("status", "=", "pending")
          .returning("id")
          .executeTakeFirst();
        return result ? (receipt ? { receipt } : {}) : null;
      });
    },

    async consumeCustomMcpToolApproval(input) {
      if (!validIdentity(input.actorId, input.runId) || !HEX_64.test(input.receipt)
        || !HEX_64.test(input.argsDigest)) return false;
      return db.transaction().execute(async (trx) => {
        const candidate = await trx.selectFrom("custom_mcp_tool_approvals")
          .select(["id", "lease_id"]).where("receipt_hash", "=", receiptHash(input.receipt))
          .where("user_id", "=", input.userId).executeTakeFirst();
        if (!candidate) return false;
        const lease = await trx.selectFrom("custom_mcp_run_leases")
          .selectAll().where("id", "=", candidate.lease_id)
          .where("user_id", "=", input.userId).forUpdate().executeTakeFirst();
        const current = now();
        if (!lease || lease.status !== "active" || lease.actor_id !== input.actorId
          || lease.run_id !== input.runId || lease.expires_at <= current) return false;
        const approval = await trx.selectFrom("custom_mcp_tool_approvals")
          .selectAll().where("id", "=", candidate.id).forUpdate().executeTakeFirst();
        if (!approval || approval.status !== "approved" || approval.expires_at <= current
          || approval.actor_id !== input.actorId || approval.run_id !== input.runId
          || approval.lease_id !== lease.id || approval.server_id !== input.serverId
          || approval.server_revision !== input.serverRevision
          || approval.tool_name !== input.toolName || approval.args_digest !== input.argsDigest) return false;
        const server = await trx.selectFrom("custom_mcp_servers")
          .selectAll().where("id", "=", input.serverId)
          .where("user_id", "=", input.userId).forUpdate().executeTakeFirst();
        if (!isCurrentServerPolicy(server, input)) return false;
        const consumeTime = now();
        if (lease.expires_at <= consumeTime || approval.expires_at <= consumeTime) return false;
        const result = await trx.updateTable("custom_mcp_tool_approvals")
          .set({ status: "consumed", consumed_at: consumeTime })
          .where("id", "=", approval.id).where("status", "=", "approved")
          .where("expires_at", ">", consumeTime).returning("id").executeTakeFirst();
        return Boolean(result);
      });
    },

    async revokeCustomMcpRunLease(input) {
      if (!validIdentity(input.actorId, input.runId)) return false;
      return db.transaction().execute(async (trx) => {
        const lease = await trx.selectFrom("custom_mcp_run_leases")
          .selectAll().where("user_id", "=", input.userId)
          .where("run_id", "=", input.runId).forUpdate().executeTakeFirst();
        const current = now();
        if (!lease || lease.actor_id !== input.actorId) return false;
        if (lease.status === "active") {
          await trx.updateTable("custom_mcp_run_leases")
            .set({ status: "revoked", updated_at: current })
            .where("id", "=", lease.id).where("status", "=", "active").execute();
          await trx.updateTable("custom_mcp_tool_approvals")
            .set({ status: "revoked" }).where("lease_id", "=", lease.id)
            .where("status", "in", ["pending", "approved"]).execute();
        }
        return true;
      });
    },

    async sweepCustomMcpApprovals(now) {
      // Each statement is bounded by an indexed 100-row candidate selection.
      const retentionCutoff = new Date(now.getTime() - RETAIN_TERMINAL_MS);
      const approvals = await db.deleteFrom("custom_mcp_tool_approvals")
        .where("id", "in", (eb) => eb.selectFrom("custom_mcp_tool_approvals")
          .select("id").where("expires_at", "<", retentionCutoff)
          .orderBy("expires_at").limit(MAX_SWEEP_ROWS).forUpdate().skipLocked())
        .returning("id").execute();
      const leases = await db.deleteFrom("custom_mcp_run_leases")
        .where("id", "in", (eb) => eb.selectFrom("custom_mcp_run_leases")
          .select("id").where("expires_at", "<", now)
          .where("id", "not in", (sub) => sub.selectFrom("custom_mcp_tool_approvals")
            .select("lease_id"))
          .orderBy("expires_at").limit(MAX_SWEEP_ROWS).forUpdate().skipLocked())
        .returning("id").execute();
      return approvals.length + leases.length;
    },
  };
}
