import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type {
  TtsProvider,
  TtsOptions,
  TtsResult,
} from "../../../../packages/gateway/src/voice/tts/base.js";
import { FallbackTtsChain } from "../../../../packages/gateway/src/voice/tts/fallback.js";
import { ElevenLabsTtsProvider } from "../../../../packages/gateway/src/voice/tts/elevenlabs.js";
import { OpenAiTtsProvider } from "../../../../packages/gateway/src/voice/tts/openai.js";
import { EdgeTtsProvider } from "../../../../packages/gateway/src/voice/tts/edge-tts.js";

function makeMockProvider(
  name: string,
  opts: {
    available?: boolean;
    result?: TtsResult;
    error?: Error;
  } = {},
): TtsProvider & { synthesize: ReturnType<typeof vi.fn> } {
  const available = opts.available ?? true;
  const result: TtsResult = opts.result ?? {
    audio: Buffer.from("audio-data"),
    format: "mp3",
    sampleRate: 44100,
    durationMs: 1000,
    provider: name,
  };

  return {
    name,
    isAvailable: () => available,
    synthesize: vi.fn().mockImplementation(async () => {
      if (opts.error) throw opts.error;
      return result;
    }),
  };
}

describe("FallbackTtsChain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tries providers in order, first success returns immediately", async () => {
    const p1 = makeMockProvider("p1");
    const p2 = makeMockProvider("p2");
    const p3 = makeMockProvider("p3");

    const chain = new FallbackTtsChain([p1, p2, p3]);
    const result = await chain.synthesize("hello");

    expect(result.provider).toBe("p1");
    expect(p1.synthesize).toHaveBeenCalledOnce();
    expect(p2.synthesize).not.toHaveBeenCalled();
    expect(p3.synthesize).not.toHaveBeenCalled();
  });

  it("first provider throws -> tries second provider", async () => {
    const p1 = makeMockProvider("p1", { error: new Error("p1 failed") });
    const p2 = makeMockProvider("p2");

    const chain = new FallbackTtsChain([p1, p2]);
    const result = await chain.synthesize("hello");

    expect(result.provider).toBe("p2");
    expect(p1.synthesize).toHaveBeenCalledOnce();
    expect(p2.synthesize).toHaveBeenCalledOnce();
  });

  it("first two throw -> tries third, succeeds", async () => {
    const p1 = makeMockProvider("p1", { error: new Error("p1 failed") });
    const p2 = makeMockProvider("p2", { error: new Error("p2 failed") });
    const p3 = makeMockProvider("p3");

    const chain = new FallbackTtsChain([p1, p2, p3]);
    const result = await chain.synthesize("hello");

    expect(result.provider).toBe("p3");
    expect(p1.synthesize).toHaveBeenCalledOnce();
    expect(p2.synthesize).toHaveBeenCalledOnce();
    expect(p3.synthesize).toHaveBeenCalledOnce();
  });

  it("all providers throw -> throws error with combined info", async () => {
    const p1 = makeMockProvider("p1", { error: new Error("p1 failed") });
    const p2 = makeMockProvider("p2", { error: new Error("p2 failed") });

    const chain = new FallbackTtsChain([p1, p2]);

    await expect(chain.synthesize("hello")).rejects.toThrow(
      /All TTS providers failed/,
    );
    await expect(chain.synthesize("hello")).rejects.toThrow(/All TTS providers failed/);
  });

  it("provider with isAvailable()=false is skipped entirely", async () => {
    const p1 = makeMockProvider("p1", { available: false });
    const p2 = makeMockProvider("p2");

    const chain = new FallbackTtsChain([p1, p2]);
    const result = await chain.synthesize("hello");

    expect(result.provider).toBe("p2");
    expect(p1.synthesize).not.toHaveBeenCalled();
    expect(p2.synthesize).toHaveBeenCalledOnce();
  });

  it("circuit breaker: after 3 consecutive failures, provider is skipped", async () => {
    const p1 = makeMockProvider("p1", { error: new Error("p1 down") });
    const p2 = makeMockProvider("p2");

    const chain = new FallbackTtsChain([p1, p2], {
      circuitBreakerThreshold: 3,
      circuitBreakerResetMs: 60_000,
    });

    // 3 failures to trip the circuit
    await chain.synthesize("a");
    await chain.synthesize("b");
    await chain.synthesize("c");

    expect(p1.synthesize).toHaveBeenCalledTimes(3);

    // 4th call: p1 circuit is open, should skip directly to p2
    p1.synthesize.mockClear();
    await chain.synthesize("d");

    expect(p1.synthesize).not.toHaveBeenCalled();
    expect(p2.synthesize).toHaveBeenCalled();
  });

  it("circuit breaker recovery: after 60s elapsed, provider is retried", async () => {
    const p1Error = new Error("p1 down");
    const p1 = makeMockProvider("p1", { error: p1Error });
    const p2 = makeMockProvider("p2");

    const chain = new FallbackTtsChain([p1, p2], {
      circuitBreakerThreshold: 3,
      circuitBreakerResetMs: 60_000,
    });

    // Trip the circuit
    await chain.synthesize("a");
    await chain.synthesize("b");
    await chain.synthesize("c");

    expect(p1.synthesize).toHaveBeenCalledTimes(3);
    p1.synthesize.mockClear();

    // Advance time past reset window
    vi.advanceTimersByTime(61_000);

    // Now p1 should be retried (it will fail again, but it should be called)
    await chain.synthesize("d");
    expect(p1.synthesize).toHaveBeenCalledOnce();
  });

  it("configurable timeout per provider (default 5s)", async () => {
    const slowProvider: TtsProvider & {
      synthesize: ReturnType<typeof vi.fn>;
    } = {
      name: "slow",
      isAvailable: () => true,
      synthesize: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  audio: Buffer.from("data"),
                  format: "mp3" as const,
                  sampleRate: 44100,
                  durationMs: 1000,
                  provider: "slow",
                }),
              10_000,
            );
          }),
      ),
    };
    const p2 = makeMockProvider("p2");

    const chain = new FallbackTtsChain([slowProvider, p2], {
      timeoutMs: 5000,
    });

    const resultPromise = chain.synthesize("hello");

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(5001);

    const result = await resultPromise;
    expect(result.provider).toBe("p2");
  });

  it("empty text input throws validation error", async () => {
    const p1 = makeMockProvider("p1");
    const chain = new FallbackTtsChain([p1]);

    await expect(chain.synthesize("")).rejects.toThrow(
      /Text is required for TTS/,
    );
    expect(p1.synthesize).not.toHaveBeenCalled();
  });

  it("onUsage callback called with provider, chars, cost on success", async () => {
    const onUsage = vi.fn();
    const p1 = makeMockProvider("p1");

    const chain = new FallbackTtsChain([p1], { onUsage });
    await chain.synthesize("hello world");

    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledWith({
      provider: "p1",
      chars: 11,
      cost: expect.any(Number),
    });
  });

  it("getStatus() returns health map for each provider", async () => {
    const p1 = makeMockProvider("p1", { error: new Error("down") });
    const p2 = makeMockProvider("p2");
    const p3 = makeMockProvider("p3", { available: false });

    const chain = new FallbackTtsChain([p1, p2, p3], {
      circuitBreakerThreshold: 3,
      circuitBreakerResetMs: 60_000,
    });

    // Trip p1's circuit breaker
    await chain.synthesize("a");
    await chain.synthesize("b");
    await chain.synthesize("c");

    const status = chain.getStatus();

    expect(status).toHaveLength(3);

    expect(status[0]).toEqual({
      name: "p1",
      available: true,
      circuitOpen: true,
    });
    expect(status[1]).toEqual({
      name: "p2",
      available: true,
      circuitOpen: false,
    });
    expect(status[2]).toEqual({
      name: "p3",
      available: false,
      circuitOpen: false,
    });
  });

  it("isAvailable() returns true if any provider is available", () => {
    const p1 = makeMockProvider("p1", { available: false });
    const p2 = makeMockProvider("p2", { available: true });

    const chain = new FallbackTtsChain([p1, p2]);
    expect(chain.isAvailable()).toBe(true);
  });

  it("isAvailable() returns false if no provider is available", () => {
    const p1 = makeMockProvider("p1", { available: false });
    const p2 = makeMockProvider("p2", { available: false });

    const chain = new FallbackTtsChain([p1, p2]);
    expect(chain.isAvailable()).toBe(false);
  });

  it("success resets circuit breaker for that provider", async () => {
    let callCount = 0;
    const p1: TtsProvider & { synthesize: ReturnType<typeof vi.fn> } = {
      name: "p1",
      isAvailable: () => true,
      synthesize: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) throw new Error("transient");
        return {
          audio: Buffer.from("data"),
          format: "mp3" as const,
          sampleRate: 44100,
          durationMs: 1000,
          provider: "p1",
        };
      }),
    };
    const p2 = makeMockProvider("p2");

    const chain = new FallbackTtsChain([p1, p2], {
      circuitBreakerThreshold: 3,
    });

    // 2 failures (below threshold)
    await chain.synthesize("a");
    await chain.synthesize("b");

    // 3rd call succeeds on p1 -> circuit should reset
    const result = await chain.synthesize("c");
    expect(result.provider).toBe("p1");

    // Verify circuit is reset by checking status
    const status = chain.getStatus();
    expect(status[0]!.circuitOpen).toBe(false);
  });
});

