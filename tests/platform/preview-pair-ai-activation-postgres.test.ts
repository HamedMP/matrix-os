import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectedPreviewPair } from "./preview-pair-projected-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { loadPreviewRuntimeAccessConfig } from "../../packages/platform/src/preview-runtime-access.js";
import { createFundedHostActivationRoutes } from "../../packages/platform/src/funded-host-activation.js";
import { createPlatformFundedAiHostConfigRoutes } from "../../packages/gateway/src/funded-host-activation.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createPreviewPairAiActivation } from "../../packages/platform/src/preview-pair/activate-ai.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("bounded pair AI activation (real routes and Postgres)", () => {
  let f: Awaited<ReturnType<typeof createProjectedPreviewPair>>;
  beforeEach(async () => { f = await createProjectedPreviewPair(); }, 30_000);
  afterEach(async () => { await f?.destroy(); });
  async function setup() {
    const db = f.source.db, now = () => new Date(PAIR_NOW), runtimeSecret = "r".repeat(48);
    const member = { role: "owner" as const, machineId: f.owner.machine_id, actorId: f.owner.actor_id, handle: f.owner.handle, tokenEpoch: 1 };
    const relayOrigin = "https://matrix-ai-relay-production-fixture.a.run.app";
    await db.executor.updateTable("ai_funded_global_policy").set({ enabled: true,
      allowed_model_ids: JSON.stringify(["anthropic/claude-sonnet-5"]), revision: 1, updated_at: now().toISOString(),
    }).where("policy_id", "=", "default").execute();
    const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(48), now });
    const config = loadPreviewRuntimeAccessConfig({ MATRIX_PREVIEW_RUNTIME_ACCESS_ENABLED: "true",
      MATRIX_PREVIEW_RUNTIME_SECRET: runtimeSecret, PLATFORM_SECRET: f.controlSecret, MATRIX_PREVIEW_AI_BUDGET_MICROUSD: "1000" });
    const platform = new Hono().route("/internal/containers/:handle/ai", createFundedHostActivationRoutes({ db,
      platformSecret: f.controlSecret, previewRuntimeSecret: runtimeSecret, relayOrigin, now, env: {} }));
    const env: NodeJS.ProcessEnv = { MATRIX_HANDLE: member.handle, MATRIX_MACHINE_ID: member.machineId,
      MATRIX_CLERK_USER_ID: member.actorId, MATRIX_RUNTIME_SLOT: member.handle, MATRIX_RUNTIME_TOKEN_EPOCH: "1",
      PLATFORM_INTERNAL_URL: f.source.candidate.apiOrigin, UPGRADE_TOKEN: buildPlatformVerificationToken(member.handle, f.previewSecret) };
    const restart = vi.fn();
    // OS apply/restart are explicit fixtures. The actual gateway/platform proof routes remain real.
    const hostRoutes = createPlatformFundedAiHostConfigRoutes({ env, isIdle: () => true, now: () => PAIR_NOW,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        expect(new URL(String(url)).origin).toBe("https://app.matrix-os.com");
        return platform.request(String(url), init);
      }) as typeof fetch,
      applyConfig: async proof => {
        Object.assign(env, { MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_PLATFORM_URL: proof.configuration.platformOrigin,
          MATRIX_FUNDED_AI_RELAY_URL: proof.configuration.relayOrigin, MATRIX_FUNDED_AI_RUNTIME_TOKEN: proof.configuration.runtimeToken });
      }, scheduleRestart: restart });
    const host = new Hono().route("/api/internal/platform-funded-ai", hostRoutes);
    const requestHost = vi.fn(async (_member: typeof member, init: RequestInit, _signal: AbortSignal) =>
      host.request("/api/internal/platform-funded-ai/config", init));
    const options = { db, repository, config, controlSecret: f.controlSecret,
      hostSecret: f.previewSecret, relayOrigin, now: () => PAIR_NOW, requestHost };
    const activation = createPreviewPairAiActivation(options);
    return { activation, member, restart, requestHost, env, options };
  }
  it("makes one idempotent POST, returns pending, then verifies loaded configuration without a second POST or refill", async () => {
    const s = await setup(), signal = new AbortController().signal;
    expect(await s.activation.step(s.member, signal)).toBe(false);
    expect(s.requestHost.mock.calls.filter(call => call[1].method === "POST")).toHaveLength(1);
    expect(await s.activation.step(s.member, signal)).toBe(true);
    expect(await s.activation.configured(s.member, signal)).toBe(true);
    expect(s.requestHost.mock.calls.filter(call => call[1].method === "POST")).toHaveLength(1);
    expect(s.restart).toHaveBeenCalledTimes(1);
    expect(s.env.PLATFORM_INTERNAL_URL).toBe(f.source.candidate.apiOrigin);
    expect(await f.source.db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toHaveLength(1);
    expect(await f.target.db.executor.selectFrom("preview_runtime_allocations").selectAll().execute()).toEqual([]);
  });
  it("recovers a lost applied response by reading configuration before attempting another POST", async () => {
    const s = await setup(), signal = new AbortController().signal;
    const dispatch = s.requestHost.getMockImplementation()!; let lose = true;
    s.requestHost.mockImplementation(async (member, init, currentSignal) => {
      const response = await dispatch(member, init, currentSignal);
      if (init.method === "POST" && lose) { lose = false; await response.body?.cancel(); throw new TypeError("Lost response"); }
      return response;
    });
    expect(await s.activation.step(s.member, signal)).toBe(false);
    expect(s.restart).toHaveBeenCalledTimes(1);
    expect(await s.activation.step(s.member, signal)).toBe(true);
    expect(s.requestHost.mock.calls.filter(call => call[1].method === "POST")).toHaveLength(1);
    expect(await f.source.db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toHaveLength(1);
  });
  it("never gives the candidate host a control or allowance signing key", async () => {
    const s = await setup();
    expect(() => createPreviewPairAiActivation({ ...s.options, hostSecret: f.controlSecret })).toThrow("unavailable");
    if (!s.options.config.enabled) throw new Error("Enabled test funding is required");
    expect(() => createPreviewPairAiActivation({ ...s.options, hostSecret: s.options.config.runtimeSecret })).toThrow("unavailable");
    expect(s.requestHost).not.toHaveBeenCalled();
  });

});
