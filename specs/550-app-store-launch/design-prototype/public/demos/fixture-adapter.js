/* Design exploration only. No owner database, account, credential or service access. */
(() => {
  'use strict';
  const MAX_ROWS = 200, MAX_ROW_BYTES = 40_000, MAX_SUBSCRIBERS = 8;
  const clone = value => JSON.parse(JSON.stringify(value));
  const canonical = value => Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
      : JSON.stringify(value);
  const validRow = row => row && typeof row === 'object' && typeof row.id === 'string'
    && row.id.length <= 200 && row.payload && typeof row.payload === 'object'
    && row.payload.id === row.id && row.payload.fields && typeof row.payload.fields === 'object'
    && new TextEncoder().encode(JSON.stringify(row)).byteLength <= MAX_ROW_BYTES;
  const initial = JSON.parse(document.getElementById('demo-records').textContent);
  if (!Array.isArray(initial) || initial.length > MAX_ROWS || !initial.every(validRow)) {
    throw new Error('Invalid fictional demo fixture');
  }
  const rows = clone(initial);
  const subscribers = new Set();
  let active = true;
  const table = name => { if (!active || name !== 'records') throw new Error('Preview records only'); };
  const emit = () => queueMicrotask(() => {
    if (!active) return;
    for (const callback of [...subscribers]) {
      try { callback(); } catch (error) { console.error('Preview subscriber failed', error); }
    }
  });
  const db = Object.freeze({
    async find(name, options = {}) {
      table(name);
      const offset = Number.isInteger(options.offset) && options.offset >= 0 ? options.offset : 0;
      const limit = Number.isInteger(options.limit) && options.limit >= 0 ? Math.min(500, options.limit) : 500;
      return clone([...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id)).slice(offset, offset + limit));
    },
    async findOne(name, id) { table(name); return clone(rows.find(row => row.id === id) ?? null); },
    async insert(name, input) {
      table(name);
      const row = clone(input);
      if (!validRow(row) || rows.length >= MAX_ROWS || rows.some(existing => existing.id === row.id)) throw new Error('Preview insert unavailable');
      row.created_at = new Date().toISOString();
      rows.push(row); emit(); return { id: row.id };
    },
    async compareAndSwap(name, id, expectedPayload, input) {
      table(name);
      const index = rows.findIndex(row => row.id === id);
      if (index < 0 || canonical(rows[index].payload) !== canonical(expectedPayload)) return { ok: false };
      const row = { ...rows[index], payload: clone(input.payload) };
      if (!validRow(row)) throw new Error('Invalid preview update');
      rows[index] = row; emit(); return { ok: true };
    },
    async update() { throw new Error('Use atomic preview comparison'); },
    onChange(name, callback) {
      table(name);
      if (typeof callback !== 'function' || subscribers.size >= MAX_SUBSCRIBERS) throw new Error('Preview subscriber limit');
      subscribers.add(callback); return () => subscribers.delete(callback);
    },
  });
  Object.defineProperty(window, 'MatrixOS', { value: Object.freeze({ db }), writable: false, configurable: false });
  const deny = () => { throw new Error('Network/navigation disabled in this fictional preview'); };
  for (const key of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'open']) {
    Object.defineProperty(window, key, { value: deny, writable: false, configurable: false });
  }
  document.addEventListener('click', event => {
    if (event.target?.closest?.('a')) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  window.addEventListener('pagehide', () => { active = false; rows.length = 0; subscribers.clear(); }, { once: true });
})();
