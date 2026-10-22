import {
  normalizeSpeechInputLevel,
  PlatformSpeechRecorderError,
  smoothSpeechInputLevel,
  type PlatformSpeechCapture,
  type PlatformSpeechCaptureAdapter,
} from "@matrix-os/ui/speech";

import { SpeechPcmCollector, type PcmBuffer } from "./pcm-collector";

/** A finished recording, as a WAV file in memory. */
export interface SpeechRecording {
  bytes: Uint8Array;
  size: number;
  type: "audio/wav";
}

interface Subscription {
  remove(): void;
}

/** What recording needs from the microphone (expo-audio's stream). */
export interface MicrophoneStream {
  start(): Promise<void>;
  stop(): void;
  onBuffer(listener: (buffer: PcmBuffer) => void): Subscription;
  /** Told when the stream starts and stops, including when the system stops it. */
  onStatus(listener: (status: { isStreaming: boolean }) => void): Subscription;
}

export interface MicrophonePermission {
  granted: boolean;
  /** False once the person has said no for good: only Settings can change it. */
  canAskAgain: boolean;
}

/** The person has not let the app use the microphone. */
export class MicrophonePermissionError extends PlatformSpeechRecorderError {
  constructor(readonly canAskAgain: boolean) {
    super("Microphone access is off");
    this.name = "MicrophonePermissionError";
  }
}

function cancelled(): Error {
  const error = new Error("Recording cancelled");
  error.name = "AbortError";
  return error;
}

function letGo(cleanup: () => void): void {
  try {
    cleanup();
  } catch (error: unknown) {
    console.warn("[speech] microphone cleanup failed", error instanceof Error ? error.name : "UnknownError");
  }
}

/**
 * Records dictation from the microphone for the shared speech draft hook. The
 * microphone is open only between start and stop or cancel, and the recording
 * lives in memory until it is handed over or forgotten.
 */
export function createMicrophoneCaptureAdapter(options: {
  stream: MicrophoneStream;
  requestPermission(): Promise<MicrophonePermission>;
  /** Puts the phone's audio back as it was before the recording took it. */
  releaseAudioSession?(): void;
  /**
   * The recording stopped on its own: the system took the microphone, it is
   * full, or the microphone sent something unusable. The caller stops it,
   * which hands over what was recorded.
   */
  onEnded(): void;
}): PlatformSpeechCaptureAdapter<SpeechRecording> {
  const { stream } = options;
  return {
    isSupported: () => true,
    async start({ maxBytes, signal, onLevel }): Promise<PlatformSpeechCapture<SpeechRecording>> {
      const permission = await options.requestPermission();
      if (signal.aborted) throw cancelled();
      if (!permission.granted) throw new MicrophonePermissionError(permission.canAskAgain);

      const collector = new SpeechPcmCollector(maxBytes);
      let state: "opening" | "recording" | "closed" = "opening";
      let failure: PlatformSpeechRecorderError | null = null;
      let ended = false;
      let level = 0;
      // Read through a function: the listeners below change the state while start waits.
      const isClosed = () => state === "closed";

      const end = () => {
        if (ended || state === "closed") return;
        ended = true;
        options.onEnded();
      };
      const buffers = stream.onBuffer((buffer) => {
        if (state === "closed" || failure || ended) return;
        try {
          const appended = collector.append(buffer);
          if (appended.full) {
            end();
            return;
          }
          level = smoothSpeechInputLevel(level, normalizeSpeechInputLevel(appended.level));
          onLevel?.(level);
        } catch (error: unknown) {
          failure = error instanceof PlatformSpeechRecorderError
            ? error
            : new PlatformSpeechRecorderError("This recording cannot be transcribed");
          collector.clear();
          end();
        }
      });
      const status = stream.onStatus(({ isStreaming }) => {
        if (!isStreaming && state === "recording") end();
      });
      const close = () => {
        if (state === "closed") return;
        state = "closed";
        signal.removeEventListener("abort", forget);
        // Listeners go first, so the stream's own "stopped" is not taken for the system stopping it.
        letGo(() => buffers.remove());
        letGo(() => status.remove());
        letGo(() => stream.stop());
        if (options.releaseAudioSession) letGo(options.releaseAudioSession);
      };
      function forget() {
        close();
        collector.clear();
      }
      signal.addEventListener("abort", forget, { once: true });

      try {
        await stream.start();
      } catch (error: unknown) {
        forget();
        if (signal.aborted) throw cancelled();
        console.warn("[speech] microphone could not be opened", error instanceof Error ? error.name : "UnknownError");
        throw new PlatformSpeechRecorderError("Microphone access is unavailable");
      }
      if (signal.aborted || isClosed()) {
        forget();
        // Cancelled while it opened: the stop sent then came before the
        // microphone was open, so it is closed again now that it is.
        letGo(() => stream.stop());
        if (options.releaseAudioSession) letGo(options.releaseAudioSession);
        throw cancelled();
      }
      state = "recording";

      return {
        async stop(): Promise<SpeechRecording> {
          close();
          if (failure) {
            collector.clear();
            throw failure;
          }
          const bytes = collector.finish();
          return { bytes, size: bytes.byteLength, type: "audio/wav" };
        },
        async cancel(): Promise<void> {
          forget();
        },
      };
    },
  };
}