describe("ElevenLabsTtsProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("calls correct URL with xi-api-key header, returns MP3 buffer", async () => {
    const audioData = Buffer.from("fake-mp3-audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioData.buffer),
    });

    const provider = new ElevenLabsTtsProvider({ apiKey: "test-key" });
    const result = await provider.synthesize("Hello world");

    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.format).toBe("mp3");
    expect(result.provider).toBe("elevenlabs");

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const url = fetchCall[0] as string;
    const opts = fetchCall[1] as RequestInit;

    expect(url).toContain("https://api.elevenlabs.io/v1/text-to-speech/");
    expect((opts.headers as Record<string, string>)["xi-api-key"]).toBe(
      "test-key",
    );
    expect(url).toContain("output_format=mp3_44100_128");
    expect(opts.method).toBe("POST");

    const body = JSON.parse(opts.body as string);
    expect(body.text).toBe("Hello world");
  });

  it("isAvailable() returns false when no ELEVENLABS_API_KEY", () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    const provider = new ElevenLabsTtsProvider();
    expect(provider.isAvailable()).toBe(false);
  });

  it("isAvailable() returns true when ELEVENLABS_API_KEY is set", () => {
    const provider = new ElevenLabsTtsProvider({ apiKey: "key-123" });
    expect(provider.isAvailable()).toBe(true);
  });

  it("throws on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });

    const provider = new ElevenLabsTtsProvider({ apiKey: "bad-key" });
    await expect(provider.synthesize("hello")).rejects.toThrow(
      /ElevenLabs TTS error: 401/,
    );
  });

  it("uses custom voice and model from options", async () => {
    const audioData = Buffer.from("audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioData.buffer),
    });

    const provider = new ElevenLabsTtsProvider({ apiKey: "key" });
    await provider.synthesize("test", {
      voice: "custom-voice-id",
      model: "eleven_multilingual_v2",
    });

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const url = fetchCall[0] as string;
    const opts = fetchCall[1] as RequestInit;

    expect(url).toContain("custom-voice-id");
    const body = JSON.parse(opts.body as string);
    expect(body.model_id).toBe("eleven_multilingual_v2");
  });
});

