import type { Context } from 'hono';
import type { RuntimeState } from '@matrix-os/contracts';
import { getUserMachine } from '../database/user-machines.js';
import type { PlatformDB, UserMachineRecord } from '../db.js';
import { getVpsBootPage } from '../vps-boot-page.js';
import type { SubstrateRegistry } from './registry.js';
import type { EnsureRunningResult, RuntimeUpstream } from './types.js';

/**
 * Only an authenticated request from a container runtime's owner starts its
 * compute (spec 2691, "Who may wake a runtime"). Collaborators, share-link
 * viewers, and credential-less routes reach a running container but get "not
 * available" otherwise. Concurrent owner requests share one start through the
 * lifecycle's single-flight compare-and-set.
 */

const ENSURE_RUNNING_TIMEOUT_MS = 15_000;
const WAKING_RETRY_AFTER_SECONDS = '3';
const BUSY_RETRY_AFTER_SECONDS = '30';

export type ContainerWakeOutcome =
  | { kind: 'proceed'; machine: UserMachineRecord }
  | { kind: 'respond'; response: Response };

export interface ContainerWakeInput {
  c: Context;
  db: PlatformDB;
  substrates: SubstrateRegistry;
  machine: UserMachineRecord;
  identity: { userId: string; source?: string };
  /** JSON for API, gateway, and code-domain callers; a self-refreshing page for browser navigation. */
  respondWithJson: boolean;
  applyNoStoreHeaders: (c: Context) => void;
  logError?: (message: string, detail: Record<string, string>) => void;
}

function isOwnerRequest(input: ContainerWakeInput): boolean {
  return input.identity.source === 'auth' && Boolean(input.identity.userId)
    && input.identity.userId === input.machine.clerkUserId;
}

function stateResponse(input: ContainerWakeInput, state: RuntimeState, retryAfter: string | null): Response {
  const { c } = input;
  input.applyNoStoreHeaders(c);
  if (retryAfter) c.header('Retry-After', retryAfter);
  if (input.respondWithJson) return c.json({ error: 'Matrix computer not ready', runtimeState: state }, 503);
  return c.html(getVpsBootPage({ status: state === 'waking' ? 'starting' : state }), 503);
}

function respondTo(input: ContainerWakeInput, result: Exclude<EnsureRunningResult, { state: 'running' }>): Response {
  if (result.state === 'starting') return stateResponse(input, 'waking', WAKING_RETRY_AFTER_SECONDS);
  if (result.state === 'busy') return stateResponse(input, 'busy', BUSY_RETRY_AFTER_SECONDS);
  return stateResponse(input, 'failed', null);
}

/**
 * Called after authorization and entitlement checks, before the upstream is
 * resolved. VPS machines pass through untouched. An unconfigured container
 * substrate also passes through so routing reports it as unavailable.
 */
export async function prepareContainerUpstream(input: ContainerWakeInput): Promise<ContainerWakeOutcome> {
  const { machine } = input;
  if (machine.substrate !== 'container') return { kind: 'proceed', machine };
  const lookup = input.substrates.get('container');
  if (!lookup.ok) return { kind: 'proceed', machine };
  if (!isOwnerRequest(input)) {
    if (input.substrates.resolveUpstream(machine, { path: '/' }).kind === 'upstream') return { kind: 'proceed', machine };
    input.applyNoStoreHeaders(input.c);
    return { kind: 'respond', response: input.c.json({ error: 'Matrix computer unavailable', code: 'runtime_unavailable' }, 503) };
  }
  let result: EnsureRunningResult;
  try {
    result = await lookup.substrate.ensureRunning({
      machineId: machine.machineId, handle: machine.handle, runtimeSlot: machine.runtimeSlot, generation: machine.generation,
    }, AbortSignal.timeout(ENSURE_RUNNING_TIMEOUT_MS));
  } catch (error: unknown) {
    (input.logError ?? ((message, detail) => console.error(message, detail)))(
      '[container-wake] ensure running failed', { cause: error instanceof Error ? error.name : 'unknown' });
    result = { state: 'failed', code: 'provider_unavailable' };
  }
  if (result.state !== 'running') return { kind: 'respond', response: respondTo(input, result) };
  const current = await getUserMachine(input.db, machine.machineId);
  if (!current || current.deletedAt) return { kind: 'respond', response: respondTo(input, { state: 'failed', code: 'needs_recovery' }) };
  return { kind: 'proceed', machine: current };
}

/** Platform-to-runtime credentials are set last so a client header of the same name cannot replace them. */
export function applyUpstreamCredentials(headers: Headers, upstream: RuntimeUpstream): void {
  for (const [name, value] of Object.entries(upstream.headers ?? {})) headers.set(name, value);
}

/** Never hand a runtime credential back to the client, even if the upstream echoes it. */
export function stripUpstreamCredentials(headers: Headers, upstream: RuntimeUpstream): void {
  for (const name of Object.keys(upstream.headers ?? {})) headers.delete(name);
}
