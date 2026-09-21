"use client";

import { useEffect, useRef, useState } from "react";
import type { SpeechCapabilitiesResponse, SpeechMediaType } from "@matrix-os/contracts";

export type PlatformSpeechDraftPhase =
  | "loading"
  | "unavailable"
  | "idle"
  | "requesting_permission"
  | "recording"
  | "transcribing"
  | "error";

export type PlatformSpeechUnavailableReason =
  | "unsupported"
  | "capability_check_failed"
  | "disabled"
  | "misconfigured"
  | "funding_unavailable"
  | "media_validation_unavailable"
  | "temporarily_unavailable";

export interface UsePlatformSpeechDraftResult {
  phase: PlatformSpeechDraftPhase;
  error: string | null;
  unavailableReason: PlatformSpeechUnavailableReason | null;
  isSupported: boolean;
  elapsedMs: number;
  /** Current microphone energy, normalized to the inclusive range 0..1. */
  inputLevel: number;
  /** Monotonic meter sample sequence so equal consecutive levels still render. */
  inputLevelSequence: number;
  start(): Promise<void>;
  stop(): void;
  cancel(): void;
  retryCapabilities(): void;
}

export interface PlatformSpeechRecording {
  size: number;
  type: string;
}

export interface PlatformSpeechCapture<TRecording extends PlatformSpeechRecording = Blob> {
  stop(): Promise<TRecording>;
  cancel(): Promise<void>;
}

export interface PlatformSpeechCaptureAdapter<TRecording extends PlatformSpeechRecording = Blob> {
  isSupported(): boolean;
  start(input: {
    maxBytes: number;
    signal: AbortSignal;
    onLevel?: (level: number) => void;
    onError?: (error: unknown) => void;
  }): Promise<PlatformSpeechCapture<TRecording>>;
}

export interface PlatformSpeechDraftClient<TRecording extends PlatformSpeechRecording = Blob> {
  capabilities(signal?: AbortSignal): Promise<SpeechCapabilitiesResponse>;
  transcribe(input: {
    requestId: string;
    recording: TRecording;
    signal: AbortSignal;
  }): Promise<
    | { outcome: "transcript"; text: string }
    | { outcome: "no_speech" }
  >;
  cancel(requestId: string, signal?: AbortSignal): Promise<unknown>;
}

interface ActiveRecording<TRecording extends PlatformSpeechRecording> {
  capture: PlatformSpeechCapture<TRecording>;
  generation: number;
  timeout: ReturnType<typeof setTimeout>;
  elapsedTimer: ReturnType<typeof setInterval>;
  stopping: boolean;
  maxBytes: number;
  requestId: string;
}

interface ActiveRequest {
  requestId: string;
  controller: AbortController;
  generation: number;
}

function defaultRequestId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const entropy = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `sp_${Date.now()}_${entropy}`;
}

function supportedMediaType<TRecording extends PlatformSpeechRecording>(
  capabilities: SpeechCapabilitiesResponse | null,
  captureAdapter: PlatformSpeechCaptureAdapter<TRecording>,
): SpeechMediaType | undefined {
  if (!capabilities) return undefined;
  if (capabilities.fileTranscription.status !== "ready"
    || !capabilities.fileTranscription.dictation.enabled
    || !captureAdapter.isSupported()) {
    return undefined;
  }
  return capabilities.fileTranscription.dictation.supportedMediaTypes.find((mediaType) => mediaType === "audio/wav");
}

async function cancelCaptureSafely<TRecording extends PlatformSpeechRecording>(
  capture: PlatformSpeechCapture<TRecording>,
): Promise<void> {
  try {
    await capture.cancel();
  } catch (caught: unknown) {
    console.warn("[speech-draft] microphone cleanup failed", caught instanceof Error ? caught.name : "UnknownError");
  }
}

