import type { Context } from 'hono';
import { mapUserMachine } from '../database/user-machine-records.js';
import { getUserMachine } from '../database/user-machines.js';
import type { PlatformDB, UserMachineRecord } from '../db.js';
import { getVpsBootPage } from '../vps-boot-page.js';
import type { SubstrateRegistry } from './registry.js';
import type { EnsureRunningResult, RuntimeSubstrate } from './types.js';

/**
 * Waking on-demand runtimes (spec 2691, ENG-520 Task P3). Generalized from
 * feat/2691-container-register `container-wake.ts` and
 * `container-websocket.ts#decideContainerWake` to any `startsOnDemand`
 * substrate.
 *
 * Only an authenticated request from the runtime's owner starts compute.
 * Collaborators, share-link viewers, and credential-less routes reach a
 * runtime that is already routable and get "not available" otherwise.
 * Concurrent owner requests share one wake per machine. Every "not ready"
 * answer is given before anything is proxied, so clients may retry even
 * non-idempotent requests on `runtimeState` (G3 relies on this).
 */

export const WAKE_TIMEOUT_MS = 15_000;
export const OWNER_ACTIVITY_WRITE_INTERVAL_MS = 60_000;
export const OWNER_ACTIVITY_CACHE_MAX = 10_000;
const WAKE_IN_FLIGHT_MAX = 1_024;
const WAKING_RETRY_AFTER = '3';
const BUSY_RETRY_AFTER = '30';
const UNAVAILABLE_RETRY_AFTER = '5';

/** Record statuses an owner request may wake from; others keep their existing routing answers. */
const WAKEABLE_STATUSES = new Set(['running', 'stopped', 'suspending', 'suspended', 'resuming']);

type Log = (message: string, detail: Record<string, string>) => void;
const defaultLog: Log = (message, detail) => console.error(message, JSON.stringify(detail));

export interface WakeIdentity {
  userId: string;
  source?: string;
}

export type SubstrateWakeDecision =
  | { kind: 'proceed'; machine: UserMachineRecord }
  | { kind: 'not_ready'; state: 'waking' | 'busy' }
  | { kind: 'unavailable'; retryAfter: string | null };

export interface SubstrateWakeDeps {
  db: PlatformDB;
  substrates: SubstrateRegistry;
  machine: UserMachineRecord;
  identity: WakeIdentity;
  logError?: Log;
}

export interface SubstrateWakeInput extends SubstrateWakeDeps {
  c: Context;
  /** JSON for API, gateway, and code-domain callers; a self-refreshing page for browser navigation. */
  respondWithJson: boolean;
  applyNoStoreHeaders: (c: Context) => void;
}

export type SubstrateWakeOutcome =
  | { kind: 'proceed'; machine: UserMachineRecord }
  | { kind: 'respond'; response: Response };

export function isRuntimeOwner(machine: Pick<UserMachineRecord, 'clerkUserId'>, identity: WakeIdentity): boolean {
  return identity.source === 'auth' && Boolean(identity.userId) && identity.userId === machine.clerkUserId;
}

/** A non-VPS machine in a state an owner request may wake; it takes the proxy path even while not routable. */
export function takesOnDemandPath(machine: Pick<UserMachineRecord, 'substrate' | 'status'>): boolean {
  return machine.substrate !== 'vps' && WAKEABLE_STATUSES.has(machine.status);
}

/** Navigation gets the boot page; data, API, and non-HTML callers get JSON. */
export function prefersJsonWakeResponse(acceptHeader: string | undefined, isDataPath: boolean): boolean {
  return isDataPath || !(acceptHeader ?? '').toLowerCase().includes('text/html');
}

// ---------------------------------------------------------------------------
// Single-flight wake per machine

interface WakeResult {
  result: EnsureRunningResult;
  machine?: UserMachineRecord;
}

// Insertion-ordered and capped; entries remove themselves when they settle.
const inFlightWakes = new Map<string, Promise<WakeResult>>();

/**
 * Records `running` after the substrate reports it, with one compare-and-set
 * on the status and generation the wake started from, so a concurrent
 * replacement or deletion is never overwritten.
 */
