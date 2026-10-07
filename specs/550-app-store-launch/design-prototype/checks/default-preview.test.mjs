import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';
const source = readFileSync(new URL('../public/demos/default-adapter.js', import.meta.url), 'utf8');
function fixture(logger = console) {
  const events = {}, timers = [];
  const ctx = createContext({ console: logger, TextEncoder, URL, queueMicrotask, crypto: { randomUUID: () => 'new-id' },
    window: { addEventListener: (name, fn) => events[name] = fn },
    document: { getElementById: () => ({ textContent: JSON.stringify({ tables: { notes: [{ id: 'note-1', title: 'Example' }] }, kv: {}, weather: { current: { temperature_2m: 18 } } }) }), addEventListener() {} },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
  });
  new Script(source).runInContext(ctx);
  return { bridge: ctx.window.MatrixOS, events, window: ctx.window, context: ctx };
}
test('fictional defaults clone reads, scope tables and reset per frame', async () => {
  const a = fixture();
  const rows = await a.bridge.db.find('notes'); rows[0].title = 'changed';
  assert.equal((await a.bridge.db.find('notes'))[0].title, 'Example');
  await a.bridge.db.update('notes', 'note-1', { title: 'Saved temporarily' });
  assert.equal((await a.bridge.db.find('notes'))[0].title, 'Saved temporarily');
  assert.equal((await fixture().bridge.db.find('notes'))[0].title, 'Example');
  await assert.rejects(a.bridge.db.find('owner-secret'));
  await assert.rejects(a.bridge.db.insert('notes', { title: 'x'.repeat(100000) }));
  assert.equal(a.bridge.gatewayFetch, undefined); assert.equal(a.bridge.generate, undefined);
});
test('subscriptions and KV values are bounded and disposed', async () => {
  const a = fixture();
  const off = Array.from({ length: 16 }, () => a.bridge.db.onChange('notes', () => {}));
  assert.throws(() => a.bridge.db.onChange('notes', () => {})); off.forEach(fn => fn());
  await a.bridge.writeData('draft', { text: 'Temporary' });
  assert.equal((await a.bridge.readData('draft')).text, 'Temporary');
  await assert.rejects(a.bridge.writeData('__proto__', 'bad'));
  a.events.pagehide();
  await assert.rejects(a.bridge.db.find('notes')); await assert.rejects(a.bridge.readData('draft'));
});
test('batch updates commit atomically and reject invalid later records without changing earlier ones', async () => {
  const a = fixture();
  await a.bridge.db.insert('notes', { id: 'note-2', title: 'Second' });
  await a.bridge.db.bulkUpdate('notes', [{ id: 'note-1', data: { order: 1 } }, { id: 'note-2', data: { order: 0 } }]);
  assert.equal((await a.bridge.db.findOne('notes', 'note-1')).order, 1);
  await assert.rejects(a.bridge.db.bulkUpdate('notes', [{ id: 'note-1', data: { title: 'Should not save' } }, { id: 'missing', data: { order: 2 } }]));
  assert.equal((await a.bridge.db.findOne('notes', 'note-1')).title, 'Example');
  await assert.rejects(a.bridge.db.bulkUpdate('notes', Array.from({ length: 201 }, () => ({ id: 'note-1', data: { order: 0 } }))));
});
test('weather is a fixed fixture; arbitrary transports stay unavailable', async () => {
  const a = fixture();
  assert.equal((await a.bridge.proxyFetch('https://api.open-meteo.com/v1/forecast?latitude=0')).current.temperature_2m, 18);
  await assert.rejects(a.bridge.proxyFetch('https://example.com/api/private'));
  assert.throws(() => a.window.fetch('/api/system/info'));
  assert.throws(() => a.window.open('https://example.com'));
});

test('failed subscribers stay isolated and logs classify Error and non-Error values', async () => {
  const logs = [];
  const a = fixture({ error: (...args) => logs.push(args) });
  let delivered = 0;
  a.bridge.db.onChange('notes', new Script('() => { throw new TypeError("private detail"); }').runInContext(a.context));
  a.bridge.db.onChange('notes', () => { throw 'private thrown value'; });
  a.bridge.db.onChange('notes', () => delivered++);
  await a.bridge.db.update('notes', 'note-1', { title: 'Changed' });
  assert.equal(delivered, 1);
  assert.deepEqual(logs, [['Preview subscription failed', 'TypeError'], ['Preview subscription failed', 'string']]);
});
