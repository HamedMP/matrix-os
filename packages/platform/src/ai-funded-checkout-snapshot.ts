import { sql } from "kysely";
import type { PlatformDB } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import { exactInteger, fundingSummary, intersectModels, parseModels, utcMonthStart } from "./ai-funded-metering-helpers.js";

type CheckoutRow = {
  clerk_user_id: string; machine_runtime_slot: string; status: string; activation_state: string; deleted_at: string | null;
  owner_id: string; policy_runtime_slot: string; runtime_enabled: boolean; runtime_allowed_model_ids: string;
  monthly_budget_microusd: unknown; expires_at: string | null; runtime_revision: number;
  global_enabled: boolean; global_allowed_model_ids: string; global_revision: number;
  credit_balance_microusd: unknown; promotional_balance_microusd: unknown; addon_balance_microusd: unknown;
  reserved_microusd: unknown; funding_shortfall_microusd: unknown; month_period_start: string;
  month_spent_microusd: unknown; month_reserved_microusd: unknown;
  restriction_debt_microusd: unknown | null; restriction_frozen: boolean | null;
};

/** Checkout reads current owner/policy/budget without admission's balancing
 * writes or row lock. A DB-side statement deadline bounds the single query. */
export async function readCheckoutFundingSnapshot(input: {
  db: PlatformDB;
  identity: { ownerId: string; machineId: string; runtimeSlot: string };
  checked: Date;
  policyFreshnessMs: number;
  deadlineAtMs: number;
}) {
  const { db, identity, checked, deadlineAtMs } = input;
  const checkedAt = checked.toISOString();
  const currentPeriod = utcMonthStart(checked);
  await db.ready;
  if (Date.now() >= deadlineAtMs) throw new Error("Checkout funding read timed out");
  return db.transaction(async (trx) => {
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) throw new Error("Checkout funding read timed out");
    await sql`select set_config('statement_timeout', ${`${remainingMs}ms`}, true)`.execute(trx.executor);
    if (Date.now() >= deadlineAtMs) throw new Error("Checkout funding read timed out");
    const result = await sql<CheckoutRow>`
      select machine.clerk_user_id, machine.runtime_slot as machine_runtime_slot,
        machine.status, machine.activation_state, machine.deleted_at,
        runtime.owner_id, runtime.runtime_slot as policy_runtime_slot,
        runtime.enabled as runtime_enabled, runtime.allowed_model_ids as runtime_allowed_model_ids,
        runtime.monthly_budget_microusd, runtime.expires_at, runtime.revision as runtime_revision,
        global.enabled as global_enabled, global.allowed_model_ids as global_allowed_model_ids,
        global.revision as global_revision,
        balance.credit_balance_microusd, balance.promotional_balance_microusd,
        balance.addon_balance_microusd, balance.reserved_microusd, balance.funding_shortfall_microusd,
        balance.month_period_start, balance.month_spent_microusd, balance.month_reserved_microusd,
        restriction.debt_microusd as restriction_debt_microusd,
        restriction.frozen as restriction_frozen
      from user_machines as machine
      join ai_funded_runtime_policies as runtime on runtime.machine_id = machine.machine_id
      join ai_funded_runtime_balances as balance on balance.machine_id = runtime.machine_id
        and balance.owner_id = runtime.owner_id and balance.runtime_slot = runtime.runtime_slot
      left join ai_funded_credit_restrictions as restriction on restriction.machine_id = runtime.machine_id
        and restriction.owner_id = runtime.owner_id and restriction.runtime_slot = runtime.runtime_slot
      join ai_funded_global_policy as global on global.policy_id = 'default'
      where machine.machine_id = ${identity.machineId}
    `.execute(trx.executor);
    const row = result.rows[0];
      if (!row || row.clerk_user_id !== identity.ownerId || row.machine_runtime_slot !== identity.runtimeSlot
      || row.status !== "running" || row.activation_state !== "authorized" || row.deleted_at !== null
      || row.owner_id !== identity.ownerId || row.policy_runtime_slot !== identity.runtimeSlot) {
        throw new AiFundedPolicyError("identity_mismatch");
      }
      if (row.restriction_frozen === true || exactInteger(row.restriction_debt_microusd ?? 0) > 0) {
        throw new AiFundedPolicyError("access_disabled");
      }
    const monthlyBudgetMicrousd = exactInteger(row.monthly_budget_microusd);
    const enabled = row.global_enabled && row.runtime_enabled
      && (row.expires_at === null || Date.parse(row.expires_at) > checked.getTime());
    const allowedModelIds = enabled
      ? intersectModels(parseModels(row.global_allowed_model_ids), parseModels(row.runtime_allowed_model_ids))
      : [];
    const balance = row.month_period_start === currentPeriod ? row : {
      ...row, month_period_start: currentPeriod, month_spent_microusd: 0, month_reserved_microusd: 0,
    };
    return {
      funding: fundingSummary(balance, monthlyBudgetMicrousd, checkedAt),
      policy: {
        enabled: enabled && allowedModelIds.length > 0,
        globalRevision: row.global_revision,
        runtimeRevision: row.runtime_revision,
        allowedModelIds,
        monthlyBudgetMicrousd,
        checkedAt,
        staleAfter: new Date(checked.getTime() + input.policyFreshnessMs).toISOString(),
      },
    };
  });
}
