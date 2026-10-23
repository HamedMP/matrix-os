import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fundedHostActivationRevisionInput } from "@matrix-os/contracts";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { buildPlatformSpeechRuntimeVerificationToken, buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createPreviewRuntimeAccessActivator } from "../../packages/platform/src/preview-runtime-activation.js";
import { loadPreviewRuntimeAccessConfig } from "../../packages/platform/src/preview-runtime-access.js";
import { createFundedHostActivationRoutes } from "../../packages/platform/src/funded-host-activation.js";
import { createPlatformFundedAiHostConfigRoutes } from "../../packages/gateway/src/funded-host-activation.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./native-platform-db-test-helper.js";
import { Hono } from "hono";

const now = new Date("2026-10-20T10:00:00.000Z");
const hostSecret = "h".repeat(32);
const previewSecret = "p".repeat(32);
const machine = {
  ownerId: "user_preview",
  machineId: "d109ff63-234b-4bba-8231-f38a8c343736",
  runtimeSlot: "pr-2383",
  handle: "pr-2383",
};

describe("Preview runtime host activation", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, { machineId: machine.machineId, clerkUserId: machine.ownerId,
      handle: machine.handle, runtimeSlot: machine.runtimeSlot, provisioningClass: "preview",
      activationState: "authorized", status: "running", publicIPv4: "203.0.113.10",
      imageVersion: "preview", provisionedAt: now.toISOString() });
    await db.executor.updateTable("ai_funded_global_policy").set({ enabled: true,
      allowed_model_ids: JSON.stringify(["anthropic/claude-sonnet-5"]), revision: 1,
      updated_at: now.toISOString() }).where("policy_id", "=", "default").execute();
  });

  afterEach(async () => destroyTestPlatformDb(db));

  it.each(["preview", "private-preview"] as const)(
    "delivers separate exact-generation runtime tokens without provider credentials for %s",
    async provisioningClass => {
    const identity = provisioningClass === "private-preview"
      ? { ...machine, handle: "pv-2383-deadbeef", runtimeSlot: "pv-2383-deadbeef" }
      : machine;
    if (provisioningClass === "private-preview") {
      await db.executor.updateTable("user_machines").set({
        provisioning_class: provisioningClass,
        handle: identity.handle,
        runtime_slot: identity.runtimeSlot,
        source_pr: 2383,
        confirmed_bundle_version: "v2026.10.23-pr2383-test",
      }).where("machine_id", "=", machine.machineId).execute();
    }
    let fundedRevision = "";
    let fundedBody: Record<string, unknown> | undefined;
    let speechBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/internal/platform-funded-ai/config") && init?.method === "POST") {
        expect(init.headers).toMatchObject({ authorization: `Bearer ${buildPlatformVerificationToken(identity.handle, hostSecret)}` });
        fundedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        fundedRevision = createHash("sha256").update(fundedHostActivationRevisionInput(fundedBody as never)).digest("hex");
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/api/internal/platform-funded-ai/config")) {
        return Response.json({ configured: true, configurationRevision: fundedRevision });
      }
      if (url.endsWith("/api/internal/platform-speech/config") && init?.method === "POST") {
        speechBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/api/internal/platform-speech/config")) {
        const body = speechBody as { machineId: string; runtimeSlot: string; origin: string; runtimeToken: string };
        const revision = createHash("sha256")
          .update(`${body.machineId}\0${body.runtimeSlot}\0${body.origin}\0${body.runtimeToken}`).digest("hex");
        return Response.json({ configured: true, configurationRevision: revision });
      }
      throw new Error("Unexpected URL");
    });
    const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: "c".repeat(32), now: () => new Date(now) });
    const activate = createPreviewRuntimeAccessActivator({ db, repository,
      config: loadPreviewRuntimeAccessConfig({ MATRIX_PREVIEW_RUNTIME_ACCESS_ENABLED: "true",
        MATRIX_PREVIEW_RUNTIME_SECRET: previewSecret, PLATFORM_SECRET: hostSecret }),
      hostControlSecret: hostSecret, platformOrigin: "https://app.matrix-os.com",
      relayOrigin: "https://matrix-ai-relay-production-test.a.run.app",
      fetchImpl: fetchImpl as typeof fetch, wait: async () => undefined, now: () => new Date(now) });

    await expect(activate({ ownerId: identity.ownerId, machineId: identity.machineId,
      runtimeSlot: identity.runtimeSlot, expectedRuntimeTokenEpoch: 1 })).resolves.toMatchObject({ status: "ready" });
    expect(JSON.stringify(fundedBody)).not.toMatch(/api[_-]?key|provider[_-]?key/i);
    expect(fundedBody).toMatchObject({ identity: { machineId: identity.machineId, ownerId: identity.ownerId,
      runtimeSlot: identity.runtimeSlot, runtimeTokenEpoch: 1 } });
    expect(speechBody).toMatchObject({ machineId: identity.machineId, runtimeSlot: identity.runtimeSlot,
      runtimeToken: buildPlatformSpeechRuntimeVerificationToken({ handle: identity.handle,
        machineId: identity.machineId, runtimeSlot: identity.runtimeSlot }, previewSecret, 1) });
  });

  it("activates through the real Preview proof route and Gateway host handler", async () => {
    let applied: Record<string, unknown> | undefined;
    let fundedReadinessAttempts = 0;
    const hostEnv: NodeJS.ProcessEnv = {
      UPGRADE_TOKEN: buildPlatformVerificationToken(machine.handle, hostSecret),
      MATRIX_HANDLE: machine.handle,
      MATRIX_MACHINE_ID: machine.machineId,
      MATRIX_CLERK_USER_ID: machine.ownerId,
      MATRIX_RUNTIME_SLOT: machine.runtimeSlot,
      MATRIX_RUNTIME_TOKEN_EPOCH: "1",
      MATRIX_FUNDED_AI_ENABLED: "false",
    };
    const proofApp = new Hono().route("/internal/containers/:handle/ai",
      createFundedHostActivationRoutes({ db, platformSecret: hostSecret,
        previewRuntimeSecret: previewSecret,
        relayOrigin: "https://matrix-ai-relay-production-test.a.run.app",
        now: () => new Date(now) }));
    const hostApp = new Hono().route("/api/internal/platform-funded-ai",
      createPlatformFundedAiHostConfigRoutes({ env: hostEnv, isIdle: () => true,
        now: () => now.getTime(), fetch: ((input, init) => proofApp.request(String(input), init)) as typeof fetch,
        applyConfig: async config => {
          applied = config;
          hostEnv.MATRIX_FUNDED_AI_ENABLED = "true";
          hostEnv.MATRIX_FUNDED_AI_PLATFORM_URL = config.configuration.platformOrigin;
          hostEnv.MATRIX_FUNDED_AI_RELAY_URL = config.configuration.relayOrigin;
          hostEnv.MATRIX_FUNDED_AI_RUNTIME_TOKEN = config.configuration.runtimeToken;
        },
        scheduleRestart: async () => undefined }));
    let speechBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/api/internal/platform-funded-ai/")) {
        if (init?.method === "GET" && fundedReadinessAttempts++ === 0) {
          throw new TypeError("Gateway is restarting");
        }
        return hostApp.request(url.pathname, init);
      }
      if (url.pathname.endsWith("/api/internal/platform-speech/config") && init?.method === "POST") {
        speechBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(null, { status: 200 });
      }
      if (url.pathname.endsWith("/api/internal/platform-speech/config")) {
        const body = speechBody as { machineId: string; runtimeSlot: string; origin: string; runtimeToken: string };
        return Response.json({ configured: true, configurationRevision: createHash("sha256")
          .update(`${body.machineId}\0${body.runtimeSlot}\0${body.origin}\0${body.runtimeToken}`).digest("hex") });
      }
      throw new Error("Unexpected URL");
    });
    const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: "c".repeat(32),
      now: () => new Date(now) });
    const activate = createPreviewRuntimeAccessActivator({ db, repository,
      config: loadPreviewRuntimeAccessConfig({ MATRIX_PREVIEW_RUNTIME_ACCESS_ENABLED: "true",
        MATRIX_PREVIEW_RUNTIME_SECRET: previewSecret, PLATFORM_SECRET: hostSecret }),
      hostControlSecret: hostSecret, platformOrigin: "https://app.matrix-os.com",
      relayOrigin: "https://matrix-ai-relay-production-test.a.run.app",
      fetchImpl: fetchImpl as typeof fetch, wait: async () => undefined, now: () => new Date(now) });

    await expect(activate({ ownerId: machine.ownerId, machineId: machine.machineId,
      runtimeSlot: machine.runtimeSlot, expectedRuntimeTokenEpoch: 1 })).resolves.toMatchObject({ status: "ready" });
    expect(applied).toMatchObject({ identity: { machineId: machine.machineId,
      runtimeSlot: machine.runtimeSlot, runtimeTokenEpoch: 1 } });
  });
});
