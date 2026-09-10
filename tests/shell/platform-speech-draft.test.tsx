// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePlatformSpeechDraft } from "../../packages/ui/src/speech/use-platform-speech-draft.js";
import type { PlatformSpeechCaptureAdapter } from "../../packages/ui/src/speech/use-platform-speech-draft.js";
import type { BrowserSpeechClient } from "../../shell/src/lib/platform-speech-client.js";

const requestId = "sp_1788998400000_abcdefghijklmnop";
const ready = {
  contractVersion: 1 as const,
  fileTranscription: {
    status: "ready" as const,
    dictation: {
      enabled: true as const,
      maxBytes: 1_024,
      maxDurationMs: 120_000,
      maxTranscriptChars: 32_000,
      supportedMediaTypes: ["audio/wav" as const],
      languageHints: false,
    },
    ownerAudio: { enabled: false as const },
  },
};

function captureAdapter(): PlatformSpeechCaptureAdapter {
  return {
    isSupported: () => true,
    start: vi.fn(async () => ({
      stop: vi.fn(async () => new Blob([new Uint8Array(44)], { type: "audio/wav" })),
      cancel: vi.fn(async () => undefined),
    })),
  };
}

function client(overrides: Partial<BrowserSpeechClient> = {}): BrowserSpeechClient {
  return {
    capabilities: vi.fn(async () => ready),
    transcribe: vi.fn(async () => ({
      contractVersion: 1,
      requestId,
      status: "succeeded",
      outcome: "transcript",
      text: "editable draft",
      audioDurationMs: 1_000,
    })),
    cancel: vi.fn(async () => ({
      contractVersion: 1,
      requestId,
      executionState: "cancelled",
      cancellationRequested: true,
      executionStarted: true,
    })),
    ...overrides,
  };
}

describe("platform speech draft recording", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("records, stops, transcribes once, and inserts an editable draft without sending", async () => {
    const speech = client();
    const onDraft = vi.fn();
    const hook = renderHook(() => usePlatformSpeechDraft({
      scopeKey: "chat-1",
      client: speech,
      captureAdapter: captureAdapter(),
      onDraft,
      requestIdFactory: () => requestId,
    }));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    await act(async () => hook.result.current.start());
    expect(hook.result.current.phase).toBe("recording");
    act(() => hook.result.current.stop());
    await waitFor(() => expect(onDraft).toHaveBeenCalledWith("editable draft"));
    expect(hook.result.current.phase).toBe("idle");
    expect(speech.transcribe).toHaveBeenCalledTimes(1);
  });

  it("fences late transcripts when the active chat changes and cancels the operation", async () => {
    let resolve!: (value: Awaited<ReturnType<BrowserSpeechClient["transcribe"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<BrowserSpeechClient["transcribe"]>>>((done) => { resolve = done; });
    const speech = client({ transcribe: vi.fn(async () => pending) });
    const onDraft = vi.fn();
    const hook = renderHook(({ scopeKey }) => usePlatformSpeechDraft({
      scopeKey,
      client: speech,
      captureAdapter: captureAdapter(),
      onDraft,
      requestIdFactory: () => requestId,
    }), { initialProps: { scopeKey: "chat-1" } });
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    await act(async () => hook.result.current.start());
    act(() => hook.result.current.stop());
    await waitFor(() => expect(hook.result.current.phase).toBe("transcribing"));
    hook.rerender({ scopeKey: "chat-2" });
    resolve({
      contractVersion: 1,
      requestId,
      status: "succeeded",
      outcome: "transcript",
      text: "stale text",
      audioDurationMs: 1_000,
    });
    await waitFor(() => expect(speech.cancel).toHaveBeenCalledWith(requestId));
    expect(onDraft).not.toHaveBeenCalled();
  });

  it("does not expose recording controls when platform capability is unavailable", async () => {
    const speech = client({
      capabilities: vi.fn(async () => ({
        ...ready,
        fileTranscription: { ...ready.fileTranscription, status: "unavailable", reason: "disabled" },
      })),
    });
    const hook = renderHook(() => usePlatformSpeechDraft({
      scopeKey: "chat-1",
      client: speech,
      captureAdapter: { isSupported: () => false, start: vi.fn() },
      onDraft: vi.fn(),
    }));
    await waitFor(() => expect(hook.result.current.phase).toBe("unavailable"));
    expect(hook.result.current.isSupported).toBe(false);
    await act(async () => hook.result.current.start());
    expect(hook.result.current.phase).toBe("unavailable");
  });
});
