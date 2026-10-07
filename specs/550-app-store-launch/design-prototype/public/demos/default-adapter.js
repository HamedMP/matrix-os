/* Fictional default-app review only. No owner transport, persistent storage or real forecast. */
(() => {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const safe = key => typeof key === 'string' && key.length > 0 && key.length < 150 && !['__proto__', 'constructor', 'prototype'].includes(key);
  const bounded = value => new TextEncoder().encode(JSON.stringify(value)).length <= 80_000;
  const fixture = JSON.parse(document.getElementById('default-fixture').textContent);
  if (!fixture.tables || Object.keys(fixture.tables).length > 12 || !Object.entries(fixture.tables).every(([key, rows]) => safe(key) && Array.isArray(rows) && rows.length <= 200 && rows.every(bounded))) throw Error('Invalid preview fixture');
  const tables = clone(fixture.tables), kv = Object.assign(Object.create(null), clone(fixture.kv || {}));
  if (Object.keys(kv).length > 32 || !Object.keys(kv).every(safe) || !bounded(kv)) throw Error('Invalid preview view state');
  const subscriptions = new Set();
  let active = true;
  function table(key) {
    if (!active || !safe(key) || !own(tables, key)) throw Error('Preview table unavailable');
    return tables[key];
  }
  function emit(key) {
    queueMicrotask(() => {
      if (!active) return;
      for (const subscriber of [...subscriptions]) if (subscriber.key === key) {
        try { subscriber.fn(); } catch (cause) { console.error('Preview subscription failed', cause instanceof Error ? cause.name : typeof cause); }
      }
    });
  }
  const db = Object.freeze({
    async find(key, options = {}) {
      let rows = table(key).filter(row => !options.where || Object.entries(options.where).every(([name, value]) => row[name] === value));
      const ordering = Object.entries(options.orderBy || {}).slice(0, 3);
      if (ordering.length) rows = [...rows].sort((a, b) => {
        for (const [name, order] of ordering) {
          const value = typeof a[name] === 'number' && typeof b[name] === 'number' ? a[name] - b[name] : String(a[name] ?? '').localeCompare(String(b[name] ?? ''));
          if (value) return order === 'desc' ? -value : value;
        }
        return 0;
      });
      const offset = Number.isSafeInteger(options.offset) && options.offset >= 0 ? options.offset : 0;
      const limit = Number.isSafeInteger(options.limit) && options.limit >= 0 ? Math.min(200, options.limit) : 200;
      return clone(rows.slice(offset, offset + limit));
    },
    async findOne(key, id) { return clone(table(key).find(row => row.id === id) ?? null); },
    async insert(key, value) {
      const rows = table(key);
      if (!value || typeof value !== 'object' || !bounded(value) || rows.length >= 200) throw Error('Preview insert unavailable');
      const row = { ...clone(value), id: value.id || crypto.randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      if (rows.some(existing => existing.id === row.id)) throw Error('Duplicate preview record');
      rows.push(row); emit(key); return { id: row.id };
    },
    async update(key, id, patch) {
      const rows = table(key), index = rows.findIndex(row => row.id === id);
      if (index < 0 || !patch || typeof patch !== 'object') throw Error('Preview update unavailable');
      const next = { ...rows[index], ...clone(patch), id, updated_at: new Date().toISOString() };
      if (!bounded(next)) throw Error('Preview record too large');
      rows[index] = next; emit(key); return { id };
    },
    async bulkUpdate(key, updates) {
      const rows = table(key);
      if (!Array.isArray(updates) || updates.length < 1 || updates.length > 200) throw Error('Preview batch unavailable');
      const ids = new Set();
      const prepared = updates.map(change => {
        if (!change || typeof change.id !== 'string' || ids.has(change.id) || !change.data || typeof change.data !== 'object' || Array.isArray(change.data)) throw Error('Invalid preview batch');
        ids.add(change.id);
        const index = rows.findIndex(row => row.id === change.id);
        if (index < 0) throw Error('Preview record unavailable');
        const next = { ...rows[index], ...clone(change.data), id: change.id, updated_at: new Date().toISOString() };
        if (!bounded(next)) throw Error('Preview record too large');
        return { index, next };
      });
      for (const { index, next } of prepared) rows[index] = next;
      emit(key); return { ok: true };
    },
    async delete(key, id) { const rows = table(key), index = rows.findIndex(row => row.id === id); if (index >= 0) rows.splice(index, 1); emit(key); return { id }; },
    onChange(key, fn) {
      table(key);
      if (typeof fn !== 'function' || subscriptions.size >= 16) throw Error('Preview subscription limit');
      const entry = { key, fn }; subscriptions.add(entry); return () => subscriptions.delete(entry);
    },
  });
  const bridge = {
    db,
    async readData(key) { if (!active || !safe(key)) throw Error('Preview state unavailable'); return clone(own(kv, key) ? kv[key] : null); },
    async writeData(key, value) {
      if (!active || !safe(key) || !bounded(value)) throw Error('Preview state unavailable');
      if (!own(kv, key) && Object.keys(kv).length >= 32) throw Error('Preview state limit');
      const next = { ...kv, [key]: clone(value) };
      if (!bounded(next)) throw Error('Preview state size limit');
      kv[key] = next[key];
    },
    async proxyFetch(raw) {
      if (!active) throw Error('Preview unavailable');
      const url = new URL(raw);
      if (url.origin === 'https://api.open-meteo.com' && url.pathname === '/v1/forecast' && fixture.weather) return clone(fixture.weather);
      if (url.origin === 'https://geocoding-api.open-meteo.com' && url.pathname === '/v1/search' && fixture.weather) return { results: [] };
      throw Error('No real service in this preview');
    },
  };
  Object.defineProperty(window, 'MatrixOS', { value: Object.freeze(bridge), writable: false, configurable: false });
  const deny = () => { throw Error('Network/navigation disabled in design preview'); };
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'open']) Object.defineProperty(window, name, { value: deny, writable: false, configurable: false });
  const dispose = () => { active = false; subscriptions.clear(); for (const key of Object.keys(kv)) delete kv[key]; for (const rows of Object.values(tables)) rows.length = 0; clearTimeout(expiry); };
  const expiry = setTimeout(dispose, 30 * 60_000);
  window.addEventListener('pagehide', dispose, { once: true });
  document.addEventListener('click', event => { if (event.target.closest?.('a')) event.preventDefault(); }, true);
})();