async function markRunning(db: PlatformDB, machine: UserMachineRecord): Promise<WakeResult> {
  if (machine.status !== 'running') {
    await db.ready;
    const row = await db.executor.updateTable('user_machines')
      .set({ status: 'running' })
      .where('machine_id', '=', machine.machineId)
      .where('generation', '=', machine.generation)
      .where('status', '=', machine.status)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    if (row) return { result: { state: 'running' }, machine: mapUserMachine(row) };
  }
  const current = await getUserMachine(db, machine.machineId);
  if (!current || current.deletedAt || current.generation !== machine.generation) {
    return { result: { state: 'failed', code: 'needs_recovery' } };
  }
  // Another writer moved the record (for example the sleeper); the client retries on `waking`.
  if (current.status !== 'running') return { result: { state: 'starting' } };
  return { result: { state: 'running' }, machine: current };
}

async function runWake(db: PlatformDB, substrate: RuntimeSubstrate, machine: UserMachineRecord, log: Log): Promise<WakeResult> {
  let result: EnsureRunningResult;
  try {
    result = await substrate.ensureRunning({
      machineId: machine.machineId, handle: machine.handle, runtimeSlot: machine.runtimeSlot, generation: machine.generation,
    }, AbortSignal.timeout(WAKE_TIMEOUT_MS));
  } catch (error: unknown) {
    log('[substrate-wake] ensure running failed', {
      machineId: machine.machineId, cause: error instanceof Error ? error.name : 'unknown',
    });
    result = { state: 'failed', code: 'provider_unavailable' };
  }
  if (result.state !== 'running') return { result };
  try {
    return await markRunning(db, machine);
  } catch (error: unknown) {
    // A database failure is not "not found": answer unavailable and let the client retry.
    log('[substrate-wake] recording running failed', {
      machineId: machine.machineId, cause: error instanceof Error ? error.name : 'unknown',
    });
    return { result: { state: 'failed', code: 'provider_unavailable' } };
  }
}

function sharedWake(db: PlatformDB, substrate: RuntimeSubstrate, machine: UserMachineRecord, log: Log): Promise<WakeResult> {
  const pending = inFlightWakes.get(machine.machineId);
  if (pending) return pending;
  const promise = runWake(db, substrate, machine, log).finally(() => {
    if (inFlightWakes.get(machine.machineId) === promise) inFlightWakes.delete(machine.machineId);
  });
  inFlightWakes.set(machine.machineId, promise);
  while (inFlightWakes.size > WAKE_IN_FLIGHT_MAX) {
    // The evicted wake still completes; later callers just stop sharing it.
    const oldest = inFlightWakes.keys().next().value;
    if (oldest === undefined) break;
    inFlightWakes.delete(oldest);
  }
  return promise;
}

/**
 * Decides whether a request may proceed to the upstream. VPS machines, an
 * unconfigured substrate, and records in non-wakeable states pass through
 * untouched so the existing routing answers apply.
 */
export async function decideOnDemandWake(input: SubstrateWakeDeps): Promise<SubstrateWakeDecision> {
  const { machine, identity } = input;
  if (machine.substrate === 'vps') return { kind: 'proceed', machine };
  const lookup = input.substrates.get(machine.substrate);
  if (!lookup.ok || !lookup.substrate.startsOnDemand) return { kind: 'proceed', machine };
  if (input.substrates.resolveUpstream(machine, { path: '/' }).kind === 'upstream') return { kind: 'proceed', machine };
  if (!WAKEABLE_STATUSES.has(machine.status)) return { kind: 'proceed', machine };
  if (!isRuntimeOwner(machine, identity)) return { kind: 'unavailable', retryAfter: null };

  const log = input.logError ?? defaultLog;
  const { result, machine: current } = await sharedWake(input.db, lookup.substrate, machine, log);
  switch (result.state) {
    case 'running':
      return current ? { kind: 'proceed', machine: current } : { kind: 'unavailable', retryAfter: null };
    case 'starting':
      return { kind: 'not_ready', state: 'waking' };
    case 'busy':
      return { kind: 'not_ready', state: 'busy' };
    case 'failed':
      if (result.code === 'needs_recovery') {
        log('[substrate-wake] runtime needs_recovery; operator action required', {
          machineId: machine.machineId, substrate: machine.substrate,
        });
        return { kind: 'unavailable', retryAfter: null };
      }
      return { kind: 'unavailable', retryAfter: UNAVAILABLE_RETRY_AFTER };
  }
}

