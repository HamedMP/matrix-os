import type { PlatformSpeechCapture, PlatformSpeechCaptureAdapter } from "./use-platform-speech-draft.js";
import {
  encodePcm16WavBytes,
  normalizeSpeechInputLevel,
  PlatformSpeechRecorderError,
  smoothSpeechInputLevel,
} from "./pcm.js";

export {
  encodePcm16WavBytes,
  normalizeSpeechInputLevel,
  PlatformSpeechRecorderError,
  smoothSpeechInputLevel,
} from "./pcm.js";

const WAV_HEADER_BYTES = 44;
const MAX_PCM_CHUNKS = 512;
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 96_000;
const WORKLET_ASSET_PATH = "speech-pcm-capture-worklet.js";
const FLUSH_TIMEOUT_MS = 500;

export function resolveSpeechWorkletUrl(documentUrl: string = window.location.href): string {
  return new URL(`./${WORKLET_ASSET_PATH}`, documentUrl).toString();
}

export function encodePcm16Wav(chunks: readonly Int16Array[], sampleRate: number): Blob {
  const bytes = encodePcm16WavBytes(chunks, sampleRate);
  return new Blob([bytes.buffer as ArrayBuffer], { type: "audio/wav" });
}

function canCapturePcm(): boolean {
  return typeof navigator !== "undefined"
    && typeof navigator.mediaDevices?.getUserMedia === "function"
    && typeof AudioContext !== "undefined"
    && typeof AudioWorkletNode !== "undefined";
}

export function createWebPcmSpeechCaptureAdapter(options: { workletUrl?: string } = {}): PlatformSpeechCaptureAdapter {
  return {
    isSupported: canCapturePcm,
    async start(input): Promise<PlatformSpeechCapture> {
      if (!canCapturePcm()) throw new PlatformSpeechRecorderError("Microphone access is unavailable");
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= WAV_HEADER_BYTES) {
        throw new PlatformSpeechRecorderError("This recording cannot be transcribed");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      let context: AudioContext | undefined;
      let source: MediaStreamAudioSourceNode | undefined;
      let worklet: AudioWorkletNode | undefined;
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        source?.disconnect();
        worklet?.disconnect();
        if (worklet) worklet.port.onmessage = null;
        for (const track of stream.getTracks()) track.stop();
        if (context && context.state !== "closed") await context.close();
      };
      try {
        if (input.signal.aborted) throw new DOMException("Aborted", "AbortError");
        context = new AudioContext({ sampleRate: 16_000 });
        await context.audioWorklet.addModule(options.workletUrl ?? resolveSpeechWorkletUrl());
        if (input.signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (!Number.isSafeInteger(context.sampleRate)
          || context.sampleRate < MIN_SAMPLE_RATE || context.sampleRate > MAX_SAMPLE_RATE) {
          throw new PlatformSpeechRecorderError("Unsupported microphone sample rate");
        }
        source = context.createMediaStreamSource(stream);
        worklet = new AudioWorkletNode(context, "speech-pcm16-capture");
        const chunks: Int16Array[] = [];
        let pcmBytes = 0;
        let overflowed = false;
        let smoothedLevel = 0;
        let flushComplete: (() => void) | undefined;
        worklet.port.onmessage = (event: MessageEvent<unknown>) => {
          if (!event.data || typeof event.data !== "object") return;
          const message = event.data as { type?: unknown; bytes?: unknown; level?: unknown };
          if (message.type === "flushed") {
            flushComplete?.();
            return;
          }
          if (message.type === "level" && typeof message.level === "number") {
            smoothedLevel = smoothSpeechInputLevel(smoothedLevel, normalizeSpeechInputLevel(message.level));
            input.onLevel?.(smoothedLevel);
            return;
          }
          if (message.type !== "audio" || !(message.bytes instanceof ArrayBuffer)) return;
          const chunk = new Int16Array(message.bytes);
          if (chunk.length === 0) return;
          if (chunks.length >= MAX_PCM_CHUNKS || pcmBytes + chunk.byteLength > input.maxBytes - WAV_HEADER_BYTES) {
            overflowed = true;
            return;
          }
          chunks.push(chunk);
          pcmBytes += chunk.byteLength;
        };
        source.connect(worklet);
        worklet.connect(context.destination);
        let stopping: Promise<Blob> | undefined;
        return {
          stop(): Promise<Blob> {
            stopping ??= (async () => {
              source?.disconnect();
              const flushed = new Promise<void>((resolve) => { flushComplete = resolve; });
              worklet?.port.postMessage({ type: "flush" });
              await Promise.race([flushed, new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS))]);
              await close();
              if (overflowed) throw new PlatformSpeechRecorderError("This recording is too large");
              return encodePcm16Wav(chunks, context?.sampleRate ?? 0);
            })();
            return stopping;
          },
          cancel: close,
        };
      } catch (error: unknown) {
        await close();
        throw error;
      }
    },
  };
}
