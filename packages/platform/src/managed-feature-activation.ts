import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fundedHostActivationRevisionInput, type FundedHostActivationRequest } from '@matrix-os/contracts';
import { ZodError } from 'zod/v4';
import type { Dispatcher } from 'undici';
import { iterateRunningUserMachinePages, type PlatformDB, type UserMachineRecord } from './db.js';
import { isAdmittedFundedRelayOrigin, readFundedHostActivation } from './funded-host-activation.js';
import { buildPlatformRuntimeVerificationToken, buildPlatformVerificationToken } from './platform-token.js';
import { readBoundedHostJson } from './speech/host-readiness.js';
import type { SubstrateRegistry } from './substrates/registry.js';
import { readRuntimeAsleep } from './substrates/runtime-asleep.js';
import { applyUpstreamCredentials, needsVerifiedTransport, verifiedDispatcher } from './substrates/upstream-transport.js';

const FUNDED_CONFIG_PATH = '/api/internal/platform-funded-ai/config';

/** Issue paths only: a Zod message or input can carry configuration values. */
function deferredDetail(error: unknown): [string] | [string, { paths: string[] }] {
  if (error instanceof ZodError) return ['ZodError', { paths: error.issues.slice(0, 8).map(issue => issue.path.join('.')) }];
  return [error instanceof Error ? error.name : 'UnknownError'];
}

export interface ManagedFeatureActivationTarget {
  handle?: string; afterMachineId?: string;
  /** Aborts the page early (shutdown of an in-process caller); the page timeout still applies. */
  signal?: AbortSignal;
}
export interface ManagedFeatureActivationPage { activated: number; failed: number; complete: boolean; nextCursor: string | null }
export type ManagedFeatureActivator = (target: ManagedFeatureActivationTarget) => Promise<ManagedFeatureActivationPage>;

