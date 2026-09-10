import type {
  PlatformSpeechCapture,
  PlatformSpeechCaptureAdapter,
} from "@matrix-os/ui";

const WAV_HEADER_BYTES = 44;
const MAX_PCM_CHUNKS = 512;
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 96_000;
const DEFAULT_WORKLET_URL = "/speech-pcm-capture-worklet.js";
const FLUSH_TIMEOUT_MS = 500;

export class PlatformSpeechRecorderError extends Error {
  constructor(readonly safeMessage: string) {
    super(safeMessage);
    this.name = "PlatformSpeechRecorderError";
  }
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function encodePcm16Wav(chunks: readonly Int16Array[], sampleRate: number): Blob {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    throw new PlatformSpeechRecorderError("Unsupported microphone sample rate");
  }
  let sampleCount = 0;
  for (const chunk of chunks) {
    if (!(chunk instanceof Int16Array) || chunk.length === 0) continue;
    sampleCount += chunk.length;
    if (!Number.isSafeInteger(sampleCount) || sampleCount > (0xffff_ffff - WAV_HEADER_BYTES) / 2) {
      throw new PlatformSpeechRecorderError("This recording is too large");
    }
  }
  if (sampleCount === 0) throw new PlatformSpeechRecorderError("This recording is empty");

  const pcmBytes = sampleCount * 2;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + pcmBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcmBytes, true);
  let offset = WAV_HEADER_BYTES;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      view.setInt16(offset, chunk[index] ?? 0, true);
      offset += 2;
    }
  }
  return new Blob([bytes], { type: "audio/wav" });
}

function canCapturePcm(): boolean {
  return typeof navigator !== "undefined"
    && typeof navigator.mediaDevices?.getUserMedia === "function"
    && typeof AudioContext !== "undefined"
    && typeof AudioWorkletNode !== "undefined";
}

export function createWebPcmSpeechCaptureAdapter(options: {
  workletUrl?: string;
} = {}): PlatformSpeechCaptureAdapter {
  const workletUrl = options.workletUrl ?? DEFAULT_WORKLET_URL;
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
      const close = async (): Promise<void> => {
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
        await context.audioWorklet.addModule(workletUrl);
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
        let flushComplete: (() => void) | undefined;
        worklet.port.onmessage = (event: MessageEvent<unknown>) => {
          if (!event.data || typeof event.data !== "object") return;
          const message = event.data as { type?: unknown; bytes?: unknown };
          if (message.type === "flushed") {
            flushComplete?.();
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
              await Promise.race([
                flushed,
                new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
              ]);
              await close();
              if (overflowed) throw new PlatformSpeechRecorderError("This recording is too large");
              return encodePcm16Wav(chunks, context?.sampleRate ?? 0);
            })();
            return stopping;
          },
          async cancel(): Promise<void> {
            await close();
          },
        };
      } catch (error: unknown) {
        await close();
        throw error;
      }
    },
  };
}