describe("OpenAiTtsProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("calls correct URL with Bearer auth, returns MP3 buffer", async () => {
    const audioData = Buffer.from("fake-mp3-audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioData.buffer),
    });

    const provider = new OpenAiTtsProvider({ apiKey: "sk-test" });
    const result = await provider.synthesize("Hello world");

    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.format).toBe("mp3");
    expect(result.provider).toBe("openai");

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const url = fetchCall[0] as string;
    const opts = fetchCall[1] as RequestInit;

    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer sk-test",
    );
    expect(opts.method).toBe("POST");

    const body = JSON.parse(opts.body as string);
    expect(body.input).toBe("Hello world");
    expect(body.model).toBe("tts-1");
    expect(body.voice).toBe("alloy");
    expect(body.response_format).toBe("mp3");
  });

  it("isAvailable() returns false when no OPENAI_API_KEY", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const provider = new OpenAiTtsProvider();
    expect(provider.isAvailable()).toBe(false);
  });

  it("isAvailable() returns true when OPENAI_API_KEY is set", () => {
    const provider = new OpenAiTtsProvider({ apiKey: "sk-123" });
    expect(provider.isAvailable()).toBe(true);
  });

  it("throws on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    });

    const provider = new OpenAiTtsProvider({ apiKey: "sk-test" });
    await expect(provider.synthesize("hello")).rejects.toThrow(
      /OpenAI TTS error: 429/,
    );
  });

  it("uses custom voice from options", async () => {
    const audioData = Buffer.from("audio");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioData.buffer),
    });

    const provider = new OpenAiTtsProvider({ apiKey: "sk-test" });
    await provider.synthesize("test", { voice: "nova" });

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const opts = fetchCall[1] as RequestInit;
    const body = JSON.parse(opts.body as string);
    expect(body.voice).toBe("nova");
  });
});