export function usePlatformSpeechDraft<TRecording extends PlatformSpeechRecording = Blob>(options: {
  scopeKey: string;
  /** Return a short safe message when the destination can no longer accept the transcript. */
  onDraft(text: string): void | string;
  client: PlatformSpeechDraftClient<TRecording>;
  captureAdapter: PlatformSpeechCaptureAdapter<TRecording>;
  requestIdFactory?: () => string;
  safeErrorMessage?: (error: unknown) => string | undefined;
}): UsePlatformSpeechDraftResult {
  const client = options.client;
  const [phase, setPhase] = useState<PlatformSpeechDraftPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<PlatformSpeechUnavailableReason | null>(null);
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [inputMeter, setInputMeter] = useState({ level: 0, sequence: 0 });
  const [capabilities, setCapabilities] = useState<SpeechCapabilitiesResponse | null>(null);
  const generationRef = useRef(0);
  const recordingRef = useRef<ActiveRecording<TRecording> | null>(null);
  const requestRef = useRef<ActiveRequest | null>(null);
  const captureStartRef = useRef<AbortController | null>(null);

  const cancelRemote = (requestId: string) => {
    void client.cancel(requestId).catch((caught: unknown) => {
      console.warn("[speech-draft] cancellation failed", caught instanceof Error ? caught.name : "UnknownError");
    });
  };

  const disposeActive = (notifyRemote: boolean) => {
    setInputMeter({ level: 0, sequence: 0 });
    captureStartRef.current?.abort();
    captureStartRef.current = null;
    const recording = recordingRef.current;
    recordingRef.current = null;
    if (recording) {
      clearTimeout(recording.timeout);
      clearInterval(recording.elapsedTimer);
      void cancelCaptureSafely(recording.capture);
    }
    const request = requestRef.current;
    requestRef.current = null;
    if (request) {
      request.controller.abort();
      if (notifyRemote) cancelRemote(request.requestId);
    }
  };

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    setCapabilities(null);
    setError(null);
    if (!options.captureAdapter.isSupported()) {
      setUnavailableReason("unsupported");
      setPhase("unavailable");
      return () => {
        controller.abort();
        generationRef.current += 1;
        disposeActive(true);
      };
    }
    setUnavailableReason(null);
    setPhase("loading");
    void client.capabilities(controller.signal).then((value) => {
      if (generationRef.current !== generation) return;
      setCapabilities(value);
      if (supportedMediaType(value, options.captureAdapter)) {
        setUnavailableReason(null);
        setPhase("idle");
      } else {
        setUnavailableReason(value.fileTranscription.status === "unavailable"
          ? value.fileTranscription.reason
          : "unsupported");
        setPhase("unavailable");
      }
    }).catch((caught: unknown) => {
      if (generationRef.current !== generation || controller.signal.aborted) return;
      console.warn("[speech-draft] capability check failed", caught instanceof Error ? caught.name : "UnknownError");
      setCapabilities(null);
      setUnavailableReason("capability_check_failed");
      setPhase("unavailable");
    });
    return () => {
      controller.abort();
      generationRef.current += 1;
      disposeActive(true);
    };
    // The caller uses scopeKey to fence a chat/runtime generation. Client
    // instances are stable wiring dependencies and must not restart an active
    // microphone merely because an object identity changes during render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.scopeKey, capabilityAttempt]);

  const finishRecording = async (active: ActiveRecording<TRecording>): Promise<void> => {
    if (active.stopping) return;
    active.stopping = true;
    clearTimeout(active.timeout);
    clearInterval(active.elapsedTimer);
    setInputMeter({ level: 0, sequence: 0 });
    if (recordingRef.current === active) recordingRef.current = null;
    if (generationRef.current !== active.generation) return;
    let recording: TRecording;
    try {
      recording = await active.capture.stop();
    } catch (caught: unknown) {
      if (generationRef.current !== active.generation) return;
      const safeMessage = options.safeErrorMessage?.(caught);
      if (!safeMessage) {
        console.warn("[speech-draft] recording finalization failed", caught instanceof Error ? caught.name : "UnknownError");
      }
      setError(safeMessage ?? "This recording cannot be transcribed");
      setPhase("error");
      return;
    }
    if (generationRef.current !== active.generation) return;
    if (recording.size < 44 || recording.size > active.maxBytes || recording.type !== "audio/wav") {
      setError("This recording cannot be transcribed");
      setPhase("error");
      return;
    }
    const requestId = active.requestId;
    const controller = new AbortController();
    requestRef.current = { requestId, controller, generation: active.generation };
    setError(null);
    setPhase("transcribing");
    try {
      const result = await client.transcribe({
        requestId,
        recording,
        signal: controller.signal,
      });
      if (generationRef.current !== active.generation) return;
      if (result.outcome === "transcript") {
        const commitError = options.onDraft(result.text);
        if (typeof commitError === "string") {
          setError(commitError);
          setPhase("error");
          return;
        }
      }
      setPhase("idle");
    } catch (caught: unknown) {
      if (generationRef.current !== active.generation || controller.signal.aborted) return;
      const safeMessage = options.safeErrorMessage?.(caught);
      const message = safeMessage ?? "Transcription failed";
      if (!safeMessage) {
        console.warn("[speech-draft] transcription failed", caught instanceof Error ? caught.name : "UnknownError");
      }
      setError(message);
      setPhase("error");
    } finally {
      if (requestRef.current?.generation === active.generation) requestRef.current = null;
    }
  };

  async function start(): Promise<void> {
    if (!capabilities || !["idle", "error"].includes(phase)
      || captureStartRef.current || recordingRef.current || requestRef.current) return;
    const mediaType = supportedMediaType(capabilities, options.captureAdapter);
    if (!mediaType || capabilities.fileTranscription.status !== "ready") return;
    let requestId: string;
    try {
      requestId = (options.requestIdFactory ?? defaultRequestId)();
    } catch (caught: unknown) {
      console.warn("[speech-draft] request identity creation failed", caught instanceof Error ? caught.name : "UnknownError");
      setError("Speech recording could not start");
      setPhase("error");
      return;
    }
    const generation = ++generationRef.current;
    setError(null);
    setElapsedMs(0);
    setInputMeter({ level: 0, sequence: 0 });
    setPhase("requesting_permission");
    const controller = new AbortController();
    captureStartRef.current = controller;
    let capture: PlatformSpeechCapture<TRecording>;
    let active!: ActiveRecording<TRecording>;
    try {
      capture = await options.captureAdapter.start({
        maxBytes: capabilities.fileTranscription.dictation.maxBytes,
        signal: controller.signal,
        onLevel: (level) => {
          if (recordingRef.current !== active || generationRef.current !== generation) return;
          const normalized = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
          setInputMeter((current) => ({ level: normalized, sequence: current.sequence + 1 }));
        },
        onError: (caught) => {
          const current = recordingRef.current;
          if (!current || current.generation !== generation || generationRef.current !== generation) return;
          recordingRef.current = null;
          clearTimeout(current.timeout);
          clearInterval(current.elapsedTimer);
          setInputMeter({ level: 0, sequence: 0 });
          void current.capture.cancel().catch((cleanupError: unknown) => {
            console.warn("[speech-draft] microphone cleanup failed", cleanupError instanceof Error ? cleanupError.name : "UnknownError");
          });
          const safeMessage = options.safeErrorMessage?.(caught);
          if (!safeMessage) {
            console.warn("[speech-draft] recording failed", caught instanceof Error ? caught.name : "UnknownError");
          }
          setError(safeMessage ?? "This recording cannot be transcribed");
          setPhase("error");
        },
      });
    } catch (caught: unknown) {
      if (captureStartRef.current === controller) captureStartRef.current = null;
      if (generationRef.current !== generation) return;
      console.warn("[speech-draft] microphone request failed", caught instanceof Error ? caught.name : "UnknownError");
      setError(options.safeErrorMessage?.(caught) ?? "Microphone access is unavailable");
      setPhase("error");
      return;
    }
    if (captureStartRef.current === controller) captureStartRef.current = null;
    if (generationRef.current !== generation) {
      await cancelCaptureSafely(capture);
      return;
    }
    const policy = capabilities.fileTranscription.dictation;
    const startedAt = Date.now();
    active = {
      capture,
      generation,
      timeout: setTimeout(() => {
        void finishRecording(active);
      }, policy.maxDurationMs),
      elapsedTimer: setInterval(() => {
        if (generationRef.current === generation) setElapsedMs(Date.now() - startedAt);
      }, 250),
      stopping: false,
      maxBytes: policy.maxBytes,
      requestId,
    };
    recordingRef.current = active;
    setPhase("recording");
  }

  function stop(): void {
    const active = recordingRef.current;
    if (active) void finishRecording(active);
  }

  function cancel(): void {
    generationRef.current += 1;
    disposeActive(true);
    setError(null);
    setElapsedMs(0);
    setInputMeter({ level: 0, sequence: 0 });
    setPhase(supportedMediaType(capabilities, options.captureAdapter) ? "idle" : "unavailable");
  }

  function retryCapabilities(): void {
    if (recordingRef.current || requestRef.current || captureStartRef.current) return;
    setCapabilityAttempt((current) => current + 1);
  }

  return {
    phase,
    error,
    unavailableReason,
    isSupported: phase !== "loading"
      && phase !== "unavailable"
      && supportedMediaType(capabilities, options.captureAdapter) !== undefined,
    elapsedMs,
    inputLevel: inputMeter.level,
    inputLevelSequence: inputMeter.sequence,
    start,
    stop,
    cancel,
    retryCapabilities,
  };
}
