import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { buildPlatformRuntimeVerificationToken, buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createSpeechRuntimeRoutes } from "../../packages/platform/src/speech/routes.js";
import { createApp } from "../../packages/platform/src/main.js";
import { createDisabledOrchestrator } from "../../packages/platform/src/orchestrator.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const platformSecret = "platform-secret-for-tests-123456789";
const identity = { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" } as const;

describe("speech runtime routes", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, {
      machineId: identity.machineId,
      clerkUserId: identity.ownerId,
      handle: "alice",
      runtimeSlot: identity.runtimeSlot,
      status: "running",
      imageVersion: "v1",
      provisionedAt: "2026-09-09T00:00:00.000Z",
      activationState: "authorized",
    });
  });

  afterEach(async () => destroyTestPlatformDb(db));

  function app(service: Parameters<typeof createSpeechRuntimeRoutes>[0]["service"]) {
    const root = new Hono();
    root.route("/internal/containers/:handle/speech", createSpeechRuntimeRoutes({
      db,
      platformSecret,
      service,
    }));
    return root;
  }

  const capabilities = {
    contractVersion: 1 as const,
    fileTranscription: {
      status: "unavailable" as const,
      reason: "disabled" as const,
      dictation: {
        enabled: false,
        maxBytes: 10 * 1024 * 1024,
        maxDurationMs: 120_000,
        maxTranscriptChars: 32_000,
        supportedMediaTypes: ["audio/wav" as const],
        languageHints: false,
      },
      ownerAudio: { enabled: false as const },
    },
  };

  function service() {
    return {
      capabilities: vi.fn(() => capabilities),
      transcribe: vi.fn(),
      status: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      shutdown: vi.fn(),
    };
  }

  function runtimeBearer() {
    return buildPlatformRuntimeVerificationToken({ handle: "alice", machineId: identity.machineId, runtimeSlot: "primary" }, platformSecret);
  }

  it("rejects the legacy handle-only token and accepts the runtime-bound credential", async () => {
    const routes = app(service());
    const path = "/internal/containers/alice/speech/capabilities?runtimeSlot=primary";
    expect((await routes.request(path, {
      headers: { authorization: `Bearer ${buildPlatformVerificationToken("alice", platformSecret)}` },
    })).status).toBe(401);
    const response = await routes.request(path, {
      headers: { authorization: `Bearer ${runtimeBearer()}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(capabilities);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("validates status IDs before service lookup and hides foreign operations", async () => {
    const speech = service();
    const routes = app(speech);
    const invalid = await routes.request(
      "/internal/containers/alice/speech/transcriptions/not-valid?runtimeSlot=primary",
      { headers: { authorization: `Bearer ${runtimeBearer()}` } },
    );
    expect(invalid.status).toBe(400);
    expect(speech.status).not.toHaveBeenCalled();

    const missing = await routes.request(
      "/internal/containers/alice/speech/transcriptions/sp_1788998400000_abcdefghijklmnop?runtimeSlot=primary",
      { headers: { authorization: `Bearer ${runtimeBearer()}` } },
    );
    expect(missing.status).toBe(404);
    expect(JSON.stringify(await missing.json())).not.toMatch(/user_alice|machine_123/i);
  });

  it("body-limits cancellation even though the endpoint ignores content", async () => {
    const routes = app(service());
    const response = await routes.request(
      "/internal/containers/alice/speech/transcriptions/sp_1788998400000_abcdefghijklmnop?runtimeSlot=primary",
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${runtimeBearer()}`, "content-type": "text/plain" },
        body: "x".repeat(2_000),
      },
    );
    expect(response.status).toBe(413);
  });

  it("mounts the runtime speech router before personal session routing", async () => {
    const speechRoutes = createSpeechRuntimeRoutes({ db, platformSecret, service: service() });
    const platform = createApp({
      db,
      platformSecret,
      orchestrator: createDisabledOrchestrator({ db, image: "test" }),
      internalSpeechRuntimeRoutes: speechRoutes,
    });
    const response = await platform.request(
      "/internal/containers/alice/speech/capabilities?runtimeSlot=primary",
      { headers: { authorization: `Bearer ${runtimeBearer()}` } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(capabilities);
  });
});
