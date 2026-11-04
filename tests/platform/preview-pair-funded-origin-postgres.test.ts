import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectedPreviewPair } from "./preview-pair-projected-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { initializePreviewRuntimeAccess, loadPreviewRuntimeAccessConfig } from "../../packages/platform/src/preview-runtime-access.js";
import { createFundedHostActivationRoutes } from "../../packages/platform/src/funded-host-activation.js";
import { createPlatformFundedAiHostConfigRoutes } from "../../packages/gateway/src/funded-host-activation.js";
import { buildPlatformRuntimeVerificationToken, buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("paired host activation proof origin (real routes and Postgres)", () => {
  let f: Awaited<ReturnType<typeof createProjectedPreviewPair>>;
  beforeEach(async () => { f = await createProjectedPreviewPair(); }, 30_000);
  afterEach(async () => { await f?.destroy(); });
  it("uses the bounded control allowance without repointing collaboration or financial origins", async () => {
    const target = f.source.db, now = () => new Date(PAIR_NOW), runtimeSecret = "r".repeat(48);
    const member = f.owner, origin = "https://app.matrix-os.com";
    const relayOrigin = "https://matrix-ai-relay-production-fixture.a.run.app";
    await target.executor.updateTable("ai_funded_global_policy").set({ enabled: true,
      allowed_model_ids: JSON.stringify(["anthropic/claude-sonnet-5"]), revision: 1, updated_at: now().toISOString(),
    }).where("policy_id", "=", "default").execute();
    const repository = createAiFundedPolicyRepository({ db: target, credentialHashSecret: "h".repeat(48), now });
    await initializePreviewRuntimeAccess({ db: target, repository, now,
      config: loadPreviewRuntimeAccessConfig({ MATRIX_PREVIEW_RUNTIME_ACCESS_ENABLED: "true", MATRIX_PREVIEW_RUNTIME_SECRET: runtimeSecret, PLATFORM_SECRET: f.previewSecret }),
      request: { ownerId: member.actor_id, machineId: member.machine_id, runtimeSlot: member.handle, expectedRuntimeTokenEpoch: 1 } });
    const routeOptions = { db: target, platformSecret: f.controlSecret, previewRuntimeSecret: runtimeSecret,
      relayOrigin, now, env: {} };
    const platform = new Hono().route("/internal/containers/:handle/ai", createFundedHostActivationRoutes(routeOptions));
    const upgradeToken = buildPlatformVerificationToken(member.handle, f.previewSecret);
    const runtimeToken = buildPlatformRuntimeVerificationToken({ handle: member.handle, machineId: member.machine_id, runtimeSlot: member.handle }, runtimeSecret, 1);
    const applyConfig = vi.fn(async (_config: import("@matrix-os/contracts").FundedHostActivationResponse) => undefined), scheduleRestart = vi.fn();
    const fetchProof = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new URL(String(url)).origin).toBe(origin);
      return platform.request(String(url), init);
    });
    const hostRoutes = createPlatformFundedAiHostConfigRoutes({ env: { MATRIX_HANDLE: member.handle, MATRIX_MACHINE_ID: member.machine_id,
      MATRIX_CLERK_USER_ID: member.actor_id, MATRIX_RUNTIME_SLOT: member.handle, MATRIX_RUNTIME_TOKEN_EPOCH: "1", PLATFORM_INTERNAL_URL: f.source.candidate.apiOrigin, UPGRADE_TOKEN: upgradeToken },
      isIdle: () => true, now: () => PAIR_NOW, fetch: fetchProof, applyConfig, scheduleRestart });
    const host = new Hono().route("/api/internal/platform-funded-ai", hostRoutes);
    const response = await host.request("/api/internal/platform-funded-ai/config", { method: "POST", headers: { authorization: `Bearer ${upgradeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ contractVersion: 1, identity: { handle: member.handle, machineId: member.machine_id,
        ownerId: member.actor_id, runtimeSlot: member.handle, runtimeTokenEpoch: 1 },
      configuration: { enabled: true, platformOrigin: origin, relayOrigin, runtimeToken } }) });
    expect(response.status).toBe(202);
    expect(applyConfig.mock.calls[0]?.[0]?.configuration.platformOrigin).toBe(origin);
    expect(applyConfig).toHaveBeenCalledTimes(1); expect(scheduleRestart).toHaveBeenCalledTimes(1);
    expect(fetchProof).toHaveBeenCalledTimes(1);
  });
});