describe("EdgeTtsProvider", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("isAvailable() always returns true", () => {
    const provider = new EdgeTtsProvider();
    expect(provider.isAvailable()).toBe(true);
  });

  it("returns audio buffer from edge-tts", async () => {
    const fakeAudio = Buffer.from("edge-audio-data");
    const mockTtsPromise = vi.fn().mockImplementation(async (_text: string, path: string) => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, fakeAudio);
    });

    vi.doMock("node-edge-tts", () => ({
      EdgeTTS: class {
        ttsPromise = mockTtsPromise;
      },
    }));

    const { EdgeTtsProvider: MockedEdgeTts } = await import(
      "../../../../packages/gateway/src/voice/tts/edge-tts.js"
    );
    const provider = new MockedEdgeTts();
    const result = await provider.synthesize("Hello");

    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.format).toBe("mp3");
    expect(result.provider).toBe("edge");
    expect(mockTtsPromise).toHaveBeenCalledWith("Hello", expect.any(String));

    vi.doUnmock("node-edge-tts");
  });

  it("uses default voice en-US-AriaNeural", async () => {
    const constructorArgs: Record<string, unknown>[] = [];
    const mockTtsPromise = vi.fn().mockImplementation(async (_text: string, path: string) => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, Buffer.from("audio"));
    });

    vi.doMock("node-edge-tts", () => ({
      EdgeTTS: class {
        ttsPromise = mockTtsPromise;
        constructor(opts?: Record<string, unknown>) {
          if (opts) constructorArgs.push(opts);
        }
      },
    }));

    const { EdgeTtsProvider: MockedEdgeTts } = await import(
      "../../../../packages/gateway/src/voice/tts/edge-tts.js"
    );
    const provider = new MockedEdgeTts();
    await provider.synthesize("test");

    expect(constructorArgs[0]).toEqual(
      expect.objectContaining({ voice: "en-US-AriaNeural" }),
    );

    vi.doUnmock("node-edge-tts");
  });
});
