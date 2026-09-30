import type { UserMachineRecord } from './db.js';
import type { AppDomainIdentity } from './session-routing-identity.js';
import { isPreviewMachine } from './customer-vps-preview.js';
import { mintPreviewDriveTurnProof } from './preview-drive-turn-proof.js';

const TURN_PATH = /^\/api\/chats\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\/turns$/;
// Match the Gateway's canonical direct Chat turn limit exactly.
const MAX_BODY_BYTES = 128 * 1024;

/** Inspect only direct, authenticated Preview Chat turns; queued/background turns get no proof. */
export async function authenticatedPreviewDriveProxyProof(input: {
  request: Request; method: string; path: string; machine: UserMachineRecord;
  identity: AppDomainIdentity; platformSecret: string; timeoutMs?: number;
}): Promise<string | null | { status: 408 | 413 }> {
  if (input.method !== 'POST' || !TURN_PATH.test(input.path)
    || !isPreviewMachine(input.machine) || input.identity.source !== 'auth'
    || input.identity.verifiedSyncBearer === true || !input.platformSecret) return null;
  const reader = input.request.clone().body?.getReader();
  if (!reader) return null;
  const cancel = () => {
    void reader.cancel().catch(error => console.warn('[preview-drive] Body cancellation failed', error instanceof Error ? error.name : typeof error));
    void input.request.body?.cancel().catch(error => console.warn('[preview-drive] Body cancellation failed', error instanceof Error ? error.name : typeof error));
  };
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('PreviewDriveBodyTimeout')), input.timeoutMs ?? 30_000);
    timeout.unref?.();
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_BODY_BYTES) { cancel(); return { status: 413 }; }
      chunks.push(next.value);
    }
    const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return mintPreviewDriveTurnProof({ method: input.method, path: input.path,
      identity: { handle: input.machine.handle, userId: input.identity.userId,
        source: input.identity.source, verifiedSyncBearer: input.identity.verifiedSyncBearer },
      body, secret: input.platformSecret });
  } catch (error: unknown) {
    cancel();
    if (error instanceof Error && error.message === 'PreviewDriveBodyTimeout') return { status: 408 };
    console.warn('[preview-drive] Turn proof unavailable', error instanceof Error ? error.name : typeof error);
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
