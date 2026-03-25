import { describe, it, expect, vi, afterEach } from "vitest";

import { WhisperSttProvider } from "../../../../packages/gateway/src/voice/stt/whisper.js";

describe("WhisperSttProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("transcribe() sends correct multipart request to OpenAI Whisper API", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ text: "Hello world", language: "en", duration: 2.5 }),
    });

    const provider = new WhisperSttProvider({ apiKey: "sk-test" });
    const audio = Buffer.from("fake-audio-data");
    await provider.transcribe(audio);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const url = fetchCall[0] as string;
    const opts = fetchCall[1] as RequestInit;

    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(opts.method).toBe("POST");
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer sk-test",
    );
    expect(opts.body).toBeInstanceOf(FormData);

    const formData = opts.body as FormData;
    expect(formData.get("model")).toBe("whisper-1");
    expect(formData.get("response_format")).toBe("verbose_json");
    expect(formData.get("file")).toBeInstanceOf(Blob);
  });

  it("transcribe() returns { text, language, durationMs } from API response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          text: "Transcribed text here",
          language: "sv",
          duration: 3.2,
        }),
    });

    const provider = new WhisperSttProvider({ apiKey: "sk-test" });
    const result = await provider.transcribe(Buffer.from("audio"));

    expect(result.text).toBe("Transcribed text here");
    expect(result.language).toBe("sv");
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("transcribe() with language hint includes language in form data", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ text: "Hej", language: "sv", duration: 1.0 }),
    });

    const provider = new WhisperSttProvider({ apiKey: "sk-test" });
    await provider.transcribe(Buffer.from("audio"), { language: "sv" });

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const formData = (fetchCall[1] as RequestInit).body as FormData;
    expect(formData.get("language")).toBe("sv");
  });

  it("transcribe() throws on 401 (auth error) with clear message", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });

    const provider = new WhisperSttProvider({ apiKey: "bad-key" });
    await expect(provider.transcribe(Buffer.from("audio"))).rejects.toThrow(
      /Whisper STT auth error: invalid API key/,
    );
  });

  it("transcribe() throws on 429 (rate limit) with clear message", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve("Too Many Requests"),
    });

    const provider = new WhisperSttProvider({ apiKey: "sk-test" });
    await expect(provider.transcribe(Buffer.from("audio"))).rejects.toThrow(
      /Whisper STT rate limited: too many requests/,
    );
  });

  it("transcribe() throws on 500 (server error) with clear message", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const provider = new WhisperSttProvider({ apiKey: "sk-test" });
    await expect(provider.transcribe(Buffer.from("audio"))).rejects.toThrow(
      /Whisper STT error \(status 500\)/,
    );
  });

  it("transcribe() rejects files > 25MB with clear error (no API call)", async () => {
    globalThis.fetch = vi.fn();

    const provider = new WhisperSttProvider({ apiKey: "sk-test" });
    const largeBuffer = Buffer.alloc(26 * 1024 * 1024);

    await expect(provider.transcribe(largeBuffer)).rejects.toThrow(
      /exceeds 25MB Whisper limit/,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("isAvailable() returns true when OPENAI_API_KEY is set", () => {
    const provider = new WhisperSttProvider({ apiKey: "sk-123" });
    expect(provider.isAvailable()).toBe(true);
  });

  it("isAvailable() returns false when no API key", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const provider = new WhisperSttProvider();
    expect(provider.isAvailable()).toBe(false);
  });

  it("transcribe() handles response with no language field gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: "Hello", duration: 1.5 }),
    });

    const provider = new WhisperSttProvider({ apiKey: "sk-test" });
    const result = await provider.transcribe(Buffer.from("audio"));

    expect(result.text).toBe("Hello");
    expect(result.language).toBe("en");
    expect(result.confidence).toBeUndefined();
  });
});
