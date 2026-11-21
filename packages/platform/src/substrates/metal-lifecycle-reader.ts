import { RuntimeLifecycleStatusSchema, type RuntimeLifecycleStatus } from '@matrix-os/contracts/runtime-lifecycle';
import type { UserMachineRecord } from '../db.js';
import { buildPlatformVerificationToken } from '../platform-token.js';
import type { SubstrateRegistry } from './registry.js';
import { readRuntimeAsleep } from './runtime-asleep.js';
import { applyUpstreamCredentials, needsVerifiedTransport, verifiedDispatcher } from './upstream-transport.js';

/**
 * Reads a runtime's `GET /api/system/lifecycle` answer for the idle sleeper
 * (spec 2691, ENG-520 Task P6).
 */

export const LIFECYCLE_TIMEOUT_MS = 10_000;
export const LIFECYCLE_RESPONSE_LIMIT_BYTES = 4 * 1024;
const LIFECYCLE_PATH = '/api/system/lifecycle';

/** `asleep`: the host ingress answered its own marked `runtime_asleep` (the VM is suspended while the record says running). */
export type LifecycleFailureCode = 'not_routable' | 'timeout' | 'unreachable' | 'unavailable' | 'invalid_response' | 'asleep';

export type LifecycleRead =
  | { ok: true; status: RuntimeLifecycleStatus }
  | { ok: false; code: LifecycleFailureCode };

export type LifecycleReader = (machine: UserMachineRecord, signal: AbortSignal) => Promise<LifecycleRead>;


async function readBoundedText(body: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > LIFECYCLE_RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * Reads `GET /api/system/lifecycle` from the runtime's gateway through its
 * substrate upstream (for metal, the host ingress with its credential and
 * verified TLS), authenticated with the same platform runtime credential the
 * session-routing proxy uses. Failures are typed codes; nothing from the
 * response reaches a log.
 */
export function createLifecycleReader(input: {
  substrates: SubstrateRegistry;
  platformSecret: string;
  timeoutMs?: number;
}): LifecycleReader {
  const timeoutMs = input.timeoutMs ?? LIFECYCLE_TIMEOUT_MS;
  return async (machine, signal) => {
    const resolution = input.substrates.resolveUpstream(machine, { path: LIFECYCLE_PATH });
    if (resolution.kind !== 'upstream') return { ok: false, code: 'not_routable' };
    const { upstream } = resolution;
    const headers = new Headers({
      accept: 'application/json',
      authorization: `Bearer ${buildPlatformVerificationToken(machine.handle, input.platformSecret)}`,
    });
    applyUpstreamCredentials(headers, upstream);
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const response = await fetch(upstream.url, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: combined,
        ...(needsVerifiedTransport(upstream) ? { dispatcher: verifiedDispatcher(upstream) } : {}),
      } as RequestInit);
      // Only the ingress's own marked answer counts (the same rule the request path uses).
      const peeked = await readRuntimeAsleep(response);
      if (peeked.asleep) return { ok: false, code: 'asleep' };
      const answer = peeked.response;
      if (!answer.ok || !answer.body) {
        await answer.body?.cancel();
        return { ok: false, code: 'unavailable' };
      }
      const text = await readBoundedText(answer.body);
      if (text === null) return { ok: false, code: 'invalid_response' };
      const parsed = RuntimeLifecycleStatusSchema.safeParse(parseJson(text));
      return parsed.success ? { ok: true, status: parsed.data } : { ok: false, code: 'invalid_response' };
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason;
      if (timeout.aborted) return { ok: false, code: 'timeout' };
      if (error instanceof Error) return { ok: false, code: 'unreachable' };
      throw error;
    }
  };
}