/** The 503 answer for a request that did not proceed: status, Retry-After, and JSON body. */
export function wakeRefusal(decision: Exclude<SubstrateWakeDecision, { kind: 'proceed' }>): {
  retryAfter: string | null;
  body: Record<string, string>;
} {
  if (decision.kind === 'unavailable') {
    return { retryAfter: decision.retryAfter, body: { error: 'Matrix computer unavailable', code: 'runtime_unavailable' } };
  }
  return {
    retryAfter: decision.state === 'waking' ? WAKING_RETRY_AFTER : BUSY_RETRY_AFTER,
    body: { error: 'Matrix computer not ready', runtimeState: decision.state },
  };
}

/** Called after authorization and entitlement checks, before the upstream is resolved. */
export async function prepareOnDemandUpstream(input: SubstrateWakeInput): Promise<SubstrateWakeOutcome> {
  const decision = await decideOnDemandWake(input);
  if (decision.kind === 'proceed') return decision;
  const { c } = input;
  const refusal = wakeRefusal(decision);
  input.applyNoStoreHeaders(c);
  if (refusal.retryAfter) c.header('Retry-After', refusal.retryAfter);
  if (decision.kind === 'not_ready' && !input.respondWithJson) {
    return { kind: 'respond', response: c.html(getVpsBootPage({ status: decision.state === 'waking' ? 'starting' : decision.state }), 503) };
  }
  return { kind: 'respond', response: c.json(refusal.body, 503) };
}

// ---------------------------------------------------------------------------
// Owner activity

// Insertion-ordered LRU of the last write per machine, capped at OWNER_ACTIVITY_CACHE_MAX.
const ownerActivityWrites = new Map<string, number>();

/**
 * Stamps `last_activity_at`, at most once per machine per minute. The
 * single UPDATE never moves the stamp backwards. Returns whether it wrote.
 */
export async function recordOwnerActivity(db: PlatformDB, machineId: string, now: Date): Promise<boolean> {
  const nowMs = now.getTime();
  const last = ownerActivityWrites.get(machineId);
  if (last !== undefined && nowMs - last < OWNER_ACTIVITY_WRITE_INTERVAL_MS) return false;
  ownerActivityWrites.delete(machineId);
  ownerActivityWrites.set(machineId, nowMs);
  while (ownerActivityWrites.size > OWNER_ACTIVITY_CACHE_MAX) {
    const oldest = ownerActivityWrites.keys().next().value;
    if (oldest === undefined) break;
    ownerActivityWrites.delete(oldest);
  }
  try {
    await db.ready;
    await db.executor.updateTable('user_machines')
      .set({ last_activity_at: now })
      .where('machine_id', '=', machineId)
      .where('deleted_at', 'is', null)
      .where((eb) => eb.or([eb('last_activity_at', 'is', null), eb('last_activity_at', '<', now)]))
      .execute();
  } catch (error: unknown) {
    // Let the next request retry instead of waiting out the throttle window.
    if (ownerActivityWrites.get(machineId) === nowMs) ownerActivityWrites.delete(machineId);
    throw error;
  }
  return true;
}

/** Fire-and-forget activity stamp for an owner request that reached an on-demand runtime. */
export function noteOwnerReachedRuntime(
  db: PlatformDB,
  machine: Pick<UserMachineRecord, 'machineId' | 'clerkUserId' | 'substrate'>,
  identity: WakeIdentity,
): void {
  if (machine.substrate === 'vps' || !isRuntimeOwner(machine, identity)) return;
  recordOwnerActivity(db, machine.machineId, new Date()).catch((error: unknown) => {
    console.error('[substrate-wake] owner activity write failed', error instanceof Error ? error.name : 'unknown');
  });
}
