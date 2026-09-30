import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import {
  ensureSpeechMonthlyAllowance,
  reconcileSpeechMonthlyAllowances,
} from "../../packages/platform/src/speech/allowance.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const september = new Date("2026-09-28T12:00:00.000Z");
const october = new Date("2026-10-01T00:01:00.000Z");
const identity = { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" } as const;

describe("platform speech monthly allowance", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, {
      machineId: identity.machineId,
      clerkUserId: identity.ownerId,
      handle: "alice",
      runtimeSlot: identity.runtimeSlot,
      provisioningClass: "customer",
      status: "running",
      imageVersion: "v1",
      provisionedAt: september.toISOString(),
      activationState: "authorized",
    });
  });

  afterEach(async () => destroyTestPlatformDb(db));

  async function ensure(at = september) {
    return db.transaction((trx) => ensureSpeechMonthlyAllowance(trx.executor, identity, {
      monthlyBudgetMicrousd: 1_000_000,
      monthlyPromotionalCreditMicrousd: 1_000_000,
      now: at,
    }));
  }

  it("creates one separately identified promotional grant per runtime and UTC month", async () => {
    await ensure();
    await ensure();

    expect(await db.executor.selectFrom("speech_runtime_allowances").selectAll().execute())
      .toMatchObject([{
        machine_id: identity.machineId,
        owner_id: identity.ownerId,
        runtime_slot: identity.runtimeSlot,
        enabled: true,
        monthly_budget_microusd: 1_000_000,
        monthly_promotional_credit_microusd: 1_000_000,
        period_start: "2026-09-01T00:00:00.000Z",
      }]);
    expect(await db.executor.selectFrom("ai_funded_credit_ledger")
      .select(["kind", "amount_microusd", "source_reference", "expires_at"]).execute())
      .toEqual([{
        kind: "promotional_grant",
        amount_microusd: 1_000_000,
        source_reference: "platform-speech-monthly:2026-09",
        expires_at: "2026-10-01T00:00:00.000Z",
      }]);
    expect(await db.executor.selectFrom("ai_funded_runtime_balances")
      .select(["credit_balance_microusd", "promotional_balance_microusd"]).executeTakeFirstOrThrow())
      .toEqual({ credit_balance_microusd: 1_000_000, promotional_balance_microusd: 1_000_000 });
  });

  it("advances the speech period and grants the next month without changing text-model policy", async () => {
    await db.executor.insertInto("ai_funded_runtime_policies").values({
      machine_id: identity.machineId,
      owner_id: identity.ownerId,
      runtime_slot: identity.runtimeSlot,
      enabled: false,
      allowed_model_ids: "[]",
      monthly_budget_microusd: 123,
      expires_at: null,
      next_issue_at: "1970-01-01T00:00:00.000Z",
      revision: 0,
      created_at: september.toISOString(),
      updated_at: september.toISOString(),
    }).execute();
    await ensure(september);
    await ensure(october);

    expect(await db.executor.selectFrom("ai_funded_credit_ledger")
      .select(["kind", "source_reference"]).orderBy("created_at").execute())
      .toEqual([
        { kind: "promotional_grant", source_reference: "platform-speech-monthly:2026-09" },
        {
          kind: "promotional_expiry",
          source_reference: expect.stringMatching(/^speech-monthly:2026-09:/),
        },
        { kind: "promotional_grant", source_reference: "platform-speech-monthly:2026-10" },
      ]);
    expect(await db.executor.selectFrom("ai_funded_runtime_policies")
      .select(["enabled", "monthly_budget_microusd", "revision"]).executeTakeFirstOrThrow())
      .toEqual({ enabled: false, monthly_budget_microusd: 123, revision: 0 });
  });

  it("freezes allowance and grant terms for the active UTC month when operator defaults change", async () => {
    await ensure(september);
    await db.transaction((trx) => ensureSpeechMonthlyAllowance(trx.executor, identity, {
      monthlyBudgetMicrousd: 2_000_000,
      monthlyPromotionalCreditMicrousd: 500_000,
      now: september,
    }));

    expect(await db.executor.selectFrom("speech_runtime_allowances")
      .select(["monthly_budget_microusd", "monthly_promotional_credit_microusd"])
      .executeTakeFirstOrThrow()).toEqual({
      monthly_budget_microusd: 1_000_000,
      monthly_promotional_credit_microusd: 1_000_000,
    });
    expect(await db.executor.selectFrom("ai_funded_credit_ledger")
      .select("amount_microusd").where("kind", "=", "promotional_grant").execute())
      .toEqual([{ amount_microusd: 1_000_000 }]);
  });

  it("reconciles only running authorized customer computers", async () => {
    await insertUserMachine(db, {
      machineId: "machine_second_customer",
      clerkUserId: "user_second_customer",
      handle: "second-customer",
      runtimeSlot: "primary",
      provisioningClass: "customer",
      status: "running",
      imageVersion: "v1",
      provisionedAt: september.toISOString(),
      activationState: "authorized",
    });
    await insertUserMachine(db, {
      machineId: "machine_suspended",
      clerkUserId: "user_suspended",
      handle: "suspended",
      runtimeSlot: "primary",
      provisioningClass: "customer",
      status: "suspended",
      imageVersion: "v1",
      provisionedAt: september.toISOString(),
      activationState: "authorized",
    });
    await insertUserMachine(db, {
      machineId: "machine_preview",
      clerkUserId: "user_preview",
      handle: "pr-123",
      runtimeSlot: "pr-123",
      provisioningClass: "preview",
      status: "running",
      imageVersion: "v1",
      provisionedAt: september.toISOString(),
      activationState: "authorized",
    });

    await expect(reconcileSpeechMonthlyAllowances({
      db,
      monthlyBudgetMicrousd: 1_000_000,
      monthlyPromotionalCreditMicrousd: 1_000_000,
      now: () => september,
      limit: 1,
    })).resolves.toEqual({ eligible: 2, reconciled: 2, failed: 0 });
    expect(await db.executor.selectFrom("speech_runtime_allowances").select("machine_id").execute())
      .toEqual(expect.arrayContaining([
        { machine_id: identity.machineId },
        { machine_id: "machine_second_customer" },
      ]));
  });
});
