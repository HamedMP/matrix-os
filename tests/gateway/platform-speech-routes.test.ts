import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createSpeechGatewayRoutes } from "../../packages/gateway/src/speech/routes.js";
import type { PlatformSpeechClient } from "../../packages/gateway/src/speech/platform-client.js";
import { RequestPrincipalMisconfiguredError } from "../../packages/gateway/src/request-principal.js";

const requestId = "sp_1788998400000_abcdefghijklmnop";
const capabilities = {
  contractVersion: 1 as const,
  fileTranscription: {
    status: "ready" as const,
    dictation: {
      enabled: true as const,
      maxBytes: 10 * 1024 * 1024,
      maxDurationMs: 120_000,
      maxTranscriptChars: 32_000,
      supportedMediaTypes: ["audio/wav" as const],
      languageHints: false,
    },
    ownerAudio: { enabled: false as const },
  },
};

function client(): PlatformSpeechClient {
  return {
    ownerId: "user_alice",
    capabilities: vi.fn(async () => capabilities),
    transcribe: vi.fn(async () => ({
      contractVersion: 1,
      requestId,
      status: "succeeded",
      outcome: "transcript",
      text: "editable draft",
      audioDurationMs: 1_000,
    })),
    status: vi.fn(async () => undefined),
    cancel: vi.fn(async () => ({
      contractVersion: 1,
      requestId,
      executionState: "cancelled",
      cancellationRequested: true,
      executionStarted: false,
    })),
  };
}

function app(speech: PlatformSpeechClient, ownerId = "user_alice") {
  const root = new Hono();
  root.route("/api/speech", createSpeechGatewayRoutes({
    client: speech,
    getOwnerId: () => ownerId,
  }));
  return root;
}

function recordingForm(operationId: string): FormData {
  const form = new FormData();
  form.set("requestId", operationId);
  form.set("recording", new File([new Uint8Array(44)], "recording.wav", { type: "audio/wav" }));
  return form;
}

describe("gateway speech routes", () => {
  it("returns provider-neutral capability policy only to the configured runtime owner", async () => {
    const response = await app(client()).request("/api/speech/capabilities");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual(capabilities);
    const foreign = await app(client(), "user_bob").request("/api/speech/capabilities");
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(await foreign.json())).not.toMatch(/alice|bob/i);
  });

  it("derives dictation source and rejects caller-selected provider fields", async () => {
    const speech = client();
    const valid = new FormData();
    valid.set("requestId", requestId);
    valid.set("recording", new File([new Uint8Array(44)], "recording.wav", { type: "audio/wav" }));
    const response = await app(speech).request("/api/speech/transcriptions", {
      method: "POST",
      body: valid,
    });
    expect(response.status).toBe(200);
    expect(speech.transcribe).toHaveBeenCalledWith(expect.objectContaining({
      requestId,
      sourceKind: "dictation",
      mediaType: "audio/wav",
    }));

    const spoofed = new FormData();
    spoofed.set("requestId", requestId);
    spoofed.set("recording", new File([new Uint8Array(44)], "recording.wav", { type: "audio/wav" }));
    spoofed.set("provider", "runtime-key");
    const rejected = await app(speech).request("/api/speech/transcriptions", {
      method: "POST",
      body: spoofed,
    });
    expect(rejected.status).toBe(400);
    expect(speech.transcribe).toHaveBeenCalledTimes(1);
  });

  it("body-limits POST and DELETE and never forwards oversized content", async () => {
    const speech = client();
    const oversized = await app(speech).request("/api/speech/transcriptions", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(11 * 1024 * 1024),
      },
      body: new Uint8Array(11 * 1024 * 1024),
    });
    expect(oversized.status).toBe(413);
    expect(speech.transcribe).not.toHaveBeenCalled();

    const cancel = await app(speech).request(`/api/speech/transcriptions/${requestId}`, {
      method: "DELETE",
      body: "x".repeat(2_000),
    });
    expect(cancel.status).toBe(413);
    expect(speech.cancel).not.toHaveBeenCalled();
  });

  it("admits only a bounded number of recordings before multipart parsing", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const speech = client();
    speech.transcribe = vi.fn(async ({ requestId: operationId }) => {
      await pending;
      return {
        contractVersion: 1,
        requestId: operationId,
        status: "succeeded",
        outcome: "no_speech",
        audioDurationMs: 1_000,
      };
    });
    const root = app(speech);
    const first = root.request("/api/speech/transcriptions", { method: "POST", body: recordingForm(requestId) });
    const secondId = "sp_1788998400001_bcdefghijklmnopq";
    const second = root.request("/api/speech/transcriptions", { method: "POST", body: recordingForm(secondId) });
    await vi.waitFor(() => expect(speech.transcribe).toHaveBeenCalledTimes(2));

    const rejected = await root.request("/api/speech/transcriptions", {
      method: "POST",
      body: recordingForm("sp_1788998400002_cdefghijklmnopqr"),
    });
    expect(rejected.status).toBe(429);
    expect(speech.transcribe).toHaveBeenCalledTimes(2);

    finish();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("distinguishes foreign owners from principal wiring failures", async () => {
    const speech = client();
    const root = new Hono();
    root.route("/api/speech", createSpeechGatewayRoutes({
      client: speech,
      getOwnerId: () => { throw new RequestPrincipalMisconfiguredError(); },
    }));
    const response = await root.request("/api/speech/capabilities");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Speech request failed" });
    expect(speech.capabilities).not.toHaveBeenCalled();
  });
});
