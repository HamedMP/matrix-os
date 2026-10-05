import { sql } from "kysely";
import { z } from "zod/v4";
import type { PlatformDB } from "../db.js";
import { NATIVE_LIVE_MODEL, usageUpperBound, type NativeLivePolicy } from "./policy.js";

const SessionId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export class NativeLiveFundingError extends Error {
  constructor() { super("Live is unavailable"); this.name = "NativeLiveFundingError"; }
}
export function createNativeLiveFunding(options: { db: PlatformDB; policy: NativeLivePolicy; now?: () => Date }) {
  const now = options.now ?? (() => new Date());
  const period = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
  const identity = async (handle: string) => {
    if (!options.policy.allowedHandles.includes(handle)) throw new NativeLiveFundingError();
    const machine = await options.db.executor.selectFrom("user_machines").select([
      "machine_id", "clerk_user_id", "runtime_slot", "status", "activation_state", "deleted_at",
    ]).where("handle", "=", handle).where("deleted_at", "is", null).executeTakeFirst();
    if (!machine || machine.status !== "running" || machine.activation_state !== "authorized") throw new NativeLiveFundingError();
    return { ownerId: machine.clerk_user_id, machineId: machine.machine_id, runtimeSlot: machine.runtime_slot };
  };
  return {
    identity,
    async available(handle: string) {
      const owner = await identity(handle);
      const spent = await options.db.executor.selectFrom("native_live_sessions")
        .select(sql<string>`COALESCE(SUM(accounted_microusd), 0)`.as("total"))
        .where("owner_id", "=", owner.ownerId).where("period_start", "=", period(now())).executeTakeFirstOrThrow();
      return Number(spent.total) + options.policy.sessionBudgetMicrousd <= options.policy.monthlyOwnerBudgetMicrousd;
    },
    async reserve(handle: string, rawSessionId: string) {
      const sessionId = SessionId.parse(rawSessionId);
      const expected = await identity(handle);
      return options.db.executor.transaction().execute(async trx => {
        // One platform-wide admission lock serializes owner and global caps;
        // all related writes stay in this transaction across replica processes.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('matrix-native-live-admission', 0))`.execute(trx);
        const at = now(), checkedAt = at.toISOString();
        const machine = await trx.selectFrom("user_machines").select(["clerk_user_id", "runtime_slot", "status", "activation_state", "deleted_at"])
          .where("machine_id", "=", expected.machineId).forUpdate().executeTakeFirst();
        if (!machine || machine.clerk_user_id !== expected.ownerId || machine.runtime_slot !== expected.runtimeSlot
          || machine.status !== "running" || machine.activation_state !== "authorized" || machine.deleted_at !== null) throw new NativeLiveFundingError();
        await trx.updateTable("native_live_sessions").set({ status: "closed", closed_at: checkedAt })
          .where("status", "=", "active").where("expires_at", "<=", checkedAt).execute();
        const active = await trx.selectFrom("native_live_sessions").select("owner_id").where("status", "=", "active").limit(options.policy.maximumActiveSessions).execute();
        if (active.length >= options.policy.maximumActiveSessions || active.some(s => s.owner_id === expected.ownerId)) throw new NativeLiveFundingError();
        const spent = await trx.selectFrom("native_live_sessions")
          .select(sql<string>`COALESCE(SUM(accounted_microusd), 0)`.as("total"))
          .where("owner_id", "=", expected.ownerId).where("period_start", "=", period(at)).executeTakeFirstOrThrow();
        if (Number(spent.total) + options.policy.sessionBudgetMicrousd > options.policy.monthlyOwnerBudgetMicrousd) throw new NativeLiveFundingError();
        const expiresAt = new Date(at.getTime() + options.policy.maximumSessionMs).toISOString();
        const saved = await trx.insertInto("native_live_sessions").values({ session_id: sessionId, owner_id: expected.ownerId,
          machine_id: expected.machineId, runtime_slot: expected.runtimeSlot, model_id: NATIVE_LIVE_MODEL, policy_revision: options.policy.revision,
          period_start: period(at), status: "active", accounting_mode: "conservative", reserved_microusd: options.policy.sessionBudgetMicrousd,
          reported_upper_microusd: 0, accounted_microusd: options.policy.sessionBudgetMicrousd,
          platform_absorbed_overrun_microusd: 0, usage_events: 0, created_at: checkedAt, expires_at: expiresAt, closed_at: null,
        }).onConflict(c => c.column("session_id").doNothing()).returning("session_id").executeTakeFirst();
        // Socket ids are fresh random identities: replay cannot dispatch again.
        if (!saved) throw new NativeLiveFundingError();
        return { ...expected, sessionId, reservedMicrousd: options.policy.sessionBudgetMicrousd, expiresAt };
      });
    },
    async recordUsage(rawSessionId: string, usage: unknown) {
      const sessionId = SessionId.parse(rawSessionId), amount = usageUpperBound(usage);
      return options.db.executor.transaction().execute(async trx => {
        const row = await trx.selectFrom("native_live_sessions").selectAll().where("session_id", "=", sessionId).forUpdate().executeTakeFirst();
        if (!row || row.status !== "active") return false;
        const upper = Number(row.reported_upper_microusd) + amount;
        if (!Number.isSafeInteger(upper)) throw new NativeLiveFundingError();
        await trx.updateTable("native_live_sessions").set({ reported_upper_microusd: upper,
          accounted_microusd: Math.max(Number(row.reserved_microusd), upper),
          platform_absorbed_overrun_microusd: Math.max(0, upper - Number(row.reserved_microusd)), usage_events: Number(row.usage_events) + 1,
        }).where("session_id", "=", sessionId).where("status", "=", "active").executeTakeFirstOrThrow();
        return upper < Number(row.reserved_microusd) && Date.parse(row.expires_at) > now().getTime();
      });
    },
    async finish(rawSessionId: string) {
      await options.db.executor.updateTable("native_live_sessions").set({ status: "closed", closed_at: now().toISOString() })
        .where("session_id", "=", SessionId.parse(rawSessionId)).where("status", "=", "active").execute();
    },
  };
}
