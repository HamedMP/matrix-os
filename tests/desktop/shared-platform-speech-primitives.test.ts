// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  createBrowserSpeechClient,
  encodePcm16Wav,
  resolveSpeechWorkletUrl,
} from "@matrix-os/ui";

describe("shared platform speech browser primitives", () => {
  it("scopes Electron requests to the selected runtime without exposing credentials", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      contractVersion: 1,
      fileTranscription: {
        status: "unavailable",
        reason: "disabled",
        dictation: { enabled: true, maxBytes: 1_024, maxDurationMs: 1_000, maxTranscriptChars: 100, supportedMediaTypes: ["audio/wav"], languageHints: false },
        ownerAudio: { enabled: false },
      },
    })));
    const client = createBrowserSpeechClient({
      baseUrl: "https://app.matrix-os.com/vm/alice",
      runtimeSlot: "studio",
      fetcher,
    });

    await client.capabilities();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://app.matrix-os.com/vm/alice/api/speech/capabilities?runtime=studio");
    expect(init?.headers).toEqual({ accept: "application/json" });
  });

  it("encodes PCM WAV and resolves a packaged-renderer-relative worklet", () => {
    expect(encodePcm16Wav([new Int16Array([1, -1])], 16_000).type).toBe("audio/wav");
    expect(resolveSpeechWorkletUrl("file:///Applications/Matrix%20OS/resources/app.asar/out/renderer/index.html"))
      .toBe("file:///Applications/Matrix%20OS/resources/app.asar/out/renderer/speech-pcm-capture-worklet.js");
  });
});
