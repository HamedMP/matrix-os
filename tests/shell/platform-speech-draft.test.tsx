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

  it("keeps a safe draft-commit error when the destination revision changed", async () => {
    const onDraft = vi.fn(() => "Your draft changed while the recording was transcribed");
    const hook = renderHook(() => usePlatformSpeechDraft({
      scopeKey: "chat-1",
      client: client(),
      captureAdapter: captureAdapter(),
      onDraft,
      requestIdFactory: () => requestId,
    }));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    await act(async () => hook.result.current.start());
    act(() => hook.result.current.stop());

    await waitFor(() => expect(hook.result.current.phase).toBe("error"));
    expect(hook.result.current.error).toBe("Your draft changed while the recording was transcribed");
    expect(onDraft).toHaveBeenCalledTimes(1);
  });

  it("publishes current input level only while the active recording owns the microphone", async () => {
    let emitLevel: ((level: number) => void) | undefined;
    const adapter: PlatformSpeechCaptureAdapter = {
      isSupported: () => true,
      start: vi.fn(async (input) => {
        emitLevel = input.onLevel;
        return {
          stop: vi.fn(async () => new Blob([new Uint8Array(44)], { type: "audio/wav" })),
          cancel: vi.fn(async () => undefined),
        };
      }),
    };
    const hook = renderHook(() => usePlatformSpeechDraft({
      scopeKey: "chat-1",
      client: client(),
      captureAdapter: adapter,
      onDraft: vi.fn(),
      requestIdFactory: () => requestId,
    }));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    await act(async () => hook.result.current.start());

    act(() => emitLevel?.(0.72));
    expect(hook.result.current.inputLevel).toBe(0.72);
    expect(hook.result.current.inputLevelSequence).toBe(1);
    act(() => emitLevel?.(0.72));
    expect(hook.result.current.inputLevelSequence).toBe(2);
    act(() => hook.result.current.stop());
    await waitFor(() => expect(hook.result.current.inputLevel).toBe(0));
    expect(hook.result.current.inputLevelSequence).toBe(0);

    act(() => emitLevel?.(0.95));
    expect(hook.result.current.inputLevel).toBe(0);
  });

  it("ends recording immediately when the capture adapter reports a terminal buffer error", async () => {
    let reportError: ((error: unknown) => void) | undefined;
    const cancel = vi.fn(async () => undefined);
    const adapter: PlatformSpeechCaptureAdapter = {
      isSupported: () => true,
      start: vi.fn(async (input) => {
        reportError = input.onError;
        return {
          stop: vi.fn(async () => new Blob([new Uint8Array(44)], { type: "audio/wav" })),
          cancel,
        };
      }),
    };
    const hook = renderHook(() => usePlatformSpeechDraft({
      scopeKey: "chat-1",
      client: client(),
      captureAdapter: adapter,
      onDraft: vi.fn(),
      requestIdFactory: () => requestId,
    }));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    await act(async () => hook.result.current.start());

    act(() => reportError?.(new Error("buffer changed")));

    expect(hook.result.current.phase).toBe("error");
    expect(hook.result.current.error).toBe("This recording cannot be transcribed");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("admits only one microphone request when start is invoked twice before rendering settles", async () => {
    const permission = Promise.withResolvers<Awaited<ReturnType<PlatformSpeechCaptureAdapter["start"]>>>();
    const adapter: PlatformSpeechCaptureAdapter = {
      isSupported: () => true,
      start: vi.fn(() => permission.promise),
    };
    const hook = renderHook(() => usePlatformSpeechDraft({
      scopeKey: "chat-1",
      client: client(),
      captureAdapter: adapter,
      onDraft: vi.fn(),
      requestIdFactory: () => requestId,
    }));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = hook.result.current.start();
      second = hook.result.current.start();
    });
    expect(adapter.start).toHaveBeenCalledTimes(1);
    permission.resolve({
      stop: vi.fn(async () => new Blob([new Uint8Array(44)], { type: "audio/wav" })),
      cancel: vi.fn(async () => undefined),
    });
    await act(async () => Promise.all([first, second]));
    expect(hook.result.current.phase).toBe("recording");
    act(() => hook.result.current.cancel());
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

  it("contains stale microphone cleanup failures after the active chat changes", async () => {
    let resolveCapture!: (capture: Awaited<ReturnType<PlatformSpeechCaptureAdapter["start"]>>) => void;
    const pendingCapture = new Promise<Awaited<ReturnType<PlatformSpeechCaptureAdapter["start"]>>>((resolve) => {
      resolveCapture = resolve;
    });
    const cleanupError = new Error("private microphone cleanup detail");
    const capture = {
      stop: vi.fn(async () => new Blob([new Uint8Array(44)], { type: "audio/wav" })),
      cancel: vi.fn(async () => { throw cleanupError; }),
    };
    const adapter: PlatformSpeechCaptureAdapter = {
      isSupported: () => true,
      start: vi.fn(async () => pendingCapture),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hook = renderHook(({ scopeKey }) => usePlatformSpeechDraft({
      scopeKey,
      client: client(),
      captureAdapter: adapter,
      onDraft: vi.fn(),
    }), { initialProps: { scopeKey: "chat-1" } });
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));

    let start!: Promise<void>;
    act(() => {
      start = hook.result.current.start();
    });
    await waitFor(() => expect(hook.result.current.phase).toBe("requesting_permission"));
    hook.rerender({ scopeKey: "chat-2" });
    await act(async () => {
      resolveCapture(capture);
      await expect(start).resolves.toBeUndefined();
    });
    expect(capture.cancel).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[speech-draft] microphone cleanup failed", "Error");
    expect(warn).not.toHaveBeenCalledWith(expect.anything(), cleanupError);
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
