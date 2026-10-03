import { randomUUID, createHash } from 'node:crypto';
import { ProviderWorkflowSchema, ProviderWorkflowCapabilitySchema, type ProviderWorkflow, type ProviderWorkflowCapability, type ProviderWorkflowStart, type ProviderWorkflowKey, type ProviderWorkflowLogs } from '@matrix-os/contracts';
export class ProviderWorkflowError extends Error {
  constructor(readonly code: 'unavailable' | 'not_found' | 'conflict' | 'rejected' | 'forbidden') { super(code); }
}
/** Adapter proves launch failed before acquiring any native resource or writer. */
export class ProviderWorkflowNotStartedError extends ProviderWorkflowError {
  constructor() { super('unavailable'); }
}
/** Adapter proves no bytes were submitted; all other failures remain ambiguous. */
export class ProviderWorkflowCodeNotAcceptedError extends ProviderWorkflowError {
  constructor(code: 'conflict' | 'unavailable' = 'conflict') { super(code); }
}
export interface ProviderWorkflowAdapter extends Omit<ProviderWorkflowCapability, 'logs'> {
  start(input: {
    request: ProviderWorkflowStart;
    /** Register before native side effects so uncertain starts can be reaped. */
    registerCleanup: (cancel: () => Promise<void>) => void;
    publish: (update: Partial<Pick<ProviderWorkflow, 'state' | 'deviceCode' | 'authorizationUrl' | 'safeFailure'>>) => void;
  }): Promise<{
    cancel: () => Promise<void>;
    terminalSessionId?: string;
    submitCode?: (code: string) => Promise<void>;
  }>;
  verifyKey?: (key: ProviderWorkflowKey) => Promise<void>;
}
const terminal = (state: ProviderWorkflow['state']) => ['succeeded', 'failed', 'cancelled', 'expired'].includes(state);
export function createProviderWorkflowService(options: {
  ownerId: string;
  adapters: readonly ProviderWorkflowAdapter[] | (() => Promise<readonly ProviderWorkflowAdapter[]>);
  now?: () => Date;
}) {
  if (!options.ownerId)
    throw new Error('Invalid workflow registration');
  async function registered() {
    const adapters = typeof options.adapters === 'function' ? await options.adapters() : options.adapters;
    if (adapters.length > 32 || new Set(adapters.map(a => a.harnessInstanceId)).size !== adapters.length)
      throw new Error('Invalid workflow registration');
    for (const adapter of adapters) {
      const { start: _start, verifyKey: _verify, ...capability } = adapter;
      ProviderWorkflowCapabilitySchema.parse({ ...capability, logs: true });
    }
    return adapters;
  }
  const now = options.now ?? (() => new Date());
  const entries = new Map<string, {
    operation: ProviderWorkflow;
    scope: ProviderWorkflowAdapter['harness'];
    method?: ProviderWorkflowStart['method'];
    key: string;
    hash: string;
    cancel?: () => Promise<void>;
    submitCode?: (code: string) => Promise<void>;
    codeSubmitted: boolean;
    cleanupRequired: boolean;
    events: ProviderWorkflowLogs['entries'];
  }>();
  let closed = false;
  let tail = Promise.resolve();
  let queued = 0;
  let probeWindow = 0;
  let probes = 0;
  function authorize(owner: string) {
    if (owner !== options.ownerId)
      throw new ProviderWorkflowError('forbidden');
    if (closed)
      throw new ProviderWorkflowError('unavailable');
  }
  async function serialize<T>(fn: () => Promise<T>, shutdown = false) {
    if (queued >= 4 && !shutdown)
      throw new ProviderWorkflowError('unavailable');
    queued += 1;
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(r => { release = r; });
    await previous;
    try {
      if (closed && !shutdown) throw new ProviderWorkflowError('unavailable');
      return await fn();
    }
    finally {
      queued -= 1;
      release();
    }
  }
  async function adapterFor(id: string) {
    const adapter = (await registered()).find(a => a.harnessInstanceId === id);
    if (!adapter)
      throw new ProviderWorkflowError('unavailable');
    return adapter;
  }
  function record(entry: (typeof entries extends Map<string, infer T> ? T : never), event: ProviderWorkflowLogs['entries'][number]['event']) {
    entry.events.push({ at: now().toISOString(), event });
    if (entry.events.length > 64)
      entry.events.shift();
  }
  const protectedEntry = (entry: (typeof entries extends Map<string, infer T> ? T : never)) =>
    entry.cleanupRequired || !terminal(entry.operation.state);
  async function expire(scope: ProviderWorkflowAdapter['harness']) {
    for (const entry of entries.values()) {
      if (entry.scope !== scope || terminal(entry.operation.state)
        || Date.parse(entry.operation.expiresAt) > now().getTime()) continue;
      entry.cleanupRequired = true;
      try {
        if (!entry.cancel) throw new ProviderWorkflowError('unavailable');
        await entry.cancel();
        entry.cleanupRequired = false;
        // Native completion may commit while cleanup awaits it.
        if (!terminal(entry.operation.state)) {
          entry.operation = { ...entry.operation, state: 'expired', deviceCode: null, authorizationUrl: null, safeFailure: 'expired' };
          record(entry, 'expired');
        }
      } catch (error) {
        console.warn('[provider-workflow] Expiry cleanup unavailable:', error instanceof Error ? error.name : 'UnknownError');
        if (!terminal(entry.operation.state)) {
          entry.operation = { ...entry.operation, state: 'expired', deviceCode: null, authorizationUrl: null, safeFailure: 'unavailable' };
          record(entry, 'expired');
        }
      }
    }
  }
  function get(id: string) {
    const entry = entries.get(id);
    if (!entry)
      throw new ProviderWorkflowError('not_found');
    return entry;
  }
  return {
    async capabilities(owner: string, legacy = false): Promise<ProviderWorkflowCapability[]> {
      authorize(owner);
      return (await registered()).map(({ harnessInstanceId, harness, displayName, installState, loginMethods, apiKeyProviders, install, uninstall }) => {
        const active = [...entries.values()].find(entry => entry.operation.harnessInstanceId === harnessInstanceId && protectedEntry(entry)
          && (!legacy || entry.operation.kind !== 'login' || entry.method === 'device_code' || entry.method === 'terminal'));
        return { harnessInstanceId, harness, displayName, installState, loginMethods, apiKeyProviders, install, uninstall, logs: true, ...(active ? { activeOperationId: active.operation.id } : {}) };
      });
    },
    async start(owner: string, request: ProviderWorkflowStart): Promise<ProviderWorkflow> {
      authorize(owner);
      return serialize(async () => {
        const adapter = await adapterFor(request.harnessInstanceId);
        await expire(adapter.harness);
        const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
        const replay = [...entries.values()].find(e => e.key === request.idempotencyKey);
        if (replay) {
          if (replay.hash !== hash)
            throw new ProviderWorkflowError('conflict');
          return { ...replay.operation };
        }
        if (request.kind === 'login' ? !request.method || !adapter.loginMethods.includes(request.method) : !adapter[request.kind])
          throw new ProviderWorkflowError('unavailable');
        if ([...entries.values()].some(e => e.scope === adapter.harness && protectedEntry(e)))
          throw new ProviderWorkflowError('conflict');
        if (entries.size >= 64) {
          const evict = [...entries].find(([, e]) => !protectedEntry(e));
          if (!evict)
            throw new ProviderWorkflowError('unavailable');
          entries.delete(evict[0]);
        }
        const operation: ProviderWorkflow = { id: `workflow_${randomUUID()}`, harnessInstanceId: request.harnessInstanceId, kind: request.kind, state: 'pending', expiresAt: new Date(now().getTime() + 600000).toISOString(), terminalSessionId: null, deviceCode: null, authorizationUrl: null, safeFailure: null };
        const entry = { operation, codeSubmitted: false, cleanupRequired: false, method: request.method, scope: adapter.harness, key: request.idempotencyKey, hash, events: [{ at: now().toISOString(), event: 'started' as const }], cancel: undefined as (() => Promise<void>) | undefined, submitCode: undefined as ((code: string) => Promise<void>) | undefined };
        entries.set(operation.id, entry);
        try {
          const running = await adapter.start({ request, registerCleanup(cancel) { entry.cancel = cancel; }, publish(update) {
              if (closed || terminal(entry.operation.state) && (!entry.cleanupRequired || update.state !== 'succeeded'))
                return;
              const next = ProviderWorkflowSchema.safeParse({ ...entry.operation, ...update });
              if (!next.success)
                return;
              entry.operation = next.data;
              if (terminal(entry.operation.state)) {
                entry.operation.deviceCode = null;
                entry.operation.authorizationUrl = null;
              }
              record(entry, entry.operation.state === 'pending' ? 'running' : entry.operation.state);
            } });
          entry.cancel = running.cancel;
          entry.submitCode = running.submitCode;
          entry.operation.terminalSessionId = running.terminalSessionId ?? null;
          if (entry.operation.state === 'pending')
            entry.operation.state = 'running';
        }
        catch (error) {
          console.warn('[provider-workflow] Start failed:', error instanceof Error ? error.name : 'UnknownError');
          // Only an explicit no-resource proof can free a failed preflight.
          // Registered cleanup still owns admission until it confirms the drain.
          entry.cleanupRequired = !(error instanceof ProviderWorkflowNotStartedError) || entry.cancel !== undefined;
          if (!terminal(entry.operation.state)) {
            entry.operation = { ...entry.operation, state: 'failed', safeFailure: 'unavailable', deviceCode: null, authorizationUrl: null };
            record(entry, 'failed');
          }
          if (entry.cancel) {
            try { await entry.cancel(); entry.cleanupRequired = false; }
            catch (cleanupError) { console.warn('[provider-workflow] Start cleanup unavailable:', cleanupError instanceof Error ? cleanupError.name : 'UnknownError'); }
          }
        }
        return { ...entry.operation };
      });
    },
    async status(owner: string, id: string) { authorize(owner); return serialize(async () => { const entry = get(id); await expire(entry.scope); return { ...entry.operation }; }); },
    async cancel(owner: string, id: string) {
      authorize(owner);
      return serialize(async () => {
        const entry = get(id);
        if (protectedEntry(entry)) {
          if (!entry.cancel)
            throw new ProviderWorkflowError('unavailable');
          entry.cleanupRequired = true;
          await entry.cancel();
          entry.cleanupRequired = false;
          // Cleanup may await a completion already committing. Its terminal
          // result wins; never report Cancelled after Connect actually succeeded.
          if (!terminal(entry.operation.state)) {
            entry.operation = { ...entry.operation, state: 'cancelled', deviceCode: null, authorizationUrl: null };
            record(entry, 'cancelled');
          }
        }
        return { ...entry.operation };
      });
    },
    async submitCode(owner: string, id: string, code: string) {
      authorize(owner);
      return serialize(async () => {
        const entry = get(id);
        await expire(entry.scope);
        if (entry.operation.kind !== 'login' || terminal(entry.operation.state) || !entry.submitCode || entry.codeSubmitted)
          throw new ProviderWorkflowError('conflict');
        entry.codeSubmitted = true;
        try { await entry.submitCode(code); }
        catch (error) {
          if (error instanceof ProviderWorkflowCodeNotAcceptedError) entry.codeSubmitted = false;
          throw error;
        }
        return { accepted: true as const };
      });
    },
    async verifyKey(owner: string, key: ProviderWorkflowKey) {
      authorize(owner);
      // Secret submissions must not wait behind unrelated operations and outlive
      // the foreground response budget before verification even begins.
      if (queued > 0) throw new ProviderWorkflowError('unavailable');
      return serialize(async () => {
        const timestamp = now().getTime();
        if (timestamp - probeWindow >= 60000) {
          probeWindow = timestamp;
          probes = 0;
        }
        if (++probes > 12)
          throw new ProviderWorkflowError('unavailable');
        const adapter = await adapterFor(key.harnessInstanceId);
        if (!adapter.verifyKey || !adapter.apiKeyProviders.includes(key.providerId))
          throw new ProviderWorkflowError('unavailable');
        await expire(adapter.harness);
        if ([...entries.values()].some(entry => entry.scope === adapter.harness && protectedEntry(entry)))
          throw new ProviderWorkflowError('conflict');
        await adapter.verifyKey(key);
        return { verified: true as const };
      });
    },
    async logs(owner: string, harnessInstanceId: string): Promise<ProviderWorkflowLogs> { authorize(owner); await adapterFor(harnessInstanceId); return { entries: [...entries.values()].filter(e => e.operation.harnessInstanceId === harnessInstanceId).flatMap(e => e.events).slice(-64).map(e => ({ ...e })) }; },
    async close() {
      // Reject new callers while an already queued operation drains.
      closed = true;
      await serialize(async () => {
        const results = await Promise.allSettled([...entries.values()].filter(protectedEntry).map(async e => { if (!e.cancel) throw new ProviderWorkflowError('unavailable'); await e.cancel(); }));
        for (const result of results)
          if (result.status === 'rejected')
            console.warn('[provider-workflow] Shutdown failed');
        entries.clear();
      }, true);
    },
  };
}
export type ProviderWorkflowService = ReturnType<typeof createProviderWorkflowService>;
