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

export interface UsePlatformSpeechDraftResult {
  phase: PlatformSpeechDraftPhase;
  error: string | null;
  isSupported: boolean;
  elapsedMs: number;
  start(): Promise<void>;
  stop(): void;
  cancel(): void;
}

export interface PlatformSpeechCapture {
  stop(): Promise<Blob>;
  cancel(): Promise<void>;
}

export interface PlatformSpeechCaptureAdapter {
  isSupported(): boolean;
  start(input: { maxBytes: number; signal: AbortSignal }): Promise<PlatformSpeechCapture>;
}

export interface PlatformSpeechDraftClient {
  capabilities(signal?: AbortSignal): Promise<SpeechCapabilitiesResponse>;
  transcribe(input: {
    requestId: string;
    recording: Blob;
    signal: AbortSignal;
  }): Promise<
    | { outcome: "transcript"; text: string }
    | { outcome: "no_speech" }
  >;
  cancel(requestId: string, signal?: AbortSignal): Promise<unknown>;
}

interface ActiveRecording {
  capture: PlatformSpeechCapture;
  generation: number;
  timeout: ReturnType<typeof setTimeout>;
  elapsedTimer: ReturnType<typeof setInterval>;
  stopping: boolean;
  maxBytes: number;
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

function supportedMediaType(
  capabilities: SpeechCapabilitiesResponse | null,
  captureAdapter: PlatformSpeechCaptureAdapter,
): SpeechMediaType | undefined {
  if (!capabilities) return undefined;
  if (capabilities.fileTranscription.status !== "ready"
    || !capabilities.fileTranscription.dictation.enabled
    || !captureAdapter.isSupported()) {
    return undefined;
  }
  return capabilities.fileTranscription.dictation.supportedMediaTypes.find((mediaType) => mediaType === "audio/wav");
}

export function usePlatformSpeechDraft(options: {
  scopeKey: string;
  onDraft(text: string): void;
  client: PlatformSpeechDraftClient;
  captureAdapter: PlatformSpeechCaptureAdapter;
  requestIdFactory?: () => string;
  safeErrorMessage?: (error: unknown) => string | undefined;
}): UsePlatformSpeechDraftResult {
  const client = options.client;
  const [phase, setPhase] = useState<PlatformSpeechDraftPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [capabilities, setCapabilities] = useState<SpeechCapabilitiesResponse | null>(null);
  const generationRef = useRef(0);
  const recordingRef = useRef<ActiveRecording | null>(null);
  const requestRef = useRef<ActiveRequest | null>(null);
  const captureStartRef = useRef<AbortController | null>(null);

  const cancelRemote = (requestId: string) => {
    void client.cancel(requestId).catch((caught: unknown) => {
      console.warn("[speech-draft] cancellation failed", caught instanceof Error ? caught.name : "UnknownError");
    });
  };

  const disposeActive = (notifyRemote: boolean) => {
    captureStartRef.current?.abort();
    captureStartRef.current = null;
    const recording = recordingRef.current;
    recordingRef.current = null;
    if (recording) {
      clearTimeout(recording.timeout);
      clearInterval(recording.elapsedTimer);
      void recording.capture.cancel().catch((caught: unknown) => {
        console.warn("[speech-draft] microphone cleanup failed", caught instanceof Error ? caught.name : "UnknownError");
      });
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
      setPhase("unavailable");
      return () => {
        controller.abort();
        generationRef.current += 1;
        disposeActive(true);
      };
    }
    setPhase("loading");
    void client.capabilities(controller.signal).then((value) => {
      if (generationRef.current !== generation) return;
      setCapabilities(value);
      setPhase(supportedMediaType(value, options.captureAdapter) ? "idle" : "unavailable");
    }).catch((caught: unknown) => {
      if (generationRef.current !== generation || controller.signal.aborted) return;
      console.warn("[speech-draft] capability check failed", caught instanceof Error ? caught.name : "UnknownError");
      setCapabilities(null);
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
  }, [options.scopeKey]);

  const finishRecording = async (active: ActiveRecording): Promise<void> => {
    if (active.stopping) return;
    active.stopping = true;
    clearTimeout(active.timeout);
    clearInterval(active.elapsedTimer);
    if (recordingRef.current === active) recordingRef.current = null;
    if (generationRef.current !== active.generation) return;
    let recording: Blob;
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
    const requestId = (options.requestIdFactory ?? defaultRequestId)();
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
      if (result.outcome === "transcript") options.onDraft(result.text);
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
    if (!capabilities || !["idle", "error"].includes(phase)) return;
    const mediaType = supportedMediaType(capabilities, options.captureAdapter);
    if (!mediaType || capabilities.fileTranscription.status !== "ready") return;
    const generation = ++generationRef.current;
    setError(null);
    setElapsedMs(0);
    setPhase("requesting_permission");
    const controller = new AbortController();
    captureStartRef.current = controller;
    let capture: PlatformSpeechCapture;
    try {
      capture = await options.captureAdapter.start({
        maxBytes: capabilities.fileTranscription.dictation.maxBytes,
        signal: controller.signal,
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
      await capture.cancel();
      return;
    }
    const policy = capabilities.fileTranscription.dictation;
    const startedAt = Date.now();
    const active: ActiveRecording = {
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
    setPhase(supportedMediaType(capabilities, options.captureAdapter) ? "idle" : "unavailable");
  }

  return {
    phase,
    error,
    isSupported: phase !== "loading"
      && phase !== "unavailable"
      && supportedMediaType(capabilities, options.captureAdapter) !== undefined,
    elapsedMs,
    start,
    stop,
    cancel,
  };
}
