import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewaySpeechRuntimeRoutes } from "../../packages/gateway/src/speech/gateway-runtime.js";

const runtimeEnv = {
  MATRIX_PLATFORM_SPEECH_ENABLED: "true",
  PLATFORM_INTERNAL_URL: "https://platform.internal",
  MATRIX_HANDLE: "alice",
  MATRIX_CLERK_USER_ID: "user_alice",
  MATRIX_MACHINE_ID: "machine_123",
  MATRIX_RUNTIME_SLOT: "primary",
  MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN: "r".repeat(64),
};

const unavailableCapabilities = {
  contractVersion: 1,
  fileTranscription: {
    status: "unavailable",
    reason: "disabled",
    dictation: {
      enabled: false,
      maxBytes: 10 * 1024 * 1024,
      maxDurationMs: 120_000,
      maxTranscriptChars: 32_000,
      supportedMediaTypes: ["audio/wav"],
      languageHints: false,
    },
    ownerAudio: { enabled: false },
  },
};

function app(env: NodeJS.ProcessEnv, ownerId = "user_alice") {
  const root = new Hono();
  root.route("/api/speech", createGatewaySpeechRuntimeRoutes({
    env,
    getOwnerId: () => ownerId,
  }));
  return root;
}

describe("gateway platform speech runtime composition", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps runtime client construction out of the gateway entrypoint", () => {
    const source = readFileSync(new URL("../../packages/gateway/src/server.ts", import.meta.url), "utf8");
    expect(source).toContain("createGatewaySpeechRuntime");
    expect(source).not.toContain("loadPlatformSpeechRuntimeConfig");
    expect(source).not.toContain("createPlatformSpeechClient");
  });

  it("composes disabled and configured speech routes at registration", async () => {
    const disabled = await app({}).request("/api/speech/capabilities");
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({
      fileTranscription: { status: "unavailable", reason: "disabled" },
    });

    const fetchFn = vi.fn(async () => Response.json(unavailableCapabilities));
    vi.stubGlobal("fetch", fetchFn);
    const configured = await app(runtimeEnv).request("/api/speech/capabilities");
    expect(configured.status).toBe(200);
    expect(await configured.json()).toEqual(unavailableCapabilities);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://platform.internal/internal/containers/alice/speech/capabilities?runtimeSlot=primary",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });
});
