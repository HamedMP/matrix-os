import { File, Paths } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import {
  SpeechCapabilitiesResponseSchema, SpeechCancellationResponseSchema,
  SpeechTranscriptionResponseSchema, SpeechRequestIdSchema,
} from '@matrix-os/contracts';
import { buildGatewayRequestUrl } from '../requests/http';
import type { NativeSpeechRecording } from './capture';

function removeCachedRecording(file: File, retriesRemaining = 1): void {
  try {
    if (file.exists) file.delete();
  } catch (error: unknown) {
    console.warn('Native speech cache cleanup failed', error instanceof Error ? error.name : 'UnknownError');
    if (retriesRemaining > 0) setTimeout(() => removeCachedRecording(file, retriesRemaining - 1), 1000);
  }
}

export function createNativeSpeechClient(options: { baseUrl: string; runtimeSlot: string; getToken: () => Promise<string | null> }) {
  async function request<T>(path: string, schema: { parse(value: unknown): T }, signal?: AbortSignal, body?: FormData | string, method = 'GET') {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, method === 'POST' ? 70000 : 10000);
    try {
      const token = await options.getToken();
      if (!token || signal?.aborted || controller.signal.aborted) throw new Error('Unavailable');
      const response = await expoFetch(buildGatewayRequestUrl(options.baseUrl, `/api/speech${path}`, { runtime: options.runtimeSlot }), {
        method, body, headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: controller.signal, redirect: 'error',
      });
      if (!response.ok || !response.body) throw new Error('Unavailable');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > 256 * 1024 || chunks.length >= 4096) { await reader.cancel(); throw new Error('Unavailable'); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (_error: unknown) { throw new Error('Speech is unavailable. Try again.'); }
    finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }
  return {
    capabilities: (signal?: AbortSignal) => request('/capabilities', SpeechCapabilitiesResponseSchema, signal),
    cancel: (id: string, signal?: AbortSignal) => request(`/transcriptions/${encodeURIComponent(SpeechRequestIdSchema.parse(id))}`, SpeechCancellationResponseSchema, signal, '', 'DELETE'),
    async transcribe(input: { recording: NativeSpeechRecording; requestId: string; signal: AbortSignal }) {
      const id = SpeechRequestIdSchema.parse(input.requestId);
      const file = new File(Paths.cache, `${id}.wav`);
      try {
        file.create({ overwrite: false });
        file.write(input.recording.bytes);
        const form = new FormData();
        form.append('requestId', id);
        form.append('recording', file, 'recording.wav');
        return await request('/transcriptions', SpeechTranscriptionResponseSchema, input.signal, form, 'POST');
      } catch (_error: unknown) { throw new Error('Speech is unavailable. Try again.'); } finally {
        input.recording.bytes.fill(0);
        removeCachedRecording(file);
      }
    },
  };
}
