/**
 * Media layer for a voice session: one capture owner, bounded base64
 * `capture.audio` chunk production, and a per-response playback buffer that
 * reports accurate `playback.segment_played` boundaries — including the true
 * played position when a response is interrupted mid-segment.
 *
 * Platform dependencies live in `./media-web.js` (injected so the session
 * runs under jsdom with fakes); wire codecs live in `./pcm-codec.js`.
 */
import {
  VOICE_SESSION_LIMITS,
  type AudioFormat,
  type SafeVoiceError,
  type VoicePlaybackAck,
} from "@matrix-os/contracts/voice-session";
import { voiceErrorForCode } from "./session-api.js";
import {
  decodeBase64,
  encodeBase64,
  floatToPcm16,
  floatToPcmF32,
  pcm16ToFloat,
  pcmF32ToFloat,
} from "./pcm-codec.js";
import {
  defaultMediaDevices,
  VoiceMediaError,
  webAudioContextFactory,
  webCaptureFactory,
  type VoiceAudioContextLike,
  type VoiceCaptureFactory,
  type VoiceCaptureHandle,
  type VoiceMediaDevicesLike,
  type VoiceMediaStreamLike,
  type VoicePcmBuffer,
  type VoicePlaybackSource,
} from "./media-web.js";

export { decodeBase64, encodeBase64, VoiceMediaError };
export type {
  VoiceAudioContextLike,
  VoiceCaptureFactory,
  VoiceCaptureHandle,
  VoiceMediaDevicesLike,
  VoiceMediaStreamLike,
  VoiceMediaStreamTrackLike,
  VoicePcmBuffer,
  VoicePlaybackSource,
} from "./media-web.js";

const DEFAULT_MAX_IN_FLIGHT_MS = 2_000;
const DEFAULT_MAX_RESPONSES = 16;
const DEFAULT_MAX_QUEUED_SEGMENTS = 128;

export interface VoiceMediaCallbacks {
  /** Returns false while the transport cannot accept the chunk; the media queue retains it. */
  onAudioChunk(chunk: { turnId: string; timestampMs: number; data: string }): boolean;
  onSegmentPlayed(ack: VoicePlaybackAck): void;
  onBackpressure?(droppedChunks: number): void;
  onDeviceChanged?(change: { inputDeviceId?: string }): void;
  onError?(error: SafeVoiceError): void;
}

export interface VoiceMediaSession {
  readonly supported: boolean;
  prepare(input?: { onRationale?: () => void | Promise<void>; inputDeviceId?: string }): Promise<void>;
  startCapture(input: { turnId: string }): boolean;
  stopCapture(): void;
  enqueueSegment(input: { responseId: string; segmentId: string; data: string }): void;
  /** Stops playout; returns the true heard boundary (ms) or null when unknown. */
  interruptResponse(responseId: string): number | null;
  playedThroughMs(responseId: string): number | null;
  pendingAudioMs(): number;
  release(): Promise<void>;
}

interface PendingChunk {
  turnId: string;
  timestampMs: number;
  data: string;
}

interface ResponsePlayback {
  queue: { segmentId: string; buffer: VoicePcmBuffer }[];
  queuedMs: number;
  current: { segmentId: string; source: VoicePlaybackSource; buffer: VoicePcmBuffer; startedAtSeconds: number } | null;
  nextStartSeconds: number;
  playedMs: number;
  ackRevision: number;
  stopping: boolean;
}

