import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectedPreviewPair } from "./preview-pair-projected-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { initializePreviewRuntimeAccess, loadPreviewRuntimeAccessConfig } from "../../packages/platform/src/preview-runtime-access.js";
import { createPreviewPairFundingReader } from "../../packages/platform/src/preview-pair/funding.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("preview pair current funding (real Postgres)", () => {
  let f: Awaited<ReturnType<typeof createProjectedPreviewPair>>;
  beforeEach(async () => { f = await createProjectedPreviewPair(); }, 30_000);
  afterEach(async () => { await f?.destroy(); });
  async function setup() {
    let clock = PAIR_NOW;
    const now = () => new Date(clock), target = f.source.db;
    await target.executor.updateTable("ai_funded_global_policy").set({ enabled: true,
      allowed_model_ids: JSON.stringify(["anthropic/claude-sonnet-5"]), revision: 1, updated_at: now().toISOString(),
    }).where("policy_id", "=", "default").execute();
    const repository = createAiFundedPolicyRepository({ db: target, credentialHashSecret: "h".repeat(48), now });
    const config = loadPreviewRuntimeAccessConfig({ MATRIX_PREVIEW_RUNTIME_ACCESS_ENABLED: "true",
      MATRIX_PREVIEW_RUNTIME_SECRET: "r".repeat(48), PLATFORM_SECRET: f.previewSecret,
      MATRIX_PREVIEW_AI_BUDGET_MICROUSD: "1000", MATRIX_PREVIEW_AI_REQUEST_LIMIT: "2", MATRIX_PREVIEW_SPEECH_REQUEST_LIMIT: "2" });
    const member = { role: "owner" as const, machineId: f.owner.machine_id, actorId: f.owner.actor_id, handle: f.owner.handle, tokenEpoch: 1 };
    const request = { machineId: member.machineId, ownerId: member.actorId, runtimeSlot: member.handle, expectedRuntimeTokenEpoch: member.tokenEpoch };
    const allocation = await initializePreviewRuntimeAccess({ db: target, repository, config, request, now });
    const hostConfiguration = vi.fn(async () => true); // Explicit transport/configuration port; actual host producer is qualified separately.
    const read = createPreviewPairFundingReader({ db: f.source.db, now: () => clock, hostConfiguration });
    return { member, request, allocation, repository, config, hostConfiguration, read, setClock: (at: number) => { clock = at; } };
  }
  it("reads spendable current credit from the real ledger and never refills the allocation", async () => {
    const s = await setup();
    expect(await s.read(s.member, new AbortController().signal)).toMatchObject({ source: "preview-test", machineId: s.member.machineId,
      actorId: s.member.actorId, tokenEpoch: 1, remainingMicrousd: 1000, expiresAt: s.allocation.expiresAt });
    expect(s.hostConfiguration).toHaveBeenCalledTimes(1);
    // Balance-depletion fixture, not a model dispatch/settlement qualification.
    await f.source.db.executor.updateTable("ai_funded_runtime_balances").set({ credit_balance_microusd: 340,
      promotional_balance_microusd: 340, month_spent_microusd: 660 }).where("machine_id", "=", s.member.machineId).execute();
    await initializePreviewRuntimeAccess({ db: f.source.db, repository: s.repository, config: s.config, request: s.request, now: () => new Date(PAIR_NOW) });
    expect(await s.read(s.member, new AbortController().signal)).toMatchObject({ remainingMicrousd: 340 });
    expect(await f.source.db.executor.selectFrom("preview_runtime_allocations").selectAll().execute()).toHaveLength(1);
    expect(await f.source.db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toHaveLength(1);
  });
  it("rejects exhausted request quota, disabled policy and unconfigured hosts without minting credit", async () => {
    const s = await setup(), signal = new AbortController().signal;
    await f.source.db.executor.updateTable("preview_runtime_allocations").set({ ai_requests_used: 2 }).where("machine_id", "=", s.member.machineId).execute();
    await expect(s.read(s.member, signal)).rejects.toThrow("unavailable");
    expect(s.hostConfiguration).not.toHaveBeenCalled();
    await f.source.db.transaction(async trx => {
      await trx.executor.updateTable("preview_runtime_allocations").set({ ai_requests_used: 0 }).where("machine_id", "=", s.member.machineId).execute();
      await trx.executor.updateTable("ai_funded_runtime_policies").set({ enabled: false }).where("machine_id", "=", s.member.machineId).execute();
    });
    await expect(s.read(s.member, signal)).rejects.toThrow("unavailable");
    await f.source.db.executor.updateTable("ai_funded_runtime_policies").set({ enabled: true }).where("machine_id", "=", s.member.machineId).execute();
    s.hostConfiguration.mockResolvedValue(false);
    await expect(s.read(s.member, signal)).rejects.toThrow("unavailable");
    expect(await f.source.db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toHaveLength(1);
  });
  it("denies stale epoch, expiry and a caller naming another owner", async () => {
    const s = await setup(), signal = new AbortController().signal;
    await expect(s.read({ ...s.member, actorId: "user_outsider" }, signal)).rejects.toThrow("unavailable");
    await expect(s.read({ ...s.member, tokenEpoch: 2 }, signal)).rejects.toThrow("unavailable");
    s.setClock(Date.parse(s.allocation.expiresAt) + 1);
    await expect(s.read(s.member, signal)).rejects.toThrow("unavailable");
    expect(s.hostConfiguration).not.toHaveBeenCalled();
  });

});
