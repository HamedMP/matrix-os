import { createHash } from 'node:crypto';
import { fundedHostActivationRevisionInput, type FundedHostActivationRequest } from '@matrix-os/contracts';
import type { Dispatcher } from 'undici';
import { iterateRunningUserMachinePages, type PlatformDB, type UserMachineRecord } from './db.js';
import { readFundedHostActivation } from './funded-host-activation.js';
import { buildPlatformRuntimeVerificationToken, buildPlatformVerificationToken } from './platform-token.js';
import { readBoundedHostJson } from './speech/host-readiness.js';

export interface ManagedFeatureActivationTarget { handle?: string; afterMachineId?: string }
export interface ManagedFeatureActivationPage { activated: number; failed: number; complete: boolean; nextCursor: string | null }
export type ManagedFeatureActivator = (target: ManagedFeatureActivationTarget) => Promise<ManagedFeatureActivationPage>;

/** Each call handles one bounded page; failures never prevent another feature's reconciliation. */
export function createManagedFeatureActivator(options: {
  db: PlatformDB; platformSecret: string; relayOrigin: string; fundedAiEnabled: boolean; speechEnabled: boolean;
  activateSpeech: (target: { handle: string }) => Promise<{ activated: number; failed: number }>;
  fetchImpl?: typeof fetch; fetchDispatcher?: Dispatcher; now?: () => Date; wait?: (ms: number) => Promise<void>;
}): ManagedFeatureActivator {
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const pageSize = 8;
  async function activateFunded(machine: UserMachineRecord): Promise<'ready' | 'skipped' | 'failed'> {
    if (!options.fundedAiEnabled || machine.runtimeSlot !== 'primary') return 'skipped';
    const token = buildPlatformRuntimeVerificationToken({ handle: machine.handle, machineId: machine.machineId,
      runtimeSlot: machine.runtimeSlot }, options.platformSecret, machine.runtimeTokenEpoch);
    const eligibility = await readFundedHostActivation({ db: options.db, platformSecret: options.platformSecret,
      relayOrigin: options.relayOrigin, handle: machine.handle, runtimeSlot: machine.runtimeSlot,
      authorization: `Bearer ${token}`, now: options.now });
    if (eligibility.status === 'ineligible') return 'skipped';
    if (eligibility.status !== 'ready' || !machine.publicIPv4) return 'failed';
    const { issuedAt: _issuedAt, expiresAt: _expiresAt, ...body } = eligibility.configuration;
    const expected = createHash('sha256').update(fundedHostActivationRevisionInput(body)).digest('hex');
    const path = `https://${machine.publicIPv4}:443/api/internal/platform-funded-ai/config`;
    const requestOptions = () => ({ headers: { authorization: `Bearer ${buildPlatformVerificationToken(machine.handle, options.platformSecret)}` },
      signal: AbortSignal.timeout(10_000), redirect: 'error' as const,
      ...(options.fetchDispatcher ? { dispatcher: options.fetchDispatcher } : {}) }) as RequestInit & { dispatcher?: Dispatcher };
    const configured = async () => {
      const response = await fetchImpl(path, { ...requestOptions(), method: 'GET' });
      const result = await readBoundedHostJson(response, 1024) as { configured?: unknown; configurationRevision?: unknown } | null;
      return result?.configured === true && result.configurationRevision === expected;
    };
    if (await configured()) return 'ready';
    const response = await fetchImpl(path, { ...requestOptions(), method: 'POST',
      headers: { ...requestOptions().headers, 'content-type': 'application/json' },
      body: JSON.stringify(body satisfies FundedHostActivationRequest) });
    await response.body?.cancel();
    if (!response.ok) return 'failed';
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await wait(1000);
      try { if (await configured()) return 'ready'; }
      catch (error: unknown) {
        if (attempt === 11) throw error;
      }
    }
    return 'failed';
  }
  return async target => {
    if (!options.fundedAiEnabled && !options.speechEnabled) return { activated: 0, failed: 0, complete: true, nextCursor: null };
    const pages = iterateRunningUserMachinePages(options.db, pageSize, { ...target, provisioningClass: 'customer', activationState: 'authorized' });
    const first = await pages.next();
    await pages.return(undefined);
    const machines = first.done ? [] : first.value;
    const results = new Array<{ activated: boolean; failed: boolean }>(machines.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, machines.length) }, async () => {
      while (next < machines.length) {
        const index = next++;
        const machine = machines[index]!;
        let funded: 'ready' | 'skipped' | 'failed' = 'failed';
        let speechReady = !options.speechEnabled;
        try { funded = await activateFunded(machine); }
        catch (error: unknown) { console.warn('[managed-features] funded activation deferred', error instanceof Error ? error.name : 'UnknownError'); }
        if (options.speechEnabled) {
          try {
            const speech = await options.activateSpeech({ handle: machine.handle });
            speechReady = speech.failed === 0 && speech.activated === 1;
          } catch (error: unknown) { console.warn('[managed-features] speech activation deferred', error instanceof Error ? error.name : 'UnknownError'); }
        }
        const failed = funded === 'failed' || !speechReady;
        results[index] = { activated: !failed && (options.speechEnabled || funded === 'ready'), failed };
      }
    }));
    const complete = target.handle !== undefined || machines.length < pageSize;
    return { activated: results.filter(result => result.activated).length,
      failed: results.filter(result => result.failed).length,
      complete, nextCursor: complete ? null : machines.at(-1)!.machineId };
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
