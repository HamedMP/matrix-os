import { AoedeRequestError } from '../../packages/ui/src/aoede/client';
import { expect, it, vi } from 'vitest';
import { createAoedeTextSender } from '../../packages/ui/src/aoede/text-turn';
import { createCanonicalChatFixture, createCanonicalProviderCatalogFixture } from '../contracts/fixtures/canonical-chat';
const fixture = createCanonicalChatFixture('idle').snapshot;
function harness() {
  let generation = 1;
  const context = () => ({ generation, chatId: fixture.chat.id, revision: fixture.chat.revision, selection: { instanceId: 'codex_fixture', model: 'gpt-5.6-sol' } });
  const createTurn = vi.fn(async () => undefined);
  const fail = vi.fn(); const refresh = vi.fn(async () => undefined);
  const sender = createAoedeTextSender({ context, catalog: async () => createCanonicalProviderCatalogFixture(), createTurn, fail, refresh });
  return { sender, createTurn, fail, refresh, switchOwner: () => { generation++; } };
}
it('preserves native media and declines typed task admission when no task route is selected', async () => {
  const prepare = vi.fn(); const createTurn = vi.fn();
  const send = createAoedeTextSender({ context: () => ({ generation: 1, chatId: fixture.chat.id,
    revision: 0, selection: undefined }), prepare, createTurn,
    catalog: async () => createCanonicalProviderCatalogFixture(), fail: vi.fn(), refresh: vi.fn() });
  expect(await send('Build an app')).toBe(false);
  expect(prepare).not.toHaveBeenCalled(); expect(createTurn).not.toHaveBeenCalled();
});
it('submits supervised canonical turns and does not replay an accepted request id', async () => {
  const h = harness(); expect(await h.sender('Find a recipe')).toBe(true);
  const first = h.createTurn.mock.calls[0]!;
  expect(first).toEqual([fixture.chat.id, expect.objectContaining({ baseRevision: fixture.chat.revision, parts: [{ type: 'text', text: 'Find a recipe' }], selection: { instanceId: 'codex_fixture', model: 'gpt-5.6-sol' }, interactionMode: 'default', permissionMode: 'supervised' })]);
  await h.sender('Find a recipe'); expect(h.createTurn.mock.calls[1]![1].clientRequestId).not.toBe(first[1].clientRequestId);
});
it('retains one idempotent request on unknown outcomes and preserves the draft', async () => {
  const h = harness(); h.createTurn.mockRejectedValueOnce(new Error('timeout'));
  expect(await h.sender('Find a recipe')).toBe(false); expect(h.fail).toHaveBeenCalledOnce();
  expect(await h.sender('Find a recipe')).toBe(true);
  expect(h.createTurn.mock.calls[1]).toEqual(h.createTurn.mock.calls[0]);
});
it('rejects empty/oversized messages and concurrent double sends', async () => {
  const h = harness(); expect(await h.sender(' ')).toBe(false); expect(await h.sender('x'.repeat(8001))).toBe(false);
  let release!: () => void; h.createTurn.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const first = h.sender('Hello'); await vi.waitFor(() => expect(h.createTurn).toHaveBeenCalledOnce());
  expect(await h.sender('Hello')).toBe(false); release(); expect(await first).toBe(true);
});
it('fences identity changes during catalog discovery', async () => {
  const createTurn = vi.fn(); let generation = 1; let resolve!: (c: ReturnType<typeof createCanonicalProviderCatalogFixture>) => void;
  const send = createAoedeTextSender({ context: () => ({ generation, chatId: fixture.chat.id, revision: 0, selection: { instanceId: 'codex_fixture', model: 'gpt-5.6-sol' } }), catalog: () => new Promise(r => { resolve = r; }), createTurn, fail: vi.fn(), refresh: async () => {} });
  const pending = send('Hello'); generation++; resolve(createCanonicalProviderCatalogFixture());
  expect(await pending).toBe(false); expect(createTurn).not.toHaveBeenCalled();
});

it('acknowledges accepted messages even if the subsequent read fails', async () => {
  const h = harness(); h.refresh.mockRejectedValueOnce(new Error('offline'));
  expect(await h.sender('Hello')).toBe(true); expect(h.fail).toHaveBeenCalledOnce();
  await h.sender('Hello'); expect(h.createTurn.mock.calls[1]![1].clientRequestId).not.toBe(h.createTurn.mock.calls[0]![1].clientRequestId);
});

it('acknowledges admission when refresh moves the Chat into a running state', async () => {
  let running = false;
  const sender = createAoedeTextSender({ context: () => ({ generation: 1, chatId: fixture.chat.id, revision: 0, selection: { instanceId: 'codex_fixture', model: 'gpt-5.6-sol' }, running }), catalog: async () => createCanonicalProviderCatalogFixture(), createTurn: async () => {}, refresh: async () => { running = true; }, fail: vi.fn() });
  expect(await sender('Hello')).toBe(true); expect(await sender('Another message')).toBe(false);
});

it('refreshes a rejected conflict and creates a fresh attempt for the next send', async () => {
  const h = harness(); h.createTurn.mockRejectedValueOnce(new AoedeRequestError(409));
  expect(await h.sender('Hello')).toBe(false); expect(h.refresh).toHaveBeenCalledOnce();
  expect(await h.sender('Hello')).toBe(true);
  expect(h.createTurn.mock.calls[1]![1].clientRequestId).not.toBe(h.createTurn.mock.calls[0]![1].clientRequestId);
});

it('retries the original unknown request even if its accepted run has become active', async () => {
  let running = false;
  const pending = vi.fn();
  const createTurn = vi.fn().mockRejectedValueOnce(new DOMException('Timeout', 'TimeoutError')).mockResolvedValue(undefined);
  const sender = createAoedeTextSender({ context: () => ({ generation: 1, chatId: fixture.chat.id, revision: 0,
    selection: { instanceId: 'codex_fixture', model: 'gpt-5.6-sol' }, running }),
    catalog: async () => createCanonicalProviderCatalogFixture(), createTurn, onPendingChange: pending,
    refresh: async () => {}, fail: vi.fn() });
  expect(await sender('Original request')).toBe(false);
  expect(pending).toHaveBeenLastCalledWith({ text: 'Original request', status: 'unknown' });
  running = true;
  expect(await sender('Different request')).toBe(false);
  expect(await sender('Original request')).toBe(true);
  expect(createTurn.mock.calls[1]).toEqual(createTurn.mock.calls[0]);
  expect(pending).toHaveBeenLastCalledWith(null);
});
