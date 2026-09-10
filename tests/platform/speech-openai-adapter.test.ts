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
    if (!(error instanceof Error)) throw new Error("Expected a normalized adapter error");
    expect(error).toMatchObject({ code: "request_failed", message: "Transcription request failed" });
    expect(`${error.message}\n${error.stack ?? ""}\n${String(error.cause)}`)
      .not.toMatch(/secret upstream failure|test-platform-key/i);
  });

  it("rejects pre-aborted input before dispatch", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = createOpenAiFileTranscriptionAdapter({
      apiKey: "test-platform-key",
      model: "gpt-transcribe",
      fetchImpl,
    });
    await expect(adapter.transcribe({ audio, mediaType: "audio/wav", signal: controller.signal }))
      .rejects.toMatchObject({ code: "cancelled", message: "Transcription was cancelled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("distinguishes caller cancellation from the adapter deadline", async () => {
    const caller = new AbortController();
    const cancelledFetch = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const cancelled = createOpenAiFileTranscriptionAdapter({
      apiKey: "test-platform-key",
      model: "gpt-transcribe",
      fetchImpl: cancelledFetch,
    });
    const cancelledResult = cancelled.transcribe({ audio, mediaType: "audio/wav", signal: caller.signal });
    caller.abort();
    await expect(cancelledResult).rejects.toMatchObject({ code: "cancelled" });
    expect(cancelledFetch).toHaveBeenCalledTimes(1);

    const timedOutFetch = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const timedOut = createOpenAiFileTranscriptionAdapter({
      apiKey: "test-platform-key",
      model: "gpt-transcribe",
      timeoutMs: 1_000,
      fetchImpl: timedOutFetch,
    });
    await expect(timedOut.transcribe({
      audio,
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "timeout", message: "Transcription timed out" });
    expect(timedOutFetch).toHaveBeenCalledTimes(1);
  });

  it("normalizes caller aborts while reading the response body", async () => {
    const caller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"text":"'));
        queueMicrotask(() => {
          caller.abort();
          stream.error(new DOMException("sentinel provider abort", "AbortError"));
        });
      },
    });
    const adapter = createOpenAiFileTranscriptionAdapter({
      apiKey: "test-platform-key",
      model: "gpt-transcribe",
      fetchImpl: vi.fn(async () => new Response(body, { status: 200 })),
    });
    const error = await adapter.transcribe({ audio, mediaType: "audio/wav", signal: caller.signal })
      .catch((caught: unknown) => caught);
    if (!(error instanceof Error)) throw new Error("Expected a normalized adapter error");
    expect(error).toMatchObject({ code: "cancelled", message: "Transcription was cancelled" });
    expect(`${error.message}\n${error.stack ?? ""}\n${String(error.cause)}`)
      .not.toMatch(/sentinel provider abort/i);
  });

  it("does not return a completed body after caller cancellation becomes observable", async () => {
    const caller = new AbortController();
    const adapter = createOpenAiFileTranscriptionAdapter({
      apiKey: "test-platform-key",
      model: "gpt-transcribe",
      fetchImpl: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"text":"must not be delivered"}'));
          caller.abort();
          stream.close();
        },
      }), { status: 200 })),
    });

    await expect(adapter.transcribe({ audio, mediaType: "audio/wav", signal: caller.signal }))
      .rejects.toMatchObject({ code: "cancelled", message: "Transcription was cancelled" });
  });

  it("contains rejected failed-response cleanup without leaking its error", async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel: async () => {
        throw new Error("sentinel provider cleanup secret");
      },
    });
    const adapter = createOpenAiFileTranscriptionAdapter({
      apiKey: "test-platform-key",
      model: "gpt-transcribe",
      fetchImpl: vi.fn(async () => new Response(body, { status: 503 })),
    });
    const error = await adapter.transcribe({
      audio,
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpeechAdapterError);
    if (!(error instanceof Error)) throw new Error("Expected a normalized adapter error");
    expect(error).toMatchObject({ code: "request_failed", message: "Transcription request failed" });
    expect(error.cause).toBeUndefined();
    expect(`${error.message}\n${error.stack ?? ""}\n${String(error.cause)}`)
      .not.toMatch(/sentinel provider cleanup secret/i);
  });

  it("does not wait forever for failed-response or oversized-body cleanup", async () => {
    const never = new Promise<void>(() => undefined);
    const failedBody = new ReadableStream<Uint8Array>({ cancel: () => never });
    const failed = createOpenAiFileTranscriptionAdapter({
      apiKey: "test-platform-key",
      model: "gpt-transcribe",
      fetchImpl: vi.fn(async () => new Response(failedBody, { status: 503 })),
    });
    await expect(failed.transcribe({
      audio,
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "request_failed" });

    const oversizedBody = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array(65));
      },
      cancel: () => never,
    });
    const oversized = createOpenAiFileTranscriptionAdapter({
      apiKey: "test-platform-key",
      model: "gpt-transcribe",
      maxResponseBytes: 64,
      fetchImpl: vi.fn(async () => new Response(oversizedBody, { status: 200 })),
    });
    await expect(oversized.transcribe({
      audio,
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "invalid_response" });
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
