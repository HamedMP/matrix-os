import { describe, expect, it, vi } from "vitest";
import {
  SpeechAdapterError,
  createOpenAiFileTranscriptionAdapter,
} from "../../packages/platform/src/speech/adapters/openai.js";

const audio = new Uint8Array([82, 73, 70, 70]);

describe("OpenAI file transcription adapter", () => {
  it("uses a fixed endpoint, no redirects, one request and a bounded final response", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: "hello" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const adapter = createOpenAiFileTranscriptionAdapter({
      apiKey: "test-platform-key",
      model: "gpt-transcribe",
      fetchImpl,
    });
    await expect(adapter.transcribe({
      audio,
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    })).resolves.toEqual({ text: "hello" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(String(fetchImpl.mock.calls[0]?.[1]?.headers)).not.toContain("test-platform-key");
  });

  it("normalizes empty speech and provider failures without exposing response bodies", async () => {
    const empty = createOpenAiFileTranscriptionAdapter({
      apiKey: "test-platform-key",
      model: "gpt-transcribe",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ text: "   " }), { status: 200 })),
    });
    await expect(empty.transcribe({ audio, mediaType: "audio/wav", signal: new AbortController().signal }))
      .resolves.toEqual({ text: "" });

    const failing = createOpenAiFileTranscriptionAdapter({
      apiKey: "test-platform-key",
      model: "gpt-transcribe",
      fetchImpl: vi.fn(async () => new Response("secret upstream failure", { status: 500 })),
    });
    const error = await failing.transcribe({
      audio,
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpeechAdapterError);
    expect(JSON.stringify(error)).not.toMatch(/secret upstream failure|test-platform-key/i);
  });

  it("rejects unverified language hints and oversized upstream bodies", async () => {
    const adapter = createOpenAiFileTranscriptionAdapter({
      apiKey: "test-platform-key",
      model: "gpt-transcribe",
      maxResponseBytes: 64,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ text: "x".repeat(100) }), { status: 200 })),
    });
    await expect(adapter.transcribe({
      audio,
      mediaType: "audio/wav",
      languageHints: ["en"],
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "unsupported_options" });
    await expect(adapter.transcribe({
      audio,
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "invalid_response" });
  });
});