/** Each call handles one bounded page; failures never prevent another feature's reconciliation. */
export function createManagedFeatureActivator(options: {
  db: PlatformDB; platformSecret: string; relayOrigin: string; fundedAiEnabled: boolean; speechEnabled: boolean;
  activateSpeech: (target: { handle: string; signal?: AbortSignal }) => Promise<{ activated: number; failed: number }>;
  /** Reaches non-VPS runtimes (metal) through their host ingress; without it they are deferred, never sent to publicIPv4. */
  substrates?: Pick<SubstrateRegistry, 'resolveUpstream'>;
  fetchImpl?: typeof fetch; fetchDispatcher?: Dispatcher; now?: () => Date; wait?: (ms: number) => Promise<void>; pageTimeoutMs?: number;
}): ManagedFeatureActivator {
  const fetchImpl = options.fetchImpl ?? fetch;
  // Guests accept only the reviewed relay pin (contracts and the guest's
  // configure script). A deployment configured with another relay can never
  // activate; say so once instead of failing every runtime on every pass.
  const relayAdmitted = !options.fundedAiEnabled || isAdmittedFundedRelayOrigin(options.relayOrigin);
  if (!relayAdmitted) {
    console.error('[managed-features] funded activation disabled: the configured relay origin is outside the reviewed relay pin');
  }
  const pageTimeoutMs = options.pageTimeoutMs ?? 110_000;
  if (!Number.isInteger(pageTimeoutMs) || pageTimeoutMs < 1 || pageTimeoutMs > 110_000) throw new RangeError('Invalid activation page timeout');
  const wait = (ms: number, signal: AbortSignal) => options.wait ? options.wait(ms) : delay(ms, undefined, { signal });
  const pageSize = 8;
  type HostAnswer = { asleep: true } | { asleep: false; response: Response };
  type HostSend = (method: 'GET' | 'POST', body?: string) => Promise<HostAnswer>;
  /**
   * How funded config reaches the runtime gateway. A VPS is called on its
   * public IPv4 with the shared VPS pool, unchanged. A metal VM has no public
   * address: it is reached through its substrate upstream (the host ingress
   * credential, verified TLS, and handle Host the routing proxy uses), and an
   * ingress-marked `runtime_asleep` answer is reported, never retried, so
   * activation cannot wake a VM. Neither path stamps owner activity.
   */
  function hostChannel(machine: UserMachineRecord, signal: AbortSignal): HostSend | null {
    const timed = () => AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const bearer = () => `Bearer ${buildPlatformVerificationToken(machine.handle, options.platformSecret)}`;
    if (machine.substrate === 'vps') {
      if (!machine.publicIPv4) return null;
      const path = `https://${machine.publicIPv4}:443${FUNDED_CONFIG_PATH}`;
      const requestOptions = () => ({ headers: { authorization: bearer() },
        signal: timed(), redirect: 'error' as const,
        ...(options.fetchDispatcher ? { dispatcher: options.fetchDispatcher } : {}) }) as RequestInit & { dispatcher?: Dispatcher };
      return async (method, body) => {
        const base = requestOptions();
        const init = body === undefined ? { ...base, method }
          : { ...base, method, headers: { ...base.headers, 'content-type': 'application/json' }, body };
        return { asleep: false, response: await fetchImpl(path, init) };
      };
    }
    const resolution = options.substrates?.resolveUpstream(machine, { path: FUNDED_CONFIG_PATH });
    if (!resolution || resolution.kind !== 'upstream') return null;
    const { upstream } = resolution;
    return async (method, body) => {
      const headers = new Headers({ authorization: bearer() });
      if (body !== undefined) headers.set('content-type', 'application/json');
      applyUpstreamCredentials(headers, upstream);
      const response = await fetchImpl(upstream.url, { method, headers, signal: timed(), redirect: 'error',
        ...(body === undefined ? {} : { body }),
        ...(needsVerifiedTransport(upstream) ? { dispatcher: verifiedDispatcher(upstream) } : {}),
      } as RequestInit);
      const peeked = await readRuntimeAsleep(response);
      return peeked.asleep ? { asleep: true } : { asleep: false, response: peeked.response };
    };
  }
  async function activateFunded(machine: UserMachineRecord, signal: AbortSignal): Promise<'ready' | 'skipped' | 'failed'> {
    signal.throwIfAborted();
    if (!options.fundedAiEnabled || !relayAdmitted || machine.runtimeSlot !== 'primary') return 'skipped';
    const token = buildPlatformRuntimeVerificationToken({ handle: machine.handle, machineId: machine.machineId,
      runtimeSlot: machine.runtimeSlot }, options.platformSecret, machine.runtimeTokenEpoch);
    const eligibility = await readFundedHostActivation({ db: options.db, platformSecret: options.platformSecret,
      relayOrigin: options.relayOrigin, handle: machine.handle, runtimeSlot: machine.runtimeSlot,
      authorization: `Bearer ${token}`, now: options.now });
    signal.throwIfAborted();
    if (eligibility.status === 'ineligible') return 'skipped';
    if (eligibility.status !== 'ready') return 'failed';
    const { issuedAt: _issuedAt, expiresAt: _expiresAt, ...body } = eligibility.configuration;
    const expected = createHash('sha256').update(fundedHostActivationRevisionInput(body)).digest('hex');
    const send = hostChannel(machine, signal);
    if (!send) return 'failed';
    const configured = async (): Promise<boolean | 'asleep'> => {
      const answer = await send('GET');
      if (answer.asleep) return 'asleep';
      const result = await readBoundedHostJson(answer.response, 1024) as { configured?: unknown; configurationRevision?: unknown } | null;
      return result?.configured === true && result.configurationRevision === expected;
    };
    const initial = await configured();
    if (initial === 'asleep') return 'skipped';
    if (initial) return 'ready';
    const posted = await send('POST', JSON.stringify(body satisfies FundedHostActivationRequest));
    if (posted.asleep) return 'skipped';
    await posted.response.body?.cancel();
    if (!posted.response.ok) return 'failed';
    for (let attempt = 0; attempt < 12; attempt += 1) {
      signal.throwIfAborted();
      await wait(1000, signal);
      signal.throwIfAborted();
      try {
        const state = await configured();
        if (state === 'asleep') return 'skipped';
        if (state) return 'ready';
      } catch (error: unknown) {
        if (signal.aborted || attempt === 11) throw error;
      }
    }
    return 'failed';
  }
  return async ({ signal: callerSignal, ...target }) => {
    if (!options.fundedAiEnabled && !options.speechEnabled) return { activated: 0, failed: 0, complete: true, nextCursor: null };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Activation page timed out', 'TimeoutError')), pageTimeoutMs);
    timer.unref();
    const signal = controller.signal;
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) onCallerAbort();
    else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    try {
      const pages = iterateRunningUserMachinePages(options.db, pageSize, { ...target, provisioningClass: 'customer', activationState: 'authorized' });
      const first = await pages.next();
      await pages.return(undefined);
      const machines = first.done ? [] : first.value;
      const results = new Array<{ activated: boolean; failed: boolean }>(machines.length);
      let next = 0;
      // Start every host in the bounded page before waiting on a slow host.
      await Promise.all(Array.from({ length: Math.min(pageSize, machines.length) }, async () => {
        while (next < machines.length) {
          const index = next++;
          const machine = machines[index]!;
          if (signal.aborted) { results[index] = { activated: false, failed: true }; continue; }
          const [funded, speechReady] = await Promise.all([
            activateFunded(machine, signal).catch((error: unknown) => {
              console.warn('[managed-features] funded activation deferred', ...deferredDetail(error));
              return 'failed' as const;
            }),
            (async () => {
              if (!options.speechEnabled) return true;
              try {
                signal.throwIfAborted();
                const speech = await options.activateSpeech({ handle: machine.handle, signal });
                return speech.failed === 0 && speech.activated > 0;
              } catch (error: unknown) {
                console.warn('[managed-features] speech activation deferred', error instanceof Error ? error.name : 'UnknownError');
                return false;
              }
            })(),
          ]);
          const failed = funded === 'failed' || !speechReady;
          results[index] = { activated: !failed && (options.speechEnabled || funded === 'ready'), failed };
        }
      }));
      const complete = target.handle !== undefined || machines.length < pageSize;
      return { activated: results.filter(result => result.activated).length,
        failed: results.filter(result => result.failed).length,
        complete, nextCursor: complete ? null : machines.at(-1)!.machineId };
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  };
}

