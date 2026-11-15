import { z } from 'zod/v4';
import { buildPlatformVerificationToken } from '../platform-token.js';
import { buildPlatformUserProof } from '../session-routing-websocket.js';
import { isContainerEndpointHost, type ContainerProvider, type EndpointCredential } from './container-provider.js';

/**
 * Platform calls to a container gateway's lifecycle routes (contracts/lifecycle.md):
 * `quiesce`, `resume`, and `flush`. Each call carries the provider endpoint
 * credential plus the platform verification token and the owner's proof, as
 * proxied owner requests do. Responses are parsed into fixed outcomes; no
 * upstream body or status text leaves this module.
 */

const CALL_TIMEOUT_MS = 10_000;
export const RUNTIME_FLUSH_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 4096;
const CREDENTIAL_MIN_REMAINING_MS = 60_000;
const CREDENTIAL_CACHE_MAX = 64;

export interface RuntimeTarget {
  machineId: string;
  handle: string;
  clerkUserId: string;
  unitId: string;
  endpointHost: string;
}

export type RuntimeQuiesceOutcome =
  | { ok: true; unsettledRuns: number }
  | { ok: false; error: 'busy' | 'unavailable' };

export type RuntimeFlushOutcome =
  | { ok: true; manifestDigest: string }
  | { ok: false; error: 'not_ready' | 'flush_failed' | 'unavailable' };

export interface ContainerRuntimeClient {
  quiesce(target: RuntimeTarget, signal: AbortSignal): Promise<RuntimeQuiesceOutcome>;
  /** True when the gateway confirmed it accepts runs again. */
  resume(target: RuntimeTarget, signal: AbortSignal): Promise<boolean>;
  flush(target: RuntimeTarget, signal: AbortSignal): Promise<RuntimeFlushOutcome>;
}

export const ManifestDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const QuiesceSchema = z.object({ unsettledRuns: z.number().int().min(0).max(100_000) });
const ResumeSchema = z.object({ resumed: z.boolean() });
const FlushSchema = z.object({
  manifestDigest: ManifestDigestSchema,
  parts: z.object({ home: z.literal('persisted'), ownerDatabase: z.enum(['persisted', 'skipped']) }),
});
const ErrorSchema = z.object({ error: z.string().max(64) });

export interface ContainerRuntimeClientDeps {
  provider: Pick<ContainerProvider, 'mintEndpointCredential'>;
  platformSecret: string;
  endpointHostSuffix: string;
  fetch?: typeof fetch;
  now?: () => Date;
  logError?: (message: string, detail: Record<string, string | number>) => void;
}

type Reply = { status: number; body: unknown } | null;

/** Reads at most `maxBytes`, cancelling the stream as soon as the body passes it; null when it does. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function createContainerRuntimeClient(deps: ContainerRuntimeClientDeps): ContainerRuntimeClient {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const logError = deps.logError ?? ((message, detail) => console.error(message, detail));
  /** Credentials keyed by unit; Map order is recency order. */
  const credentials = new Map<string, EndpointCredential>();

  async function credentialFor(unitId: string, signal: AbortSignal): Promise<EndpointCredential> {
    const cached = credentials.get(unitId);
    if (cached && cached.expiresAt.getTime() - now().getTime() > CREDENTIAL_MIN_REMAINING_MS) return cached;
    credentials.delete(unitId);
    const minted = await deps.provider.mintEndpointCredential(unitId, signal);
    while (credentials.size >= CREDENTIAL_CACHE_MAX) {
      const oldest = credentials.keys().next().value;
      if (oldest === undefined) break;
      credentials.delete(oldest);
    }
    credentials.set(unitId, minted);
    return minted;
  }

  async function call(target: RuntimeTarget, route: 'quiesce' | 'resume' | 'flush', signal: AbortSignal, timeoutMs: number): Promise<Reply> {
    if (!isContainerEndpointHost(target.endpointHost, deps.endpointHostSuffix)) {
      logError('[container-runtime] endpoint host rejected', { route });
      return null;
    }
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    try {
      const credential = await credentialFor(target.unitId, bounded);
      const headers = new Headers(credential.headers);
      headers.set('authorization', `Bearer ${buildPlatformVerificationToken(target.handle, deps.platformSecret)}`);
      headers.set('x-platform-user-id', target.clerkUserId);
      headers.set('x-platform-verified', buildPlatformUserProof(target.handle, target.clerkUserId, deps.platformSecret));
      headers.set('content-type', 'application/json');
      const response = await doFetch(`https://${target.endpointHost}/internal/runtime/${route}`, {
        method: 'POST', headers, body: '{}', redirect: 'error', signal: bounded,
      });
      const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
      if (text === null) {
        logError('[container-runtime] response too large', { route, status: response.status });
        return null;
      }
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) throw error;
        logError('[container-runtime] response not JSON', { route, status: response.status });
        return null;
      }
      return { status: response.status, body };
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason;
      logError('[container-runtime] call failed', { route, cause: error instanceof Error ? error.name : 'unknown' });
      return null;
    }
  }

  function errorCode(reply: Reply): string | null {
    const parsed = ErrorSchema.safeParse(reply?.body);
    return parsed.success ? parsed.data.error : null;
  }

  return {
    async quiesce(target, signal) {
      const reply = await call(target, 'quiesce', signal, CALL_TIMEOUT_MS);
      if (reply?.status === 200) {
        const parsed = QuiesceSchema.safeParse(reply.body);
        if (parsed.success) return { ok: true, unsettledRuns: parsed.data.unsettledRuns };
      }
      if (reply?.status === 409 && errorCode(reply) === 'busy') return { ok: false, error: 'busy' };
      return { ok: false, error: 'unavailable' };
    },

    async resume(target, signal) {
      const reply = await call(target, 'resume', signal, CALL_TIMEOUT_MS);
      return reply?.status === 200 && ResumeSchema.safeParse(reply.body).success;
    },

    async flush(target, signal) {
      const reply = await call(target, 'flush', signal, RUNTIME_FLUSH_TIMEOUT_MS);
      if (reply?.status === 200) {
        const parsed = FlushSchema.safeParse(reply.body);
        if (parsed.success) return { ok: true, manifestDigest: parsed.data.manifestDigest };
        logError('[container-runtime] flush result not durable', { route: 'flush' });
        return { ok: false, error: 'flush_failed' };
      }
      const code = errorCode(reply);
      if (reply?.status === 503 && code === 'not_ready') return { ok: false, error: 'not_ready' };
      if (reply?.status === 503 && code === 'flush_failed') return { ok: false, error: 'flush_failed' };
      return { ok: false, error: 'unavailable' };
    },
  };
}
