import { describe, expect, it, vi } from 'vitest';
import { assertChatContinuation } from '../../packages/gateway/src/chat/continuation-admission.js';
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from '../../packages/gateway/src/chat/provider-adapter.js';

function fixture() {
  const owner = { type: 'personal' as const, ownerId: 'owner_one' };
  const adapter: CanonicalChatProviderAdapter = { driverKind: 'codex', stateSchemaVersion: 1, detachOnShutdown: true,
    parseState: value => value, serializeState: value => value,
    start: async function* () { yield { type: 'run.completed', outcome: 'completed' }; } };
  const active = { owner: { ...owner }, chatId: 'chat_one', adapter, controller: new AbortController() };
  let current: typeof active | undefined = active;
  const assertRun = vi.fn(async () => undefined);
  const options = { owner, chatId: 'chat_one', active, current: () => current,
    adapters: new CanonicalChatProviderRegistry([adapter]), reader: { assertRun, read: vi.fn() } };
  return { owner, active, options, assertRun, current: (value: typeof current) => { current = value; } };
}
describe('continuation authority after awaited history admission', () => {
  it.each(['replacement', 'owner', 'chat', 'controller', 'registration'] as const)('denies %s substitution after its history await', async kind => {
    const f = fixture();
    f.assertRun.mockImplementation(async () => {
      if (kind === 'replacement') f.current({ ...f.active });
      if (kind === 'owner') f.active.owner.ownerId = 'other';
      if (kind === 'chat') f.active.chatId = 'other';
      if (kind === 'controller') f.active.controller = new AbortController();
      if (kind === 'registration') vi.spyOn(f.options.adapters, 'get').mockReturnValue({ ...f.active.adapter });
    });
    await expect(assertChatContinuation(f.options)).rejects.toThrow('Chat context unavailable');
  });
  it('admits a recovered registered detached control only while the live slot remains empty', async () => {
    const f = fixture(); f.current(undefined);
    await expect(assertChatContinuation({ ...f.options, recovered: true })).resolves.toBeUndefined();
    f.assertRun.mockImplementation(async () => { f.current({ ...f.active }); });
    await expect(assertChatContinuation({ ...f.options, recovered: true })).rejects.toThrow('Chat context unavailable');
  });
  it('does not treat an ordinary detached control as recovered when it disappears', async () => {
    const f = fixture(); f.assertRun.mockImplementation(async () => { f.current(undefined); });
    await expect(assertChatContinuation(f.options)).rejects.toThrow('Chat context unavailable');
  });
});