export function createWebVoiceMediaSession(options: {
  audio: AudioFormat;
  callbacks: VoiceMediaCallbacks;
  mediaDevices?: VoiceMediaDevicesLike | null;
  createAudioContext?: () => VoiceAudioContextLike | null;
  captureFactory?: VoiceCaptureFactory;
  maxInFlightMs?: number;
  maxResponses?: number;
  maxQueuedSegments?: number;
  now?: () => number;
}): VoiceMediaSession {
  const audio = options.audio;
  const callbacks = options.callbacks;
  const mediaDevices = options.mediaDevices === undefined ? defaultMediaDevices() : options.mediaDevices;
  const createAudioContext = options.createAudioContext ?? webAudioContextFactory;
  const captureFactory = options.captureFactory ?? webCaptureFactory;
  const now = options.now ?? (() => Date.now());
  const maxInFlightMs = Math.max(audio.frameDurationMs, options.maxInFlightMs ?? DEFAULT_MAX_IN_FLIGHT_MS);
  const maxPendingChunks = Math.max(1, Math.floor(maxInFlightMs / audio.frameDurationMs));
  const maxResponses = Math.max(1, Math.min(options.maxResponses ?? DEFAULT_MAX_RESPONSES, DEFAULT_MAX_RESPONSES));
  const maxQueuedSegments = Math.max(1, Math.min(options.maxQueuedSegments ?? DEFAULT_MAX_QUEUED_SEGMENTS, VOICE_SESSION_LIMITS.maxSegments));

  const supported = mediaDevices !== null
    && typeof mediaDevices.getUserMedia === "function"
    && (options.createAudioContext !== undefined || typeof AudioContext !== "undefined");

  let stream: VoiceMediaStreamLike | null = null;
  let capture: VoiceCaptureHandle | null = null;
  let playbackContext: VoiceAudioContextLike | null = null;
  let prepared = false;
  let released = false;
  let capturing = false;
  let activeTurnId: string | null = null;
  let droppedChunks = 0;
  let invalidSegments = 0;

  let pendingSamples = new Float32Array(0);
  const pendingChunks: PendingChunk[] = [];
  const responses = new Map<string, ResponsePlayback>();

  const emitError = (error: SafeVoiceError) => {
    try {
      callbacks.onError?.(error);
    } catch (listenerError: unknown) {
      console.warn("[voice-session] media error listener failed:", listenerError instanceof Error ? listenerError.name : "UnknownError");
    }
  };

  const encodeSamples = (samples: Float32Array): Uint8Array => {
    if (audio.codec === "pcm_f32le") return floatToPcmF32(samples);
    if (audio.codec === "pcm_s16le") return floatToPcm16(samples);
    throw new VoiceMediaError(voiceErrorForCode("internal_failure"));
  };

  const decodeBytes = (bytes: Uint8Array): Float32Array => {
    if (audio.codec === "pcm_f32le") return pcmF32ToFloat(bytes);
    return pcm16ToFloat(bytes);
  };

  const drainChunks = () => {
    while (pendingChunks.length > 0) {
      const head = pendingChunks[0] as PendingChunk;
      let accepted = false;
      try {
        accepted = callbacks.onAudioChunk(head) === true;
      } catch (error: unknown) {
        // A throwing transport rejected this frame permanently; drop rather
        // than wedge the bounded queue behind it.
        console.warn("[voice-session] audio chunk send failed:", error instanceof Error ? error.name : "UnknownError");
        pendingChunks.shift();
        droppedChunks += 1;
        callbacks.onBackpressure?.(droppedChunks);
        continue;
      }
      if (!accepted) return;
      pendingChunks.shift();
    }
  };

  const emitChunk = (samples: Float32Array) => {
    if (activeTurnId === null || samples.length === 0) return;
    let bytes: Uint8Array;
    try {
      bytes = encodeSamples(samples);
    } catch (error: unknown) {
      emitError(error instanceof VoiceMediaError ? error.safeError : voiceErrorForCode("internal_failure"));
      return;
    }
    if (bytes.length === 0 || bytes.length > VOICE_SESSION_LIMITS.maxAudioFrameBytes) {
      droppedChunks += 1;
      callbacks.onBackpressure?.(droppedChunks);
      return;
    }
    while (pendingChunks.length >= maxPendingChunks) {
      pendingChunks.shift();
      droppedChunks += 1;
      callbacks.onBackpressure?.(droppedChunks);
    }
    pendingChunks.push({ turnId: activeTurnId, timestampMs: now(), data: encodeBase64(bytes) });
    drainChunks();
  };

  const onSamples = (samples: Float32Array) => {
    if (!capturing || samples.length === 0) return;
    const rateHz = Math.max(1, Math.floor(capture?.sampleRateHz ?? audio.sampleRateHz));
    const samplesPerChunk = Math.max(1, Math.round((audio.frameDurationMs * rateHz) / 1_000));
    const merged = new Float32Array(pendingSamples.length + samples.length);
    merged.set(pendingSamples, 0);
    merged.set(samples, pendingSamples.length);
    pendingSamples = merged;
    while (pendingSamples.length >= samplesPerChunk) {
      emitChunk(pendingSamples.subarray(0, samplesPerChunk));
      pendingSamples = pendingSamples.subarray(samplesPerChunk);
    }
  };

  const currentInputDeviceId = (): string | undefined => {
    const track = stream?.getTracks()[0];
    const deviceId = track?.getSettings?.().deviceId;
    return typeof deviceId === "string" && deviceId.length > 0 && /^[A-Za-z0-9_-]+$/.test(deviceId)
      ? deviceId
      : undefined;
  };

  const onDeviceChange = () => {
    if (released) return;
    try {
      const inputDeviceId = currentInputDeviceId();
      callbacks.onDeviceChanged?.(inputDeviceId === undefined ? {} : { inputDeviceId });
    } catch (error: unknown) {
      console.warn("[voice-session] device-change listener failed:", error instanceof Error ? error.name : "UnknownError");
    }
  };

  const playbackCtx = (): VoiceAudioContextLike | null => {
    if (playbackContext) return playbackContext;
    try {
      playbackContext = createAudioContext();
    } catch (error: unknown) {
      console.warn("[voice-session] playback context failed:", error instanceof Error ? error.name : "UnknownError");
      playbackContext = null;
    }
    if (playbackContext === null) emitError(voiceErrorForCode("output_unavailable"));
    return playbackContext;
  };

  const scheduleNext = (responseId: string, playback: ResponsePlayback) => {
    const context = playbackCtx();
    if (context === null || playback.current !== null || playback.stopping) return;
    const segment = playback.queue.shift();
    if (!segment) {
      playback.queuedMs = 0;
      return;
    }
    playback.queuedMs = Math.max(0, playback.queuedMs - segment.buffer.durationMs);
    const source = context.createSource(segment.buffer);
    const startedAtSeconds = Math.max(context.currentTimeSeconds, playback.nextStartSeconds);
    playback.nextStartSeconds = startedAtSeconds + segment.buffer.durationMs / 1_000;
    playback.current = { segmentId: segment.segmentId, source, buffer: segment.buffer, startedAtSeconds };
    source.onended = () => {
      if (playback.stopping) return;
      playback.current = null;
      playback.playedMs += segment.buffer.durationMs;
      playback.ackRevision += 1;
      try {
        callbacks.onSegmentPlayed({
          responseId,
          segmentId: segment.segmentId,
          deliveryRevision: playback.ackRevision,
          playedThroughMs: Math.round(playback.playedMs),
        });
      } catch (error: unknown) {
        console.warn("[voice-session] playback ack listener failed:", error instanceof Error ? error.name : "UnknownError");
      }
      scheduleNext(responseId, playback);
    };
    try {
      context.resume?.();
      source.start(startedAtSeconds);
    } catch (error: unknown) {
      console.warn("[voice-session] playback start failed:", error instanceof Error ? error.name : "UnknownError");
      playback.current = null;
      emitError(voiceErrorForCode("output_unavailable"));
    }
  };

  const heardBoundaryMs = (playback: ResponsePlayback): number => {
    let heard = playback.playedMs;
    const current = playback.current;
    if (current !== null && playbackContext !== null) {
      const elapsed = playbackContext.currentTimeSeconds - current.startedAtSeconds;
      heard += Math.max(0, Math.min(elapsed, current.buffer.durationMs / 1_000)) * 1_000;
    }
    return Math.round(heard);
  };

  return {
    supported,
    async prepare(input) {
      if (released) throw new VoiceMediaError(voiceErrorForCode("internal_failure"));
      if (!supported || mediaDevices === null) throw new VoiceMediaError(voiceErrorForCode("unsupported_surface"));
      if (prepared) return;
      await input?.onRationale?.();
      let rawStream: unknown;
      try {
        rawStream = await mediaDevices.getUserMedia({
          audio: {
            ...(input?.inputDeviceId === undefined ? {} : { deviceId: { exact: input.inputDeviceId } }),
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (error: unknown) {
        const name = error instanceof DOMException || error instanceof Error ? error.name : "";
        const code = name === "NotAllowedError" || name === "SecurityError"
          ? "permission_denied"
          : "input_unavailable";
        throw new VoiceMediaError(voiceErrorForCode(code));
      }
      stream = rawStream as VoiceMediaStreamLike;
      // release() may have run while getUserMedia was in flight.
      if (released) {
        for (const track of stream.getTracks()) track.stop();
        stream = null;
        throw new VoiceMediaError(voiceErrorForCode("internal_failure"));
      }
      try {
        capture = captureFactory({ stream, sampleRateHz: audio.sampleRateHz, onSamples });
      } catch (error: unknown) {
        for (const track of stream.getTracks()) track.stop();
        stream = null;
        if (error instanceof VoiceMediaError) throw error;
        console.warn("[voice-session] capture pipeline failed:", error instanceof Error ? error.name : "UnknownError");
        throw new VoiceMediaError(voiceErrorForCode("input_unavailable"));
      }
      prepared = true;
      mediaDevices.addEventListener?.("devicechange", onDeviceChange);
    },
    startCapture({ turnId }) {
      if (released || !prepared) {
        emitError(voiceErrorForCode("input_unavailable"));
        return false;
      }
      if (capturing && activeTurnId === turnId) return true;
      // One capture owner: a new turn supersedes any in-flight capture and its
      // queued audio, which belongs to the superseded turn.
      activeTurnId = turnId;
      capturing = true;
      pendingSamples = new Float32Array(0);
      pendingChunks.length = 0;
      return true;
    },
    stopCapture() {
      if (!capturing) return;
      capturing = false;
      // Flush the audio tail so trailing speech is not truncated mid-word;
      // anything still queued afterwards belongs to the ended turn.
      const tail = pendingSamples;
      pendingSamples = new Float32Array(0);
      if (tail.length > 0) emitChunk(tail);
      pendingChunks.length = 0;
      activeTurnId = null;
    },
    enqueueSegment({ responseId, segmentId, data }) {
      if (released) return;
      if (audio.codec === "opus") {
        // PCM-only decoder: opus requires an encoded-audio pipeline the web
        // layer does not provide; count and drop rather than mis-decode.
        invalidSegments += 1;
        return;
      }
      let playback = responses.get(responseId);
      if (!playback) {
        while (responses.size >= maxResponses) {
          const oldest = responses.keys().next().value;
          if (oldest === undefined) break;
          const stale = responses.get(oldest);
          responses.delete(oldest);
          if (stale) {
            stale.stopping = true;
            stale.current?.source.stop();
          }
        }
        playback = { queue: [], queuedMs: 0, current: null, nextStartSeconds: 0, playedMs: 0, ackRevision: 0, stopping: false };
        responses.set(responseId, playback);
      }
      if (playback.stopping || playback.queue.length >= maxQueuedSegments
        || playback.queuedMs > VOICE_SESSION_LIMITS.maxQueuedAudioMs) {
        invalidSegments += 1;
        callbacks.onBackpressure?.(invalidSegments);
        return;
      }
      const bytes = decodeBase64(data);
      const context = playbackCtx();
      if (bytes === null || bytes.length === 0 || context === null) return;
      const buffer = context.createPcmBuffer({
        samples: decodeBytes(bytes),
        sampleRateHz: audio.sampleRateHz,
        channels: audio.channels,
      });
      playback.queue.push({ segmentId, buffer });
      playback.queuedMs += buffer.durationMs;
      scheduleNext(responseId, playback);
    },
    interruptResponse(responseId) {
      const playback = responses.get(responseId);
      if (!playback) return null;
      const boundary = heardBoundaryMs(playback);
      playback.stopping = true;
      playback.queue = [];
      try {
        playback.current?.source.stop();
      } catch (error: unknown) {
        console.warn("[voice-session] playback stop failed:", error instanceof Error ? error.name : "UnknownError");
      }
      playback.current = null;
      responses.delete(responseId);
      return boundary;
    },
    playedThroughMs(responseId) {
      const playback = responses.get(responseId);
      return playback ? heardBoundaryMs(playback) : null;
    },
    pendingAudioMs() {
      return pendingChunks.length * audio.frameDurationMs + Math.round(pendingSamples.length / Math.max(1, audio.sampleRateHz) * 1_000);
    },
    async release() {
      if (released) return;
      released = true;
      capturing = false;
      activeTurnId = null;
      pendingSamples = new Float32Array(0);
      pendingChunks.length = 0;
      mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
      const heldCapture = capture;
      const heldStream = stream;
      const heldContext = playbackContext;
      capture = null;
      stream = null;
      playbackContext = null;
      for (const playback of responses.values()) {
        playback.stopping = true;
        try {
          playback.current?.source.stop();
        } catch (error: unknown) {
          console.warn("[voice-session] release playback stop failed:", error instanceof Error ? error.name : "UnknownError");
        }
      }
      responses.clear();
      try {
        await heldCapture?.stop();
      } catch (error: unknown) {
        console.warn("[voice-session] capture release failed:", error instanceof Error ? error.name : "UnknownError");
      }
      if (heldStream) {
        for (const track of heldStream.getTracks()) {
          try {
            track.stop();
          } catch (error: unknown) {
            console.warn("[voice-session] track stop failed:", error instanceof Error ? error.name : "UnknownError");
          }
        }
      }
      try {
        await heldContext?.close();
      } catch (error: unknown) {
        console.warn("[voice-session] playback context close failed:", error instanceof Error ? error.name : "UnknownError");
      }
    },
  };
}
