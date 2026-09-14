import { normalizeSpeechInputLevel, smoothSpeechInputLevel } from '@matrix-os/ui/speech';
import type { AudioStreamBuffer } from 'expo-audio';
import { NativeSpeechPcm } from './pcm';

export interface NativeSpeechRecording { bytes: Uint8Array; size: number; type: 'audio/wav' }

function runNativeCleanup(label: string, cleanup: () => void): void {
  try {
    cleanup();
  } catch (error: unknown) {
    console.warn(label, error instanceof Error ? error.name : 'UnknownError');
  }
}

export function createNativeSpeechCapture(
  stream: { start(): Promise<void>; stop(): void; subscribe(callback: (buffer: AudioStreamBuffer) => void): { remove(): void } },
  permission: () => Promise<{ granted: boolean }>,
) {
  return {
    isSupported: () => Boolean(stream),
    async start(input: { maxBytes: number; signal: AbortSignal; onLevel?: (level: number) => void; onError?: (error: unknown) => void }) {
      if (!(await permission()).granted || input.signal.aborted) throw new Error('Microphone unavailable');
      const pcm = new NativeSpeechPcm(input.maxBytes);
      let failure: unknown;
      let closed = false;
      let lastLevel = 0;
      let smoothedLevel = 0;
      let subscription: { remove(): void } | null = null;
      const close = () => {
        if (closed) return;
        closed = true;
        if (subscription) runNativeCleanup('Native speech listener cleanup failed', () => subscription?.remove());
        input.signal.removeEventListener('abort', cancel);
        runNativeCleanup('Native speech stream cleanup failed', () => stream.stop());
      };
      const cancel = () => { close(); pcm.clear(); };
      subscription = stream.subscribe((buffer: AudioStreamBuffer) => {
        if (closed) return;
        try {
          const level = pcm.append(buffer);
          if (Date.now() - lastLevel >= 60) { lastLevel = Date.now(); smoothedLevel = smoothSpeechInputLevel(smoothedLevel, normalizeSpeechInputLevel(level)); input.onLevel?.(smoothedLevel); }
        } catch (error) {
          failure = error;
          pcm.clear();
          close();
          input.onError?.(error);
        }
      });
      if (closed) runNativeCleanup('Native speech listener cleanup failed', () => subscription?.remove());
      if (failure) throw failure;
      input.signal.addEventListener('abort', cancel, { once: true });
      try {
        await stream.start();
        if (input.signal.aborted || closed) { stream.stop(); throw new Error('Recording cancelled'); }
      } catch (error) { cancel(); throw error; }
      return {
        async stop(): Promise<NativeSpeechRecording> {
          close();
          if (failure) throw failure;
          const bytes = pcm.finish();
          return { bytes, size: bytes.length, type: 'audio/wav' };
        },
        async cancel() { cancel(); },
      };
    },
  };
}
