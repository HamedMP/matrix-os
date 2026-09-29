/**
 * Injectable platform surface and browser-default adapters for the voice
 * media session. Everything the session needs from the browser is expressed
 * as narrow interfaces here so tests can substitute fakes under jsdom.
 */
import type { SafeVoiceError } from "@matrix-os/contracts/voice-session";
import { voiceErrorForCode } from "./session-api.js";

const SCRIPT_PROCESSOR_FRAME = 2_048;

export class VoiceMediaError extends Error {
  constructor(readonly safeError: SafeVoiceError) {
    super(`Voice media failed (${safeError.code})`);
    this.name = "VoiceMediaError";
  }
}

export interface VoiceMediaStreamTrackLike {
  stop(): void;
  getSettings?(): { deviceId?: string };
}

export interface VoiceMediaStreamLike {
  getTracks(): VoiceMediaStreamTrackLike[];
}

export interface VoiceMediaDevicesLike {
  getUserMedia(constraints: unknown): Promise<unknown>;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

/** Narrow playback-side AudioContext contract; the web adapter wraps AudioContext. */
export interface VoicePcmBuffer {
  readonly durationMs: number;
  readonly native?: unknown;
}

export interface VoicePlaybackSource {
  onended: (() => void) | null;
  start(atSeconds?: number): void;
  stop(): void;
}

export interface VoiceAudioContextLike {
  readonly currentTimeSeconds: number;
  readonly sampleRateHz: number;
  createPcmBuffer(input: { samples: Float32Array; sampleRateHz: number; channels: number }): VoicePcmBuffer;
  createSource(buffer: VoicePcmBuffer): VoicePlaybackSource;
  close(): Promise<void> | void;
  resume?(): void | Promise<void>;
}

export interface VoiceCaptureHandle {
  readonly sampleRateHz: number;
  stop(): void | Promise<void>;
}

export type VoiceCaptureFactory = (input: {
  stream: VoiceMediaStreamLike;
  sampleRateHz: number;
  onSamples(samples: Float32Array): void;
}) => VoiceCaptureHandle;

export function webAudioContextFactory(): VoiceAudioContextLike | null {
  if (typeof AudioContext === "undefined") return null;
  const context = new AudioContext();
  return {
    get currentTimeSeconds() {
      return context.currentTime;
    },
    get sampleRateHz() {
      return context.sampleRate;
    },
    createPcmBuffer({ samples, sampleRateHz, channels }) {
      const frames = Math.max(1, Math.ceil(samples.length / channels));
      const buffer = context.createBuffer(channels, frames, sampleRateHz);
      for (let channel = 0; channel < channels; channel += 1) {
        buffer.copyToChannel(
          new Float32Array(samples.subarray(channel * frames, (channel + 1) * frames)),
          channel,
        );
      }
      return { durationMs: buffer.duration * 1_000, native: buffer };
    },
    createSource(buffer) {
      const source = context.createBufferSource();
      source.buffer = buffer.native as AudioBuffer;
      source.connect(context.destination);
      return {
        get onended() {
          return source.onended as (() => void) | null;
        },
        set onended(handler: (() => void) | null) {
          source.onended = handler;
        },
        start: (atSeconds?: number) => source.start(atSeconds),
        stop: () => source.stop(),
      };
    },
    close: () => context.close(),
    resume: () => void context.resume(),
  };
}

export function webCaptureFactory(input: {
  stream: VoiceMediaStreamLike;
  sampleRateHz: number;
  onSamples(samples: Float32Array): void;
}): VoiceCaptureHandle {
  if (typeof AudioContext === "undefined") {
    throw new VoiceMediaError(voiceErrorForCode("input_unavailable"));
  }
  const context = new AudioContext({ sampleRate: input.sampleRateHz });
  const source = context.createMediaStreamSource(input.stream as unknown as MediaStream);
  const node = context.createScriptProcessor(SCRIPT_PROCESSOR_FRAME, 1, 1);
  node.onaudioprocess = (event: AudioProcessingEvent) => {
    input.onSamples(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  source.connect(node);
  node.connect(context.destination);
  return {
    sampleRateHz: context.sampleRate,
    async stop() {
      node.onaudioprocess = null;
      source.disconnect();
      node.disconnect();
      if (context.state !== "closed") await context.close();
    },
  };
}

export function defaultMediaDevices(): VoiceMediaDevicesLike | null {
  const devices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (!devices || typeof devices.getUserMedia !== "function") return null;
  return devices as VoiceMediaDevicesLike;
}
