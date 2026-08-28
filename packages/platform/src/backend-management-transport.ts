import { isIPv4 } from 'node:net';
import { z } from 'zod/v4';
import type { Dispatcher } from 'undici';
import { buildPlatformVerificationToken } from './platform-token.js';
import { BackendVersionSchema } from './backend-management-schema.js';
import type { ManagedMachine, ManagedProbe } from './backend-management-worker.js';

export class ManagedRuntimeBusy extends Error {}

function publicIPv4(value: string | null): value is string {
  if (!value || !isIPv4(value)) return false;
  const [a, b, c] = value.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}
async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Missing runtime response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new Error('Runtime response too large'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}
export function createManagedBackendTransport(options: { platformSecret: string; dispatcher?: Dispatcher; fetchFn?: typeof fetch }) {
  const fetchFn = options.fetchFn ?? fetch;
  async function request(machine: ManagedMachine, path: string, version?: string) {
    if (!options.platformSecret || !publicIPv4(machine.publicIPv4)) throw new Error('Runtime transport unavailable');
    // IP-literal transport pins the destination; no DNS preflight/rebinding gap.
    return fetchFn(`https://${machine.publicIPv4}:443${path}`, {
      method: version ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${buildPlatformVerificationToken(machine.handle, options.platformSecret)}`,
        host: 'app.matrix-os.com', 'content-type': 'application/json' },
      ...(version ? { body: JSON.stringify({ version }) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(10_000),
      ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
    } as RequestInit & { dispatcher?: Dispatcher });
  }
  return {
    async probe(machine: ManagedMachine): Promise<ManagedProbe> {
      const response = await request(machine, '/api/system/info');
      if (!response.ok) { await response.body?.cancel(); return { healthy: false, version: null }; }
      const info = z.object({ version: z.string().max(128).optional(), release: z.object({ version: BackendVersionSchema.optional() }).nullable().optional(),
        managedUpdates: z.boolean().optional(), managedServiceHealth: z.object({ shell: z.boolean(), syncAgent: z.boolean() }).optional(),
      }).parse(await readBoundedJson(response));
      const healthy = !info.managedUpdates || Boolean(info.managedServiceHealth?.shell && info.managedServiceHealth.syncAgent);
      return { healthy, version: info.release?.version ?? info.version ?? null };
    },
    async deploy(machine: ManagedMachine, version: string): Promise<void> {
      BackendVersionSchema.parse(version);
      const response = await request(machine, '/api/system/update', version);
      if (response.status === 409) {
        const body = await readBoundedJson(response);
        if (body && typeof body === 'object' && 'code' in body && body.code === 'runtime_busy') throw new ManagedRuntimeBusy();
      } else { await response.body?.cancel(); }
      if (!response.ok) throw new Error('Runtime update dispatch failed');
    },
  };
}
