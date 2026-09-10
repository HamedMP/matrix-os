import { describe, expect, it, vi } from "vitest";
import {
  BrowserSpeechClientError,
  createBrowserSpeechClient,
} from "../../shell/src/lib/platform-speech-client.js";

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

describe("browser platform speech client", () => {
  it("loads provider-neutral capabilities through the current gateway scope", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(capabilities), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const client = createBrowserSpeechClient({ baseUrl: "https://app.example/vm/alice", fetcher });
    await expect(client.capabilities()).resolves.toEqual(capabilities);
    expect(fetcher).toHaveBeenCalledWith(
      "https://app.example/vm/alice/api/speech/capabilities",
      expect.objectContaining({ method: "GET", cache: "no-store", credentials: "include" }),
    );
  });

  it("sends one recording without provider fields and returns an editable transcript", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect([...form.keys()].sort()).toEqual(["recording", "requestId"]);
      expect(form.get("requestId")).toBe(requestId);
      return new Response(JSON.stringify({
        contractVersion: 1,
        requestId,
        status: "succeeded",
        outcome: "transcript",
        text: "draft text",
        audioDurationMs: 1_000,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = createBrowserSpeechClient({ baseUrl: "https://app.example", fetcher });
    await expect(client.transcribe({
      requestId,
      recording: new Blob([new Uint8Array(44)], { type: "audio/wav" }),
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ outcome: "transcript", text: "draft text" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("allowlists server errors and rejects unknown payloads", async () => {
    const known = createBrowserSpeechClient({
      baseUrl: "https://app.example",
      fetcher: vi.fn(async () => new Response(
        JSON.stringify({ error: { code: "rate_limited", message: "Try speech again later" } }),
        { status: 429 },
      )),
    });
    await expect(known.capabilities()).rejects.toMatchObject({
      code: "rate_limited",
      safeMessage: "Try speech again later",
    });

    const unknown = createBrowserSpeechClient({
      baseUrl: "https://app.example",
      fetcher: vi.fn(async () => new Response(JSON.stringify({ error: "postgresql://private" }), { status: 500 })),
    });
    const error = await unknown.capabilities().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BrowserSpeechClientError);
    expect(error).toMatchObject({ code: "unavailable", safeMessage: "Speech is unavailable" });
    expect(JSON.stringify(error)).not.toMatch(/postgresql|private/i);
  });
});
