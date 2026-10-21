import { expect, it } from 'vitest';
import { createBrowserChatNavigationPersistence } from '../../packages/ui/src/chat-navigation/browser-cache.js';
const empty = { version: 1 as const, items: [], truncated: false };
function storage() { const values = new Map<string, string>(); return { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; }
it('isolates runtime/owner scopes and expires or rejects malformed data', async () => {
  const disk = storage();
  let now = 100;
  const one = createBrowserChatNavigationPersistence(disk, 'ownerA/runtime1', () => now);
  await one.save(empty);
  expect(await one.load()).toEqual(empty);
  expect(await createBrowserChatNavigationPersistence(disk, 'ownerB/runtime1', () => now).load()).toBeNull();
  now += 24 * 60 * 60 * 1000 + 1;
  expect(await one.load()).toBeNull();
  expect(disk.length).toBe(0);
  disk.setItem('matrix-chat-navigation:v1:ownerA/runtime1', '{bad');
  expect(await one.load()).toBeNull();
});
it('keeps only three successful complete snapshots and clears owner caches', async () => {
  const disk = storage();
  for (let i = 0; i < 4; i++)
    await createBrowserChatNavigationPersistence(disk, `owner/${i}`, () => 100 + i).save(empty);
  expect(disk.length).toBe(3);
  const cache = createBrowserChatNavigationPersistence(disk, 'owner/1');
  await cache.save({ ...empty, truncated: true });
  expect(disk.length).toBe(3);
  await cache.clear();
  expect(disk.length).toBe(2);
});
it('degrades to memory when storage is denied', async () => {
  const cache = createBrowserChatNavigationPersistence({ length: 0, key: () => null, getItem: () => { throw new DOMException('denied'); }, setItem: () => { throw new DOMException('quota'); }, removeItem: () => { } }, 'owner');
  await expect(cache.load()).resolves.toBeNull();
  await expect(cache.save(empty)).resolves.toBeUndefined();
});
it('evicts the least recently read scope without extending its expiry', async () => {
  const disk = storage();
  let now = 100;
  const cache = (scope: string) => createBrowserChatNavigationPersistence(disk, scope, () => now);
  await cache('a').save(empty);
  now++;
  await cache('b').save(empty);
  now++;
  await cache('c').save(empty);
  now++;
  await cache('a').load();
  now++;
  await cache('d').save(empty);
  expect(disk.getItem('matrix-chat-navigation:v1:b')).toBeNull();
  expect(await cache('a').load()).toEqual(empty);
  now = 100 + 24 * 60 * 60 * 1000 + 1;
  expect(await cache('a').load()).toBeNull();
});
it('serves a valid cached snapshot when its LRU touch cannot be written', async () => {
  const disk = storage();
  await createBrowserChatNavigationPersistence(disk, 'owner').save(empty);
  disk.setItem = () => { throw new DOMException('quota'); };
  expect(await createBrowserChatNavigationPersistence(disk, 'owner').load()).toEqual(empty);
});
it('serves a valid cached snapshot when pruning another invalid snapshot fails', async () => {
  const disk = storage();
  await createBrowserChatNavigationPersistence(disk, 'owner').save(empty);
  disk.setItem('matrix-chat-navigation:v1:broken', '{bad');
  disk.removeItem = () => { throw new DOMException('denied'); };
  expect(await createBrowserChatNavigationPersistence(disk, 'owner').load()).toEqual(empty);
});
