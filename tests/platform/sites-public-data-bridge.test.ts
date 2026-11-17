import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { MessageChannel as NodeMessageChannel } from 'node:worker_threads';
import { APP_BRIDGE_STORED_VALUE_PREFIX, type SiteRecord } from '@matrix-os/contracts';
import { APP_CSP, siteFrame, sitePage } from '../../packages/platform/src/sites/renderer.js';

const site: SiteRecord = { id: 'a2fd72d0-0926-49d5-b45f-bbfb167e50d2', appSlug: 'tasks-lab', title: 'Tasks', description: '', slug: 'tasks', url: 'https://matrix.page/a2fd72d0-0926-49d5-b45f-bbfb167e50d2', revision: 1, status: 'published', accessMode: 'public', activeVersion: 'cd0a12e9-18a0-4b4e-9a10-269eb5697d4f', versions: [], config: { data: {}, forms: [] } };
type Reply = { ok: true; result: unknown } | { error: string };

function frameWithParent(record: SiteRecord, answer: (request: any) => Reply) {
  const requests: any[] = [];
  const dom = new JSDOM(siteFrame('<html><head></head><body></body></html>', record), { url: `${record.url}/frame`, runScripts: 'dangerously', beforeParse(window) {
    Object.defineProperty(window, 'TextDecoder', { value: TextDecoder });
    Object.defineProperty(window, 'MessageChannel', { value: NodeMessageChannel });
    Object.defineProperty(window, 'parent', { configurable: true, value: { postMessage(message: any, origin: string, ports: MessagePort[]) {
      expect(origin).toBe('https://matrix.page');
      expect(message.type).toBe('matrix-site-data');
      requests.push(message.request);
      ports[0]!.postMessage(answer(message.request));
      ports[0]!.close();
    } } });
  } });
  return { dom, requests, os: (dom.window as any).MatrixOS };
}

describe('public site frame data bridge', () => {
  it('exposes the owner bridge shape and relays db calls without naming the app', async () => {
    const rows = [{ id: 'row-1', title: 'Plan', done: false }];
    const { dom, requests, os } = frameWithParent(site, (request) => ({ ok: true, result: request.action?.action === 'count' ? { count: 1 } : request.action?.action === 'insert' ? { id: 'row-2' } : rows }));
    try {
      expect(Object.isFrozen(os)).toBe(true);
      expect(os.app).toEqual({ name: 'tasks-lab' });
      expect(await os.db.find('tasks', { where: { done: false }, limit: 20 })).toEqual(rows);
      expect(await os.db.count('tasks')).toBe(1);
      const changes: unknown[] = [];
      os.db.onChange('tasks', (change: unknown) => changes.push(change));
      os.db.onChange('other', (change: unknown) => changes.push(change));
      expect(await os.db.insert('tasks', { title: 'Ship' })).toEqual({ id: 'row-2' });
      expect(changes).toEqual([{ table: 'tasks' }]);
      expect(requests).toEqual([
        { kind: 'db', action: { action: 'find', table: 'tasks', filter: { done: false }, limit: 20 } },
        { kind: 'db', action: { action: 'count', table: 'tasks' } },
        { kind: 'db', action: { action: 'insert', table: 'tasks', data: { title: 'Ship' } } },
      ]);
      expect(JSON.stringify(requests)).not.toContain('"app"');
    } finally { dom.window.close(); }
  });

  it('stores readData/writeData values in the owner envelope so owner and visitor share rows', async () => {
    const stored = new Map<string, string>();
    const { dom, requests, os } = frameWithParent(site, (request) => {
      if (request.kind === 'kvWrite') { stored.set(request.key, request.value); return { ok: true, result: { ok: true } }; }
      return { ok: true, result: { value: stored.get(request.key) ?? null } };
    });
    try {
      await os.writeData('board/state', { columns: 3 });
      expect(requests[0]).toEqual({ kind: 'kvWrite', key: 'boardstate', value: `${APP_BRIDGE_STORED_VALUE_PREFIX}{"value":{"columns":3}}` });
      expect(await os.readData('board/state')).toEqual({ columns: 3 });
      await expect(os.readData('///')).rejects.toThrow('Invalid change');
    } finally { dom.window.close(); }
  });

  it('keeps unshared-owner collaboration semantics and coarse errors', async () => {
    const { dom, requests, os } = frameWithParent(site, (request) => request.action.action === 'delete'
      ? { error: 'duplicate key value violates unique constraint' }
      : { ok: true, result: request.action.action === 'count' ? { count: 4 } : [] });
    try {
      expect(os.collaboration.participant).toBeNull();
      expect(await os.collaboration.query({ action: 'find', table: 'tasks', app: 'other-app', limit: 100 })).toEqual({ result: [], revision: '0' });
      expect(await os.collaboration.query({ action: 'count', table: 'tasks' })).toEqual({ result: 4, revision: '0' });
      expect(requests[0]).toEqual({ kind: 'db', action: { action: 'find', table: 'tasks', limit: 100 } });
      await expect(os.collaboration.mutate({ action: 'insert', table: 'tasks', data: {} }, 'stale')).rejects.toThrow('Collaboration unavailable');
      await expect(os.collaboration.query({ action: 'delete', table: 'tasks', id: 'row' })).rejects.toThrow('Collaboration unavailable');
      await expect(os.collaboration.mutate({ action: 'delete', table: 'tasks', id: 'row' }, '0')).rejects.toThrow('Collaboration unavailable');
      await expect(os.db.delete('tasks', 'row')).rejects.toThrow('Shared data is unavailable');
    } finally { dom.window.close(); }
  });

  it('gives private-link frames no data bridge and keeps the frame CSP closed', () => {
    const { dom, os } = frameWithParent({ ...site, accessMode: 'private_link' }, () => ({ error: 'unused' }));
    try {
      expect(os.db).toBeUndefined();
      expect(os.readData).toBeUndefined();
      expect(typeof os.site.submit).toBe('function');
    } finally { dom.window.close(); }
    expect(APP_CSP).toContain("connect-src 'none'");
  });
});

