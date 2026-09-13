import { describe, expect, it, vi } from "vitest";
import {
  PlatformSpeechClientError,
  createPlatformSpeechClient,
  loadPlatformSpeechRuntimeConfig,
} from "../../packages/gateway/src/speech/platform-client.js";

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

describe("platform speech runtime client", () => {
  it("stays disabled by default and requires the exact runtime-bound configuration", () => {
    expect(loadPlatformSpeechRuntimeConfig({})).toBeUndefined();
    expect(() => loadPlatformSpeechRuntimeConfig({
      ...runtimeEnv,
      MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN: "legacy-short-token",
    })).toThrow(/misconfigured/i);
    expect(loadPlatformSpeechRuntimeConfig(runtimeEnv)).toEqual({
      baseUrl: "https://platform.internal/internal/containers/alice/speech",
      runtimeAuthToken: "r".repeat(64),
      identity: { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" },
      requestOwnerId: "user_alice",
      requestTimeoutMs: 65_000,
    });

    expect(loadPlatformSpeechRuntimeConfig({
      ...runtimeEnv,
      MATRIX_HANDLE: "pr-1620",
      MATRIX_RUNTIME_SLOT: "pr-1620",
      MATRIX_PREVIEW_RUNTIME: "true",
      MATRIX_PLATFORM_SPEECH_ORIGIN: "https://pr-1620---speech-preview.example",
      MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN: "s".repeat(64),
      MATRIX_PLATFORM_SPEECH_OWNER_ID: "speech_preview_owner",
      MATRIX_PLATFORM_SPEECH_REQUEST_OWNER_ID: "user_alice",
      MATRIX_PLATFORM_SPEECH_MACHINE_ID: "speech_preview_machine",
      MATRIX_PLATFORM_SPEECH_RUNTIME_SLOT: "pr-1620",
    })).toEqual({
      baseUrl: "https://pr-1620---speech-preview.example/internal/containers/pr-1620/speech",
      runtimeAuthToken: "s".repeat(64),
      identity: {
        ownerId: "speech_preview_owner",
        machineId: "speech_preview_machine",
        runtimeSlot: "pr-1620",
      },
      requestOwnerId: "user_alice",
      requestTimeoutMs: 65_000,
    });
    expect(() => loadPlatformSpeechRuntimeConfig({
      ...runtimeEnv,
      MATRIX_PLATFORM_SPEECH_OWNER_ID: "partial-preview-identity",
    })).toThrow(/misconfigured/i);
    expect(() => loadPlatformSpeechRuntimeConfig({
      ...runtimeEnv,
      MATRIX_PLATFORM_SPEECH_REQUEST_OWNER_ID: "invalid owner",
    })).toThrow(/misconfigured/i);
    expect(() => loadPlatformSpeechRuntimeConfig({
      ...runtimeEnv,
      MATRIX_PLATFORM_SPEECH_REQUEST_OWNER_ID: "user_someone_else",
    })).toThrow(/misconfigured/i);
    expect(() => loadPlatformSpeechRuntimeConfig({
      ...runtimeEnv,
      MATRIX_PLATFORM_SPEECH_OWNER_ID: "preview_owner",
      MATRIX_PLATFORM_SPEECH_MACHINE_ID: "preview_machine",
      MATRIX_PLATFORM_SPEECH_RUNTIME_SLOT: "primary",
    })).toThrow(/misconfigured/i);
  });

  it("uses a fixed runtime URL, runtime credential, timeout, no redirects, and no retries", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(unavailableCapabilities), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const client = createPlatformSpeechClient(loadPlatformSpeechRuntimeConfig(runtimeEnv)!, { fetchFn });
    await expect(client.capabilities()).resolves.toEqual(unavailableCapabilities);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://platform.internal/internal/containers/alice/speech/capabilities?runtimeSlot=primary",
    );
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { authorization: `Bearer ${"r".repeat(64)}`, accept: "application/json" },
    });
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("forwards one bounded dictation recording and exposes only enumerated failures", async () => {
    const requestId = "sp_1788998400000_abcdefghijklmnop";
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get("requestId")).toBe(requestId);
      expect(form.get("sourceKind")).toBe("dictation");
      expect(form.get("recording")).toBeInstanceOf(File);
      return new Response(JSON.stringify({
        contractVersion: 1,
        requestId,
        status: "succeeded",
        outcome: "transcript",
        text: "editable draft",
        audioDurationMs: 1_000,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = createPlatformSpeechClient(loadPlatformSpeechRuntimeConfig(runtimeEnv)!, { fetchFn });
    await expect(client.transcribe({
      requestId,
      sourceKind: "dictation",
      audio: new Uint8Array(44),
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ outcome: "transcript", text: "editable draft" });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const failing = createPlatformSpeechClient(loadPlatformSpeechRuntimeConfig(runtimeEnv)!, {
      fetchFn: vi.fn(async () => new Response(
        JSON.stringify({ error: { code: "transcription_failed", message: "Transcription failed" } }),
        { status: 502, headers: { "content-type": "application/json" } },
      )),
    });
    const error = await failing.transcribe({
      requestId,
      sourceKind: "dictation",
      audio: new Uint8Array(44),
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformSpeechClientError);
    expect(error).toMatchObject({ code: "transcription_failed", safeMessage: "Transcription failed" });
    expect(JSON.stringify(error)).not.toMatch(/provider|openai|machine_123/i);
  });

  it("bounds response bytes before decoding JSON", async () => {
    const client = createPlatformSpeechClient(loadPlatformSpeechRuntimeConfig(runtimeEnv)!, {
      fetchFn: vi.fn(async () => new Response("x".repeat(300_000), { status: 200 })),
    });
    await expect(client.capabilities()).rejects.toBeInstanceOf(PlatformSpeechClientError);
  });

  it("normalizes upstream runtime authentication failures as internal unavailability", async () => {
    const client = createPlatformSpeechClient(loadPlatformSpeechRuntimeConfig(runtimeEnv)!, {
      fetchFn: vi.fn(async () => new Response(JSON.stringify({
        error: { code: "unauthorized", message: "Unauthorized" },
      }), { status: 401, headers: { "content-type": "application/json" } })),
    });
    const error = await client.capabilities().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformSpeechClientError);
    expect(error).toMatchObject({ code: "unavailable", status: 503, safeMessage: "Speech is unavailable" });
  });
});
