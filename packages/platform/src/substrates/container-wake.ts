import type { Context } from 'hono';
import type { RuntimeState } from '@matrix-os/contracts';
import type { PlatformDB, UserMachineRecord } from '../db.js';
import { getVpsBootPage } from '../vps-boot-page.js';
import type { SubstrateRegistry } from './registry.js';
import type { RuntimeUpstream } from './types.js';
import { decideContainerWake } from './container-websocket.js';
import { isMeaningfulOwnerRequest } from './idle-reaper.js';
import type { ExportRequestLike } from './container-export-only.js';

export { isExportOnlyRequest } from './container-export-only.js';

/**
 * Only an authenticated request from a container runtime's owner starts its
 * compute (spec 2691, "Who may wake a runtime"). Collaborators, share-link
 * viewers, and credential-less routes reach a running container but get "not
 * available" otherwise. Concurrent owner requests share one start through the
 * lifecycle's single-flight compare-and-set.
 */

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

function stateResponse(input: ContainerWakeInput, state: RuntimeState, retryAfter: string | null): Response {
  const { c } = input;
  input.applyNoStoreHeaders(c);
  if (retryAfter) c.header('Retry-After', retryAfter);
  if (input.respondWithJson) return c.json({ error: 'Matrix computer not ready', runtimeState: state }, 503);
  return c.html(getVpsBootPage({ status: state === 'waking' ? 'starting' : state }), 503);
}

/**
 * The monthly compute cap answers 429 with Retry-After at the reset: it is a
 * quota with a known end, not an outage (503 is what clients retry) and not
 * an access denial (403 means sign-in, entitlement, or waitlist to clients).
 * The body's `limit_reached` is a terminal state for the shared client
 * model, so it does not retry; the reset is days away in any case.
 */
function limitResponse(input: ContainerWakeInput, resetsAt: string): Response {
  const { c } = input;
  input.applyNoStoreHeaders(c);
  c.header('Retry-After', String(Math.max(1, Math.ceil((Date.parse(resetsAt) - Date.now()) / 1_000))));
  if (input.respondWithJson) {
    return c.json({ error: 'Matrix computer limit reached', runtimeState: 'limit_reached', limit: 'compute', resetsAt }, 429);
  }
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Monthly compute limit reached</title></head>
<body><main role="status"><h1>Monthly compute limit reached</h1>
<p>Your Matrix computer starts again on <time datetime="${resetsAt}">${resetsAt.slice(0, 10)}</time> (UTC).</p></main></body></html>`, 429);
}

/** The path the runtime would see: the explicit `/vm/<handle>` prefix is the platform's own. */
function upstreamRequest(input: ContainerWakeInput): ExportRequestLike {
  const { c, machine } = input;
  const prefix = `/vm/${machine.handle}`;
  const path = c.req.path === prefix ? '/' : c.req.path.startsWith(`${prefix}/`) ? c.req.path.slice(prefix.length) : c.req.path;
  return { method: c.req.method, path, header: name => c.req.header(name) };
}

const RETRY_AFTER: Record<'waking' | 'busy' | 'failed', string | null> = {
  waking: WAKING_RETRY_AFTER_SECONDS, busy: BUSY_RETRY_AFTER_SECONDS, failed: null,
};

/**
 * Called after authorization and entitlement checks, before the upstream is
 * resolved. VPS machines pass through untouched. An unconfigured container
 * substrate also passes through so routing reports it as unavailable.
 */
export async function prepareContainerUpstream(input: ContainerWakeInput): Promise<ContainerWakeOutcome> {
  observeOwnerActivity(input);
  const decision = await decideContainerWake({ ...input, request: upstreamRequest(input) });
  if (decision.kind === 'proceed') return decision;
  if (decision.kind === 'limit_reached') return { kind: 'respond', response: limitResponse(input, decision.resetsAt) };
  if (decision.kind === 'unavailable') {
    input.applyNoStoreHeaders(input.c);
    return { kind: 'respond', response: input.c.json({ error: 'Matrix computer unavailable', code: 'runtime_unavailable' }, 503) };
  }
  return { kind: 'respond', response: stateResponse(input, decision.state, RETRY_AFTER[decision.state]) };
}

/**
 * Recorded before the wake decision, so an owner who comes back while a stop
 * is quiescing can cancel it. Only the owner's own verified session counts.
 */
function observeOwnerActivity(input: ContainerWakeInput): void {
  const { machine, identity, c } = input;
  if (machine.substrate !== 'container' || identity.source !== 'auth' || !identity.userId
    || identity.userId !== machine.clerkUserId) return;
  if (!isMeaningfulOwnerRequest({ method: c.req.method, path: c.req.path, header: name => c.req.header(name) })) return;
  const lookup = input.substrates.get('container');
  if (lookup.ok) lookup.substrate.recordOwnerActivity?.(machine.machineId);
}

/** Platform-to-runtime credentials are set last so a client header of the same name cannot replace them. */
export function applyUpstreamCredentials(headers: Headers, upstream: RuntimeUpstream): void {
  for (const [name, value] of Object.entries(upstream.headers ?? {})) headers.set(name, value);
}

/** Never hand a runtime credential back to the client, even if the upstream echoes it. */
export function stripUpstreamCredentials(headers: Headers, upstream: RuntimeUpstream): void {
  for (const name of Object.keys(upstream.headers ?? {})) headers.delete(name);
}
