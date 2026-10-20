import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fundedHostActivationRevisionInput } from "@matrix-os/contracts";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { buildPlatformSpeechRuntimeVerificationToken, buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createPreviewRuntimeAccessActivator } from "../../packages/platform/src/preview-runtime-activation.js";
import { loadPreviewRuntimeAccessConfig } from "../../packages/platform/src/preview-runtime-access.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./native-platform-db-test-helper.js";

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

  it("delivers separate exact-generation runtime tokens without provider credentials", async () => {
    let fundedRevision = "";
    let fundedBody: Record<string, unknown> | undefined;
    let speechBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/internal/platform-funded-ai/config") && init?.method === "POST") {
        expect(init.headers).toMatchObject({ authorization: `Bearer ${buildPlatformVerificationToken(machine.handle, hostSecret)}` });
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

    await expect(activate({ ownerId: machine.ownerId, machineId: machine.machineId,
      runtimeSlot: machine.runtimeSlot, expectedRuntimeTokenEpoch: 1 })).resolves.toMatchObject({ status: "ready" });
    expect(JSON.stringify(fundedBody)).not.toMatch(/api[_-]?key|provider[_-]?key/i);
    expect(fundedBody).toMatchObject({ identity: { machineId: machine.machineId, ownerId: machine.ownerId,
      runtimeSlot: machine.runtimeSlot, runtimeTokenEpoch: 1 } });
    expect(speechBody).toMatchObject({ machineId: machine.machineId, runtimeSlot: machine.runtimeSlot,
      runtimeToken: buildPlatformSpeechRuntimeVerificationToken({ handle: machine.handle,
        machineId: machine.machineId, runtimeSlot: machine.runtimeSlot }, previewSecret, 1) });
  });
});
