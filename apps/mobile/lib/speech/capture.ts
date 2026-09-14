import { normalizeSpeechInputLevel, smoothSpeechInputLevel } from '@matrix-os/ui/speech';
import type { AudioStreamBuffer } from 'expo-audio';
import { NativeSpeechPcm } from './pcm';

export interface NativeSpeechRecording { bytes: Uint8Array; size: number; type: 'audio/wav' }
export function createNativeSpeechCapture(
  stream: { start(): Promise<void>; stop(): void; subscribe(callback: (buffer: AudioStreamBuffer) => void): { remove(): void } },
  permission: () => Promise<{ granted: boolean }>,
) {
  return {
    isSupported: () => Boolean(stream),
    async start(input: { maxBytes: number; signal: AbortSignal; onLevel?: (level: number) => void }) {
      if (!(await permission()).granted || input.signal.aborted) throw new Error('Microphone unavailable');
      const pcm = new NativeSpeechPcm(input.maxBytes);
      let failure: unknown;
      let closed = false;
      let lastLevel = 0;
      let smoothedLevel = 0;
      const subscription = stream.subscribe( (buffer: AudioStreamBuffer) => {
        if (closed) return;
        try {
          const level = pcm.append(buffer);
          if (Date.now() - lastLevel >= 60) { lastLevel = Date.now(); smoothedLevel = smoothSpeechInputLevel(smoothedLevel, normalizeSpeechInputLevel(level)); input.onLevel?.(smoothedLevel); }
        } catch (error) { failure = error; close(); }
      });
      const close = () => {
        if (closed) return;
        closed = true;
        subscription.remove();
        input.signal.removeEventListener('abort', cancel);
        stream.stop();
      };
      const cancel = () => { close(); pcm.clear(); };
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