describe('public site page data relay', () => {
  function page(record: SiteRecord, fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
    const fetch = vi.fn(fetchImpl);
    const dom = new JSDOM(sitePage(record), { url: record.url, runScripts: 'dangerously', beforeParse(window) {
      window.console.warn = vi.fn();
      Object.defineProperty(window, 'AbortSignal', { value: AbortSignal });
      Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
      Object.defineProperty(window, 'fetch', { value: fetch });
    } });
    const send = (data: unknown, source: unknown = dom.window.document.querySelector('iframe')!.contentWindow, origin = 'null') => {
      const port = { postMessage: vi.fn(), close: vi.fn() };
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: source as any, origin, data, ports: [port as unknown as MessagePort] }));
      return port;
    };
    return { dom, fetch, send };
  }
  const request = { kind: 'db', action: { action: 'find', table: 'tasks' } };

  it('posts frame requests to its own site data path and returns the result', async () => {
    const { dom, fetch, send } = page(site, async () => Response.json({ result: [{ id: 'row-1' }] }));
    try {
      const port = send({ type: 'matrix-site-data', request });
      await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith({ ok: true, result: [{ id: 'row-1' }] }));
      const [url, init] = fetch.mock.calls[0]!;
      expect(url).toBe(`/${site.id}/data`);
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' });
      expect(JSON.parse(String(init.body))).toEqual(request);
      expect(port.close).toHaveBeenCalledOnce();
    } finally { dom.window.close(); }
  });

  it('maps failures to coarse errors and drops untrusted senders', async () => {
    const statuses = [429, 400, 503];
    const { dom, fetch, send } = page(site, async () => Response.json({ error: 'Postgres says no' }, { status: statuses.shift()! }));
    try {
      for (const expected of ['Try again later', 'Invalid change', 'Shared data is unavailable']) {
        const port = send({ type: 'matrix-site-data', request });
        await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith({ error: expected }));
      }
      const oversized = send({ type: 'matrix-site-data', request: { kind: 'kvWrite', key: 'k', value: 'x'.repeat(70 * 1024) } });
      await vi.waitFor(() => expect(oversized.postMessage).toHaveBeenCalledWith({ error: 'Invalid change' }));
      send({ type: 'matrix-site-data', request }, dom.window, 'null');
      send({ type: 'matrix-site-data', request }, undefined, 'https://evil.example');
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally { dom.window.close(); }
  });

  it('does not relay data for private-link pages', async () => {
    const { dom, fetch, send } = page({ ...site, accessMode: 'private_link' }, async () => Response.json({ result: [] }));
    try {
      const port = send({ type: 'matrix-site-data', request });
      await vi.waitFor(() => expect(port.close).toHaveBeenCalled());
      expect(fetch).not.toHaveBeenCalled();
      expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    } finally { dom.window.close(); }
  });
});
