import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthorityFixture } from './google-data/fixture-db.js';
import { BotRuntimeRegistry, type ManagedPiRuntimeBinding } from '../../packages/gateway/src/bots/runtime-registry.js';
import { createGoogleBrokerRuntime } from '../../packages/gateway/src/startup/google-data.js';
import { qualifiedRouteFixture, qualifiedIdentity, qualifiedModel as model } from '../helpers/google-qualified-funded-fixture.js';
let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'] | undefined;
let runtime: Awaited<ReturnType<typeof createGoogleBrokerRuntime>> | undefined; const registries: BotRuntimeRegistry[] = [];
afterEach(async () => { await runtime?.close(); runtime = undefined; for (const registry of registries.splice(0)) registry.shutdown(); await db?.destroy(); db = undefined; });
const binding: ManagedPiRuntimeBinding = { kind: 'managed_chat', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', ownerId: qualifiedIdentity.ownerId,
  chatId: 'chat_one', runId: 'run_one', workspace: { kind: 'chat_workspace' }, rootFingerprint: 'c'.repeat(64), route: { api: 'openai-completions', modelId: model, input: ['text'], contextWindow: 128000, maxOutputTokens: 8192 },
  accessSourceId: 'matrix_included', capabilities: ['artifact.read'], requestClass: 'interactive' };
async function setup(pilotAdmission: { enabled: false } | { enabled: true; ownerId: string }) {
  ({ db } = await createAuthorityFixture()); const registry = new BotRuntimeRegistry(); registry.bind(binding); registries.push(registry);
  runtime = await createGoogleBrokerRuntime({ database: db.sql, registry, pilotAdmission, admitContext: async () => undefined }); return { registry, runtime };
}
describe('explicit pilot host broker controls', () => {
  it('keeps ordinary inference working with pilot off but denies collection and classified Google work', async () => {
    const { runtime } = await setup({ enabled: false }); const request = { phase: 'dispatch' as const, binding, identity: null, signal: new AbortController().signal };
    expect(await runtime.inference.authorize(request)).toEqual({ allowed: true, googleOrigin: false });
    const ownerUI = vi.fn(async () => true); await expect(runtime.prepareCollection(binding, '123e4567-e89b-42d3-a456-426614174000', request.signal, ownerUI)).rejects.toThrow('Google data processing unavailable'); expect(ownerUI).not.toHaveBeenCalled();
    const expiresAt = new Date(Date.now() + 60000).toISOString(); await runtime.contexts.mark({ ownerId: binding.ownerId, chatId: binding.chatId,
      googleAccountId: '123e4567-e89b-42d3-a456-426614174000', purposeId: 'mail-assistance', consentId: 'source_one', profileId: 'source_one', profileRevision: 1, expiresAt, retentionDeadline: expiresAt });
    expect(await runtime.inference.authorize(request)).toEqual({ allowed: false });
  });
  it('rejects a live run for another host owner even before Google collection', async () => {
    const { runtime } = await setup({ enabled: true, ownerId: 'other' });
    expect(await runtime.inference.authorize({ phase: 'dispatch', binding, identity: null, signal: new AbortController().signal })).toEqual({ allowed: false });
    await expect(runtime.prepareCollection(binding, '123e4567-e89b-42d3-a456-426614174000', new AbortController().signal, async () => true)).rejects.toThrow('Google data processing unavailable');
  });
  it('fails closed on enabled pilot without the owning context adapter', async () => {
    ({ db } = await createAuthorityFixture()); const registry = new BotRuntimeRegistry(); registry.bind(binding); registries.push(registry);
    runtime = await createGoogleBrokerRuntime({ database: db.sql, registry, pilotAdmission: { enabled: true, ownerId: binding.ownerId } });
    const request = { phase: 'dispatch' as const, binding, identity: null, signal: new AbortController().signal };
    expect(await runtime.inference.authorize(request)).toEqual({ allowed: false });
    await expect(runtime.inference.managed!.required(binding, request.signal)).rejects.toThrow('Google data processing unavailable');
    await expect(runtime.prepareCollection(binding, '123e4567-e89b-42d3-a456-426614174000', request.signal, async () => true)).rejects.toThrow('Google data processing unavailable');
  });
  it('adopts before classification, dispatch, release and collection; rechecks live binding after adoption waits', async () => {
    ({ db } = await createAuthorityFixture()); const registry = new BotRuntimeRegistry(); registry.bind(binding); registries.push(registry);
    const admitContext = vi.fn(async () => undefined);
    runtime = await createGoogleBrokerRuntime({ database: db.sql, registry, pilotAdmission: { enabled: true, ownerId: binding.ownerId }, admitContext });
    const request = { phase: 'dispatch' as const, binding, identity: null, signal: new AbortController().signal };
    expect(await runtime.inference.managed!.required(binding, request.signal)).toBe(false);
    expect(await runtime.inference.authorize(request)).toEqual({ allowed: true, googleOrigin: false });
    expect(await runtime.inference.authorize({ ...request, phase: 'release' })).toEqual({ allowed: true, googleOrigin: false });
    expect(admitContext).toHaveBeenCalledTimes(3);
    admitContext.mockImplementation(async () => { registry.cancelInference(binding); });
    const ui = vi.fn(async () => true);
    await expect(runtime.prepareCollection(binding, '123e4567-e89b-42d3-a456-426614174000', request.signal, ui)).rejects.toThrow('Google data processing unavailable');
    expect(ui).not.toHaveBeenCalled(); expect(admitContext).toHaveBeenCalledTimes(4);
  });
  it('uses fresh authenticated managed control identity for collection instead of observing a temporary legacy token', async () => {
    ({ db } = await createAuthorityFixture()); const registry = new BotRuntimeRegistry(); registry.bind(binding); registries.push(registry);
    const resolveRoute = vi.fn(async () => qualifiedRouteFixture()); const credentials = { identity: qualifiedIdentity, resolveRoute,
      getCredential: vi.fn(), invalidate: vi.fn(), close: vi.fn(async () => undefined) };
    runtime = await createGoogleBrokerRuntime({ database: db.sql, registry, pilotAdmission: { enabled: true, ownerId: binding.ownerId }, qualifiedCredentials: credentials, admitContext: async () => undefined });
    expect(runtime.observedIdentity(binding)).toBeNull(); const ownerUI = vi.fn(async () => true);
    await expect(runtime.prepareCollection(binding, '123e4567-e89b-42d3-a456-426614174000', new AbortController().signal, ownerUI)).rejects.toThrow('Google data processing unavailable');
    expect(resolveRoute).toHaveBeenCalledOnce(); expect(credentials.getCredential).not.toHaveBeenCalled(); expect(ownerUI).not.toHaveBeenCalled();
    expect(await runtime.contexts.inspect(binding.ownerId, binding.chatId)).toBeNull();
  });
});
