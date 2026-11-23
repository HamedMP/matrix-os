// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  platformSpeechControlState,
  SPEECH_LIMIT_STOP_CANCEL_GUARD_MS,
  speechLimitStopDelayMs,
  usePlatformSpeechDraft,
} from "../../packages/ui/src/speech/use-platform-speech-draft.js";
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

  it("exposes the server-authoritative Preview dictation quota", async () => {
    const previewReady = {
      ...ready,
      previewQuota: {
        mode: "preview" as const,
        requestLimit: 3,
        requestsUsed: 1,
        requestsRemaining: 2,
        maxConcurrency: 1 as const,
        expiresAt: "2026-10-20T16:00:00.000Z",
      },
    };
    const capabilities = vi.fn()
      .mockResolvedValueOnce(previewReady)
      .mockResolvedValue({ ...previewReady, previewQuota: {
        ...previewReady.previewQuota, requestsUsed: 2, requestsRemaining: 1,
      } });
    const hook = renderHook(() => usePlatformSpeechDraft({
      scopeKey: "chat-preview",
      client: client({ capabilities }),
      captureAdapter: captureAdapter(),
      onDraft: vi.fn(),
      requestIdFactory: () => requestId,
    }));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    expect(hook.result.current.previewQuota).toEqual(previewReady.previewQuota);
    await act(async () => hook.result.current.start());
    act(() => hook.result.current.stop());
    await waitFor(() => expect(hook.result.current.previewQuota?.requestsRemaining).toBe(1));
  });

  it("keeps recording unavailable until post-transcription quota refresh completes", async () => {
    const previewReady = {
      ...ready,
      previewQuota: {
        mode: "preview" as const,
        requestLimit: 1,
        requestsUsed: 0,
        requestsRemaining: 1,
        maxConcurrency: 1 as const,
        expiresAt: "2026-10-20T16:00:00.000Z",
      },
    };
    const exhausted = {
      ...previewReady,
      previewQuota: {
        ...previewReady.previewQuota,
        requestsUsed: 1,
        requestsRemaining: 0,
      },
    };
    const refresh = Promise.withResolvers<typeof exhausted>();
    const capabilities = vi.fn()
      .mockResolvedValueOnce(previewReady)
      .mockReturnValueOnce(refresh.promise);
    const adapter = captureAdapter();
    const hook = renderHook(() => usePlatformSpeechDraft({
      scopeKey: "chat-preview-refresh",
      client: client({ capabilities }),
      captureAdapter: adapter,
      onDraft: vi.fn(),
      requestIdFactory: () => requestId,
    }));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    await act(async () => hook.result.current.start());
    act(() => hook.result.current.stop());

    await waitFor(() => expect(capabilities).toHaveBeenCalledTimes(2));
    expect(hook.result.current.phase).toBe("loading");
    await act(async () => hook.result.current.start());
    expect(adapter.start).toHaveBeenCalledTimes(1);

    await act(async () => refresh.resolve(exhausted));
    await waitFor(() => expect(hook.result.current.phase).toBe("unavailable"));
    expect(hook.result.current.previewQuota?.requestsRemaining).toBe(0);
  });

  it("refreshes the Preview quota after a cancelled transcription settles", async () => {
    const previewReady = {
      ...ready,
      previewQuota: {
        mode: "preview" as const,
        requestLimit: 1,
        requestsUsed: 0,
        requestsRemaining: 1,
        maxConcurrency: 1 as const,
        expiresAt: "2026-10-20T16:00:00.000Z",
      },
    };
    const exhausted = {
      ...previewReady,
      previewQuota: {
        ...previewReady.previewQuota,
        requestsUsed: 1,
        requestsRemaining: 0,
      },
    };
    const cancellation = Promise.withResolvers<Awaited<ReturnType<BrowserSpeechClient["cancel"]>>>();
    const capabilities = vi.fn()
      .mockResolvedValueOnce(previewReady)
      .mockResolvedValueOnce(exhausted);
    const speech = client({
      capabilities,
      transcribe: vi.fn(({ signal }) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
      })),
      cancel: vi.fn(() => cancellation.promise),
    });
    const hook = renderHook(() => usePlatformSpeechDraft({
      scopeKey: "chat-preview-cancel",
      client: speech,
      captureAdapter: captureAdapter(),
      onDraft: vi.fn(),
      requestIdFactory: () => requestId,
    }));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    await act(async () => hook.result.current.start());
    act(() => hook.result.current.stop());
    await waitFor(() => expect(hook.result.current.phase).toBe("transcribing"));

    act(() => hook.result.current.cancel());
    expect(hook.result.current.phase).toBe("loading");
    expect(capabilities).toHaveBeenCalledTimes(1);
    await act(async () => cancellation.resolve({
      contractVersion: 1,
      requestId,
      executionState: "cancelled",
      cancellationRequested: true,
      executionStarted: true,
    }));

    await waitFor(() => expect(capabilities).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.phase).toBe("unavailable"));
    expect(hook.result.current.previewQuota?.requestsRemaining).toBe(0);
  });

  it("makes exhausted Preview dictation unavailable while preserving the quota", async () => {
    const exhausted = {
      ...ready,
      previewQuota: {
        mode: "preview" as const,
        requestLimit: 2,
        requestsUsed: 2,
        requestsRemaining: 0,
        maxConcurrency: 1 as const,
        expiresAt: "2026-10-20T16:00:00.000Z",
      },
    };
    const hook = renderHook(() => usePlatformSpeechDraft({
      scopeKey: "chat-preview-exhausted",
      client: client({ capabilities: vi.fn().mockResolvedValue(exhausted) }),
      captureAdapter: captureAdapter(),
      onDraft: vi.fn(),
    }));
    await waitFor(() => expect(hook.result.current.phase).toBe("unavailable"));
    expect(hook.result.current.isSupported).toBe(false);
    expect(hook.result.current.previewQuota).toEqual(exhausted.previewQuota);
  });

  it("fails closed on a stale post-transcription quota and retries capability refresh", async () => {
    const previewReady = {
      ...ready,
      previewQuota: {
        mode: "preview" as const,
        requestLimit: 1,
        requestsUsed: 0,
        requestsRemaining: 1,
        maxConcurrency: 1 as const,
        expiresAt: "2026-10-20T16:00:00.000Z",
      },
    };
    const exhausted = {
      ...previewReady,
      previewQuota: {
        ...previewReady.previewQuota,
        requestsUsed: 1,
        requestsRemaining: 0,
      },
    };
    const capabilities = vi.fn()
      .mockResolvedValueOnce(previewReady)
      .mockRejectedValueOnce(new Error("private refresh detail"))
      .mockResolvedValueOnce(exhausted);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hook = renderHook(() => usePlatformSpeechDraft({
      scopeKey: "chat-preview-stale",
      client: client({ capabilities }),
      captureAdapter: captureAdapter(),
      onDraft: vi.fn(),
      requestIdFactory: () => requestId,
    }));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    await act(async () => hook.result.current.start());
    act(() => hook.result.current.stop());

    await waitFor(() => expect(hook.result.current.capabilitiesStale).toBe(true));
    expect(hook.result.current.phase).toBe("unavailable");
    expect(hook.result.current.isSupported).toBe(false);
    expect(hook.result.current.previewQuota).toEqual(previewReady.previewQuota);
    await act(async () => hook.result.current.retryCapabilities());
    await waitFor(() => expect(hook.result.current.capabilitiesStale).toBe(false));
    expect(hook.result.current.previewQuota).toEqual(exhausted.previewQuota);
    expect(hook.result.current.phase).toBe("unavailable");
    expect(warn).toHaveBeenCalledWith("[speech-draft] quota refresh failed", "Error");
    expect(warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("private refresh detail"));
  });

  it("keeps the retry control visible when customer speech capabilities become stale", async () => {
    const capabilities = vi.fn()
      .mockResolvedValueOnce(ready)
      .mockRejectedValueOnce(new Error("private refresh detail"))
      .mockResolvedValueOnce(ready);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hook = renderHook(() => usePlatformSpeechDraft({
      scopeKey: "chat-customer-stale",
      client: client({ capabilities }),
      captureAdapter: captureAdapter(),
      onDraft: vi.fn(),
      requestIdFactory: () => requestId,
    }));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    await act(async () => hook.result.current.start());
    act(() => hook.result.current.stop());

    await waitFor(() => expect(hook.result.current.capabilitiesStale).toBe(true));
    expect(hook.result.current.previewQuota).toBeUndefined();
    expect(platformSpeechControlState(hook.result.current)).toMatchObject({
      disabled: false,
      label: "Retry speech availability",
      visible: true,
    });
    await act(async () => hook.result.current.retryCapabilities());
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
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

  it("reports the longest dictation the policy records so the composer can show it", async () => {
    const tenMinutes = {
      ...ready,
      fileTranscription: {
        ...ready.fileTranscription,
        dictation: { ...ready.fileTranscription.dictation, maxDurationMs: 600_000 },
      },
    };
    const hook = renderHook(() => usePlatformSpeechDraft({
      scopeKey: "chat-limit",
      client: client({ capabilities: vi.fn(async () => tenMinutes) }),
      captureAdapter: captureAdapter(),
      onDraft: vi.fn(),
      requestIdFactory: () => requestId,
    }));
    expect(hook.result.current.maxDurationMs).toBeNull();
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    expect(hook.result.current.maxDurationMs).toBe(600_000);
  });

  it("keeps a dictation that the duration limit stopped when a stop click lands as a cancel", async () => {
    // The limit turns "Stop recording" into "Cancel transcription" under the
    // pointer; a click meant to stop used to discard the whole recording.
    const shortLimit = {
      ...ready,
      fileTranscription: {
        ...ready.fileTranscription,
        dictation: { ...ready.fileTranscription.dictation, maxDurationMs: 30 },
      },
    };
    const transcription = Promise.withResolvers<Awaited<ReturnType<BrowserSpeechClient["transcribe"]>>>();
    const speech = client({
      capabilities: vi.fn(async () => shortLimit),
      transcribe: vi.fn(() => transcription.promise),
    });
    const onDraft = vi.fn();
    const hook = renderHook(() => usePlatformSpeechDraft({
      scopeKey: "chat-limit-stop",
      client: speech,
      captureAdapter: captureAdapter(),
      onDraft,
      requestIdFactory: () => requestId,
    }));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    await act(async () => hook.result.current.start());
    await waitFor(() => expect(hook.result.current.phase).toBe("transcribing"));

    act(() => hook.result.current.cancel());
    expect(hook.result.current.phase).toBe("transcribing");
    expect(speech.cancel).not.toHaveBeenCalled();

    await act(async () => transcription.resolve({
      contractVersion: 1,
      requestId,
      status: "succeeded",
      outcome: "transcript",
      text: "the whole dictation",
      audioDurationMs: 30,
    }));
    await waitFor(() => expect(onDraft).toHaveBeenCalledWith("the whole dictation"));
  });

  it("still cancels a limit-stopped transcription once the accidental-click window has passed", async () => {
    const shortLimit = {
      ...ready,
      fileTranscription: {
        ...ready.fileTranscription,
        dictation: { ...ready.fileTranscription.dictation, maxDurationMs: 30 },
      },
    };
    const speech = client({
      capabilities: vi.fn(async () => shortLimit),
      transcribe: vi.fn(() => new Promise<never>(() => undefined)),
    });
    const hook = renderHook(() => usePlatformSpeechDraft({
      scopeKey: "chat-limit-cancel",
      client: speech,
      captureAdapter: captureAdapter(),
      onDraft: vi.fn(),
      requestIdFactory: () => requestId,
    }));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    await act(async () => hook.result.current.start());
    await waitFor(() => expect(hook.result.current.phase).toBe("transcribing"));

    const later = Date.now() + SPEECH_LIMIT_STOP_CANCEL_GUARD_MS + 1;
    vi.spyOn(Date, "now").mockReturnValue(later);
    act(() => hook.result.current.cancel());
    await waitFor(() => expect(speech.cancel).toHaveBeenCalledWith(requestId));
  });

  it("stops recording a second before the limit so a late timer cannot produce a rejected recording", async () => {
    // The service rejects audio even one sample over the limit; the previous
    // timer fired exactly at it.
    expect(speechLimitStopDelayMs(600_000)).toBe(599_000);
    expect(speechLimitStopDelayMs(120_000)).toBe(119_000);
    const tenMinutes = {
      ...ready,
      fileTranscription: {
        ...ready.fileTranscription,
        dictation: { ...ready.fileTranscription.dictation, maxDurationMs: 600_000 },
      },
    };
    const hook = renderHook(() => usePlatformSpeechDraft({
      scopeKey: "chat-limit-margin",
      client: client({ capabilities: vi.fn(async () => tenMinutes) }),
      captureAdapter: captureAdapter(),
      onDraft: vi.fn(),
      requestIdFactory: () => requestId,
    }));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    const timers = vi.spyOn(globalThis, "setTimeout");
    await act(async () => hook.result.current.start());
    expect(hook.result.current.phase).toBe("recording");
    const delays = timers.mock.calls.map(([, delay]) => delay);
    expect(delays).toContain(599_000);
    expect(delays).not.toContain(600_000);
    act(() => hook.result.current.cancel());
  });
});
