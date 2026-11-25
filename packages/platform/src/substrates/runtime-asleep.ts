import { getUserMachine } from '../database/user-machines.js';
import type { PlatformDB, UserMachineRecord } from '../db.js';
import type { SubstrateRegistry } from './registry.js';
import { decideOnDemandWake, type SubstrateWakeDecision, type WakeIdentity } from './substrate-wake.js';
import { INGRESS_ERROR_HEADER } from './upstream-transport.js';

/**
 * A host can put a VM to sleep while the platform record still says running
 * (spec 2691, ENG-520 Task P3). The host ingress then answers 503
 * `{ "error": "runtime_asleep" }` with `x-matrix-ingress-error: runtime_asleep`
 * without forwarding anything to the VM. The header is required: a VM app may
 * return the same body, and that answer must pass through untouched. The
 * platform records the VM as suspended, runs the wake path once, and retries
 * the request once. Retrying a non-idempotent request is safe because the
 * ingress rejects before forwarding, so the VM never saw the first attempt.
 * `runtime_asleep` is never passed through to a client.
 */

export const RUNTIME_ASLEEP_ERROR = 'runtime_asleep';
const MAX_ASLEEP_BODY_BYTES = 4 * 1024;
const ASLEEP_STATUS = 'suspended';

type Refusal = Exclude<SubstrateWakeDecision, { kind: 'proceed' }>;

export function isRuntimeAsleepBody(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && (parsed as { error?: unknown }).error === RUNTIME_ASLEEP_ERROR;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Peeks at a 503 body, at most 4 KiB, to tell `runtime_asleep` apart. Any
 * other response comes back unchanged, rebuilt from the peeked bytes plus
 * the rest of the stream.
 */
export async function readRuntimeAsleep(response: Response): Promise<{ asleep: true } | { asleep: false; response: Response }> {
  // Only the ingress's own marked answer counts; a VM may return the same body for its own reasons.
  if (response.status !== 503 || !response.body || response.headers.get(INGRESS_ERROR_HEADER) !== RUNTIME_ASLEEP_ERROR) {
    return { asleep: false, response };
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_ASLEEP_BODY_BYTES) return { asleep: false, response };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  while (size <= MAX_ASLEEP_BODY_BYTES) {
    const next = await reader.read();
    if (next.done) {
      done = true;
      break;
    }
    chunks.push(next.value);
    size += next.value.length;
  }
  const init = { status: response.status, statusText: response.statusText, headers: response.headers };
  if (done) {
    const bytes = concat(chunks);
    if (isRuntimeAsleepBody(new TextDecoder().decode(bytes))) return { asleep: true };
    return { asleep: false, response: new Response(bytes, init) };
  }
  const rest = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { asleep: false, response: new Response(rest, init) };
}

/**
 * Records the VM as suspended with one compare-and-set on the status and
 * generation the request routed with, then reads the record back.
 */
export async function markRuntimeAsleep(db: PlatformDB, machine: UserMachineRecord): Promise<UserMachineRecord | undefined> {
  await db.ready;
  await db.executor.updateTable('user_machines')
    .set({ status: ASLEEP_STATUS })
    .where('machine_id', '=', machine.machineId)
    .where('generation', '=', machine.generation)
    .where('status', '=', machine.status)
    .where('deleted_at', 'is', null)
    .execute();
  const current = await getUserMachine(db, machine.machineId);
  return current && !current.deletedAt && current.generation === machine.generation ? current : undefined;
}

/** Wakes the runtime once after the ingress reported it asleep. */
export async function wakeAfterAsleep(input: {
  db: PlatformDB;
  substrates: SubstrateRegistry;
  machine: UserMachineRecord;
  identity: WakeIdentity;
}): Promise<SubstrateWakeDecision> {
  const current = await markRuntimeAsleep(input.db, input.machine);
  if (!current) return { kind: 'unavailable', retryAfter: null };
  return decideOnDemandWake({ ...input, machine: current });
}

/**
 * Sends a proxied request; when the ingress reports the VM asleep, wakes it
 * and sends once more. VPS machines are sent once, untouched.
 */
export async function sendWithAsleepRetry(input: {
  db: PlatformDB;
  substrates: SubstrateRegistry;
  machine: UserMachineRecord;
  identity: WakeIdentity;
  send: () => Promise<Response>;
}): Promise<{ kind: 'response'; response: Response } | { kind: 'refuse'; decision: Refusal }> {
  const first = await input.send();
  if (input.machine.substrate === 'vps') return { kind: 'response', response: first };
  const peeked = await readRuntimeAsleep(first);
  if (!peeked.asleep) return { kind: 'response', response: peeked.response };
  const decision = await wakeAfterAsleep(input);
  if (decision.kind !== 'proceed') return { kind: 'refuse', decision };
  const retried = await readRuntimeAsleep(await input.send());
  if (!retried.asleep) return { kind: 'response', response: retried.response };
  return { kind: 'refuse', decision: { kind: 'not_ready', state: 'waking' } };
}
