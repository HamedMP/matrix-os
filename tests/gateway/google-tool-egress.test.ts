import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotRuntimeRegistry, type ManagedPiRuntimeBinding } from '../../packages/gateway/src/bots/runtime-registry.js';
import { createGoogleContextStore } from '../../packages/gateway/src/google-data/runtime/contexts.js';
import { createGoogleToolEgressGuard, GoogleToolEgressError } from '../../packages/gateway/src/google-data/runtime/tool-egress.js';
import { createAuthorityFixture } from './google-data/fixture-db.js';

const binding = (): ManagedPiRuntimeBinding => ({ kind: 'managed_chat', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1',
  ownerId: 'owner-one', chatId: 'chat_one', runId: 'run_one', workspace: { kind: 'chat_workspace' }, rootFingerprint: 'c'.repeat(64),
  route: { api: 'anthropic-messages', modelId: 'model-a', input: ['text'], contextWindow: 128000, maxOutputTokens: 8192 },
  accessSourceId: 'matrix_included', capabilities: ['integration.call', 'mcp.call', 'browser.action'], requestClass: 'interactive' });
let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'];
let registry: BotRuntimeRegistry;
beforeEach(async () => { ({ db } = await createAuthorityFixture()); });
afterEach(async () => { vi.useRealTimers(); registry?.shutdown(); await db.destroy(); vi.restoreAllMocks(); });
async function fixture() {
  let clock = new Date(); const now = () => clock;
  registry = new BotRuntimeRegistry({ now: () => clock.getTime(), ttlMs: 1000 }); registry.bind(binding());
  // Synthetic deletion admission proves closed-marker behavior only, never real content deletion.
  const contexts = createGoogleContextStore(db.sql, { now, deletionAuthority: { withVerifiedContextDeletion: async (_owner, _chat, work) => work() } });
  await contexts.migrate(); const inspect = vi.spyOn(contexts, 'inspect');
  const guard = createGoogleToolEgressGuard({ registry, contexts });
  const mark = () => contexts.mark({ ownerId: 'owner-one', chatId: 'chat_one', googleAccountId: '123e4567-e89b-42d3-a456-426614174000',
    consentId: 'consent_one', profileId: 'profile_one', profileRevision: 1, purposeId: 'mail-assistance',
    expiresAt: new Date(clock.getTime() + 60000).toISOString(), retentionDeadline: new Date(clock.getTime() + 30000).toISOString() });
  const run = (signal = new AbortController().signal) => guard.assertAllowed(binding(), signal);
  return { contexts, guard, inspect, mark, run, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}
describe('classified Google context tool egress', () => {
  it('permits a current ordinary run only when the durable marker is exactly null', async () => {
    const f = await fixture(); await expect(f.run()).resolves.toBeUndefined();
    expect(f.inspect).toHaveBeenCalledExactlyOnceWith('owner-one', 'chat_one');
  });
  it.each(['available', 'expired', 'purging', 'deleted'] as const)('denies a durable %s marker without treating it as ordinary content', async state => {
    const f = await fixture(); await f.mark();
    if (state === 'expired') { f.advance(30001); registry.bind(binding()); }
    if (state === 'purging' || state === 'deleted') {
      await f.contexts.beginPurge('owner-one', '123e4567-e89b-42d3-a456-426614174000');
      if (state === 'deleted') { const current = await f.contexts.inspect('owner-one', 'chat_one'); await f.contexts.completeDeletion('owner-one', 'chat_one', current!.revision); }
    }
    expect((await f.contexts.inspect('owner-one', 'chat_one'))?.availability).toBe(state);
    await expect(f.run()).rejects.toBeInstanceOf(GoogleToolEgressError);
  });
  it.each([undefined, {}, { availability: 'available', sources: [] }, false] as const)('denies malformed or missing inspection result %#', async value => {
    const f = await fixture(); f.inspect.mockResolvedValue(value as never);
    await expect(f.run()).rejects.toThrow('Tool unavailable');
  });
  it.each(['ownerId', 'chatId', 'runId', 'executionGeneration', 'runtimeHandle'] as const)('rejects mismatched %s before durable inspection', async field => {
    const f = await fixture(); const changed = { ...binding(), [field]: field === 'runtimeHandle' ? `runtime_${'b'.repeat(32)}` : field === 'executionGeneration' ? '2' : 'other' };
    await expect(f.guard.assertAllowed(changed, new AbortController().signal)).rejects.toBeInstanceOf(GoogleToolEgressError);
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it('rejects an already cancelled call before durable inspection', async () => {
    const f = await fixture(); await expect(f.run(AbortSignal.abort())).rejects.toBeInstanceOf(GoogleToolEgressError);
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it.each(['cancel', 'rebind', 'expiry', 'release'] as const)('refuses a null read after live run %s changes while waiting', async changed => {
    const f = await fixture(); const original = f.inspect.getMockImplementation()!;
    f.inspect.mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      if (changed === 'cancel') registry.cancelInference(binding());
      if (changed === 'rebind') registry.bind(binding());
      if (changed === 'expiry') f.advance(1001);
      if (changed === 'release') registry.release(binding().runtimeHandle);
      return result;
    });
    await expect(f.run()).rejects.toBeInstanceOf(GoogleToolEgressError);
  });
  it('does not cache permission when Google context is classified between tool calls', async () => {
    const f = await fixture(); await f.run(); await f.mark();
    await expect(f.run()).rejects.toBeInstanceOf(GoogleToolEgressError); expect(f.inspect).toHaveBeenCalledTimes(2);
  });
  it('denies durable lookup failures without private diagnostics or a cause', async () => {
    const f = await fixture(); f.inspect.mockRejectedValue(new Error('synthetic-private-database-hostname'));
    const error = await f.run().catch(value => value);
    expect(error).toBeInstanceOf(GoogleToolEgressError); expect(error.message).toBe('Tool unavailable'); expect(error.cause).toBeUndefined();
  });
  it('cancels a stalled inspection promptly and never grants after its late null result', async () => {
    const f = await fixture(); let finish!: (value: null) => void;
    f.inspect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController(); const pending = f.run(controller.signal); const denied = expect(pending).rejects.toBeInstanceOf(GoogleToolEgressError);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function')); controller.abort(); await denied; finish(null); await Promise.resolve();
  });
  it('bounds an inspection whose dependency ignores cancellation', async () => {
    const f = await fixture(); vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal; });
    f.inspect.mockImplementationOnce(() => new Promise(() => {}));
    const pending = f.run(); const denied = expect(pending).rejects.toBeInstanceOf(GoogleToolEgressError);
    await vi.advanceTimersByTimeAsync(10001); await denied;
  });
  it('fails closed for missing trusted dependencies', () => {
    expect(() => createGoogleToolEgressGuard({ registry: {}, contexts: {} } as never)).toThrow('Tool unavailable');
  });
});