/** Restarting a worker loses only its bounded cursor; the next pass starts from the first page. */
export function createManagedFeatureReconciliationPass(activate: ManagedFeatureActivator): () => Promise<void> {
  let cursor: string | null = null;
  return async () => {
    const result = await activate(cursor ? { afterMachineId: cursor } : {});
    cursor = result.complete ? null : result.nextCursor;
    if (result.activated || result.failed) console.info(`[managed-features] reconciled activated=${result.activated} deferred=${result.failed}`);
  };
}

export interface ManagedFeatureResumeTrigger {
  (machine: { handle: string }): void;
  /** Targeted activations still running (for tests and shutdown visibility). */
  inFlight(): number;
  /** Rejects new triggers and aborts in-flight activations. */
  stop(): void;
  /** Resolves once every in-flight activation has settled. */
  drain(): Promise<void>;
}

/**
 * Activates a runtime right after an on-demand substrate resumed it, instead
 * of waiting for the paged periodic pass to come round. Fire-and-forget: one
 * activation per handle at a time, at most `maxInFlight` in total (extra
 * resumes are left to the periodic pass), and failures logged by name only.
 * Shutdown calls stop() (no new work, in-flight pages aborted) then drain().
 */
export function createManagedFeatureResumeTrigger(activate: ManagedFeatureActivator,
  limits: { maxInFlight?: number } = {}): ManagedFeatureResumeTrigger {
  const maxInFlight = limits.maxInFlight ?? 32;
  // Keyed by handle; bounded by maxInFlight, entries remove themselves when settled.
  const running = new Map<string, Promise<void>>();
  const stopping = new AbortController();
  const trigger = ((machine: { handle: string }) => {
    if (stopping.signal.aborted || running.has(machine.handle)) return;
    if (running.size >= maxInFlight) {
      console.warn('[managed-features] resume activation deferred to the periodic pass');
      return;
    }
    let pending: Promise<ManagedFeatureActivationPage>;
    try { pending = activate({ handle: machine.handle, signal: stopping.signal }); }
    catch (error: unknown) { pending = Promise.reject(error); }
    const settled = pending.then((result) => {
      if (result.failed > 0) {
        console.warn('[managed-features] resume activation deferred',
          { handle: machine.handle, activated: result.activated, failed: result.failed });
      }
    }, (error: unknown) => {
      console.warn('[managed-features] resume activation failed', error instanceof Error ? error.name : 'UnknownError');
    }).finally(() => { running.delete(machine.handle); });
    running.set(machine.handle, settled);
  }) as ManagedFeatureResumeTrigger;
  trigger.inFlight = () => running.size;
  trigger.stop = () => { stopping.abort(new DOMException('Platform shutting down', 'AbortError')); };
  trigger.drain = async () => { await Promise.allSettled([...running.values()]); };
  return trigger;
}
