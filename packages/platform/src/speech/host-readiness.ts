import { SpeechCapabilitiesResponseSchema } from '@matrix-os/contracts';
import { z } from 'zod/v4';

const MAX_HOST_RESPONSE_BYTES = 16 * 1024;
const RuntimeInfoSchema = z.object({
  runtime: z.object({ handle: z.string(), machineId: z.string(), runtimeSlot: z.string() }),
});

export async function readBoundedHostJson(response: Response, maxBytes = MAX_HOST_RESPONSE_BYTES): Promise<unknown> {
  if (!response.ok || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (size + next.value.byteLength > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      bytes.set(next.value, size);
      size += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
}

/** Older hosts may already use a valid, pinned platform origin. Verify the
 * exact machine and the same live speech capability used by clients without
 * replacing that origin or relaxing the host's configuration checks. */
export async function isMachineSpeechReady(options: {
  machine: { handle: string; machineId: string; runtimeSlot: string };
  get(path: string): Promise<Response>;
}): Promise<boolean> {
  const info = RuntimeInfoSchema.safeParse(await readBoundedHostJson(await options.get('/api/system/info')));
  if (!info.success || info.data.runtime.handle !== options.machine.handle
    || info.data.runtime.machineId !== options.machine.machineId
    || info.data.runtime.runtimeSlot !== options.machine.runtimeSlot) return false;
  const capabilities = SpeechCapabilitiesResponseSchema.safeParse(
    await readBoundedHostJson(await options.get('/api/speech/capabilities')),
  );
  return capabilities.success && capabilities.data.fileTranscription.status === 'ready'
    && capabilities.data.fileTranscription.dictation.enabled;
}
