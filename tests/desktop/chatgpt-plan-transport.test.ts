import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ whenReady: vi.fn(), fromPartition: vi.fn(), privateFetch: vi.fn(), defaultFetch: vi.fn() }));
vi.mock('electron', () => ({ app: { whenReady: electron.whenReady },
  session: { fromPartition: electron.fromPartition, defaultSession: { fetch: electron.defaultFetch } } }));
let nodeFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  electron.whenReady.mockResolvedValue(undefined);
  electron.fromPartition.mockReturnValue({ fetch: electron.privateFetch });
  nodeFetch = vi.fn(async () => new Response('Node fallback must not be used'));
  vi.stubGlobal('fetch', nodeFetch);
});

it('creates no session at import and shares one fixed private session across concurrent first requests', async () => {
  let ready!: () => void;
  electron.whenReady.mockReturnValue(new Promise<void>(resolve => { ready = resolve; }));
  electron.privateFetch.mockImplementation(async () => new Response('synthetic response'));
  const { fetchNativePlan } = await import('../../desktop/src/main/chatgpt-plan/transport');
  expect(electron.fromPartition).not.toHaveBeenCalled(); expect(electron.whenReady).not.toHaveBeenCalled();
  const pending = Array.from({ length: 4 }, () => fetchNativePlan('https://fixture.test/responses', { redirect: 'error' }));
  expect(electron.fromPartition).not.toHaveBeenCalled();
  ready(); await Promise.all(pending);
  expect(electron.fromPartition).toHaveBeenCalledExactlyOnceWith('matrix-chatgpt-plan-network', { cache: false });
  expect(electron.fromPartition.mock.calls[0][0]).not.toMatch(/^persist:/);
  expect(electron.privateFetch).toHaveBeenCalledTimes(4);
  await fetchNativePlan('https://fixture.test/models', { redirect: 'error' });
  expect(electron.fromPartition).toHaveBeenCalledOnce();
  expect(nodeFetch).not.toHaveBeenCalled(); expect(electron.defaultFetch).not.toHaveBeenCalled();
});

it('rejects an already stopped caller before waiting for app readiness or creating a network session', async () => {
  const controller = new AbortController(), reason = new DOMException('synthetic stop', 'AbortError'); controller.abort(reason);
  const { fetchNativePlan } = await import('../../desktop/src/main/chatgpt-plan/transport');
  await expect(fetchNativePlan('https://fixture.test/responses', { signal: controller.signal })).rejects.toBe(reason);
  expect(electron.whenReady).not.toHaveBeenCalled(); expect(electron.fromPartition).not.toHaveBeenCalled();
  expect(electron.privateFetch).not.toHaveBeenCalled(); expect(nodeFetch).not.toHaveBeenCalled();
});

it('stops promptly during readiness, removes its listener, and never sends the request when readiness arrives later', async () => {
  let ready!: () => void;
  electron.whenReady.mockReturnValue(new Promise<void>(resolve => { ready = resolve; }));
  const controller = new AbortController(), reason = new DOMException('synthetic stop', 'AbortError');
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const { fetchNativePlan } = await import('../../desktop/src/main/chatgpt-plan/transport');
  const stopped = expect(fetchNativePlan('https://fixture.test/responses', { signal: controller.signal })).rejects.toBe(reason);
  controller.abort(reason); await stopped;
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  ready(); await Promise.resolve(); await Promise.resolve();
  expect(electron.fromPartition).not.toHaveBeenCalled(); expect(electron.privateFetch).not.toHaveBeenCalled();
  expect(nodeFetch).not.toHaveBeenCalled();
});

it('does not miss an abort raised while readiness is being obtained', async () => {
  const controller = new AbortController(), reason = new DOMException('synthetic stop', 'AbortError');
  let ready!: () => void, observed: unknown;
  electron.whenReady.mockImplementation(() => {
    controller.abort(reason); return new Promise<void>(resolve => { ready = resolve; });
  });
  const { fetchNativePlan } = await import('../../desktop/src/main/chatgpt-plan/transport');
  const pending = fetchNativePlan('https://fixture.test/responses', { signal: controller.signal })
    .then(() => { observed = 'request unexpectedly sent'; }, error => { observed = error; });
  try {
    await vi.waitFor(() => expect(observed).toBe(reason), { timeout: 100 });
    expect(electron.fromPartition).not.toHaveBeenCalled(); expect(electron.privateFetch).not.toHaveBeenCalled();
  } finally { ready(); await pending; }
});

it('removes the readiness abort listener once ready and forwards that same signal to Chromium', async () => {
  const controller = new AbortController(), add = vi.spyOn(controller.signal, 'addEventListener');
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  electron.privateFetch.mockResolvedValue(new Response('synthetic response'));
  const { fetchNativePlan } = await import('../../desktop/src/main/chatgpt-plan/transport');
  await fetchNativePlan('https://fixture.test/responses', { signal: controller.signal });
  expect(add).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function), { once: true });
  expect(remove).toHaveBeenCalledExactlyOnceWith('abort', add.mock.calls[0][1]);
  expect(electron.privateFetch.mock.calls[0][1].signal).toBe(controller.signal);
});

it('honours a stopped Request signal before readiness without reconstructing the request', async () => {
  const controller = new AbortController(), reason = new DOMException('synthetic stop', 'AbortError');
  const input = new Request('https://fixture.test/responses', { signal: controller.signal }); controller.abort(reason);
  const { fetchNativePlan } = await import('../../desktop/src/main/chatgpt-plan/transport');
  await expect(fetchNativePlan(input)).rejects.toBe(reason);
  expect(electron.whenReady).not.toHaveBeenCalled(); expect(electron.privateFetch).not.toHaveBeenCalled();
  expect(input.bodyUsed).toBe(false);
});

it('normalizes URL objects while preserving Request objects and suppressing ambient credentials/cache', async () => {
  electron.privateFetch.mockImplementation(async () => new Response('synthetic response'));
  const { fetchNativePlan } = await import('../../desktop/src/main/chatgpt-plan/transport');
  const url = new URL('https://fixture.test/models');
  await fetchNativePlan(url, { credentials: 'include', cache: 'force-cache', redirect: 'error' });
  expect(electron.privateFetch).toHaveBeenNthCalledWith(1, url.toString(), { credentials: 'omit', cache: 'no-store', redirect: 'error' });
  const input = new Request('https://fixture.test/responses', { method: 'POST', body: 'synthetic request body',
    headers: { authorization: 'synthetic explicit bearer' }, redirect: 'error' });
  await fetchNativePlan(input);
  expect(electron.privateFetch).toHaveBeenNthCalledWith(2, input, { credentials: 'omit', cache: 'no-store' });
  expect(electron.privateFetch.mock.calls[1][0]).toBe(input); expect(input.bodyUsed).toBe(false);
  expect(input.headers.get('authorization')).toBe('synthetic explicit bearer');
  expect(nodeFetch).not.toHaveBeenCalled();
});

it('passes through the original streaming Response before EOF and preserves consumer cancellation without buffering', async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>, cancelled = false;
  const cancel = vi.fn(() => { cancelled = true; });
  const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, cancel });
  const response = new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  electron.privateFetch.mockResolvedValue(response);
  const { fetchNativePlan } = await import('../../desktop/src/main/chatgpt-plan/transport');
  let returned = false;
  const pending = fetchNativePlan('https://fixture.test/responses').then(value => { returned = true; return value; });
  try {
    await vi.waitFor(() => expect(returned).toBe(true), { timeout: 200 });
    const result = await pending; expect(result).toBe(response); expect(stream.locked).toBe(false);
    const reader = result.body!.getReader();
    const bytes = new TextEncoder().encode('data: synthetic progress\n\n'); source.enqueue(bytes);
    expect(await reader.read()).toEqual({ done: false, value: bytes });
    await reader.cancel(); reader.releaseLock(); expect(cancel).toHaveBeenCalledOnce();
    expect(electron.privateFetch).toHaveBeenCalledOnce(); expect(nodeFetch).not.toHaveBeenCalled();
  } finally { if (!cancelled) source.close(); }
});

it('forwards Stop to the original Chromium body without replacing its error or starting a second request', async () => {
  const controller = new AbortController(), reason = new DOMException('synthetic stop', 'AbortError');
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { source = value; } }));
  electron.privateFetch.mockImplementation(async (_input, init) => {
    init.signal.addEventListener('abort', () => source.error(init.signal.reason), { once: true }); return response;
  });
  const { fetchNativePlan } = await import('../../desktop/src/main/chatgpt-plan/transport');
  const result = await fetchNativePlan('https://fixture.test/responses', { signal: controller.signal });
  const reader = result.body!.getReader(), stopped = expect(reader.read()).rejects.toBe(reason);
  controller.abort(reason); await stopped; reader.releaseLock();
  expect(result).toBe(response); expect(electron.privateFetch).toHaveBeenCalledOnce();
  expect(nodeFetch).not.toHaveBeenCalled();
});

it.each(['ready', 'session', 'fetch'] as const)('propagates an unchanged %s failure without retry or Node/defaultSession fallback', async stage => {
  const failure = Object.assign(new TypeError('synthetic failure'), { code: 'ECONNRESET' });
  if (stage === 'ready') electron.whenReady.mockRejectedValue(failure);
  if (stage === 'session') electron.fromPartition.mockImplementation(() => { throw failure; });
  if (stage === 'fetch') electron.privateFetch.mockRejectedValue(failure);
  const { fetchNativePlan } = await import('../../desktop/src/main/chatgpt-plan/transport');
  await expect(fetchNativePlan('https://fixture.test/responses')).rejects.toBe(failure);
  expect(electron.whenReady).toHaveBeenCalledOnce();
  expect(electron.fromPartition).toHaveBeenCalledTimes(stage === 'ready' ? 0 : 1);
  expect(electron.privateFetch).toHaveBeenCalledTimes(stage === 'fetch' ? 1 : 0);
  expect(nodeFetch).not.toHaveBeenCalled(); expect(electron.defaultFetch).not.toHaveBeenCalled();
});

it.each(['file:///synthetic-private-input', 'data:text/plain,synthetic-private-input', 'custom:synthetic-private-input']
  .flatMap(url => ['string', 'URL', 'Request'].map(form => ({ url, form }))))('rejects $form input with nonnetwork target $url before creating any session', async ({ url, form }) => {
  electron.privateFetch.mockResolvedValue(new Response('must not be reached'));
  const input = form === 'URL' ? new URL(url) : form === 'Request' ? new Request(url) : url;
  const { fetchNativePlan } = await import('../../desktop/src/main/chatgpt-plan/transport');
  const failure = await fetchNativePlan(input, { redirect: 'error' }).catch(error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toBe('Unsupported native plan transport URL');
  expect(String(failure.stack)).not.toContain('synthetic-private-input');
  expect(electron.whenReady).not.toHaveBeenCalled(); expect(electron.fromPartition).not.toHaveBeenCalled();
  expect(electron.privateFetch).not.toHaveBeenCalled(); expect(nodeFetch).not.toHaveBeenCalled();
  if (input instanceof Request) expect(input.bodyUsed).toBe(false);
});

it('rejects malformed string targets with the same fixed error without leaking the input or creating a session', async () => {
  electron.privateFetch.mockResolvedValue(new Response('must not be reached'));
  const { fetchNativePlan } = await import('../../desktop/src/main/chatgpt-plan/transport');
  const failure = await fetchNativePlan('synthetic-private-malformed-target').catch(error => error);
  expect(failure).toBeInstanceOf(Error); expect(failure.message).toBe('Unsupported native plan transport URL');
  expect(String(failure.stack)).not.toContain('synthetic-private-malformed-target');
  expect(electron.fromPartition).not.toHaveBeenCalled(); expect(electron.privateFetch).not.toHaveBeenCalled();
});

it.each(['http', 'https'])('preserves caller authority and redirect policy for an allowed %s network target', async protocol => {
  const response = new Response('synthetic response'); electron.privateFetch.mockResolvedValue(response);
  const { fetchNativePlan } = await import('../../desktop/src/main/chatgpt-plan/transport');
  const url = `${protocol}://fixture.test/responses`, headers = { authorization: 'synthetic explicit bearer' };
  expect(await fetchNativePlan(url, { headers, redirect: 'error', method: 'POST', body: 'synthetic input' })).toBe(response);
  expect(electron.privateFetch).toHaveBeenCalledExactlyOnceWith(url, { headers, redirect: 'error', method: 'POST',
    body: 'synthetic input', credentials: 'omit', cache: 'no-store' });
});

it('sends the same validated URL snapshot when a caller mutates its URL object while app readiness is pending', async () => {
  let ready!: () => void;
  electron.whenReady.mockReturnValue(new Promise<void>(resolve => { ready = resolve; }));
  electron.privateFetch.mockResolvedValue(new Response('synthetic response'));
  const { fetchNativePlan } = await import('../../desktop/src/main/chatgpt-plan/transport');
  const input = new URL('https://fixture.test/responses');
  const pending = fetchNativePlan(input, { redirect: 'error' });
  input.href = 'file:///synthetic-private-input';
  ready(); await pending;
  expect(electron.privateFetch).toHaveBeenCalledExactlyOnceWith('https://fixture.test/responses', {
    redirect: 'error', credentials: 'omit', cache: 'no-store',
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('sends one request through an isolated in-memory Chromium session instead of the Node or renderer default-session network paths', async () => {
  const response = new Response('scripted Chromium response');
  electron.privateFetch.mockResolvedValue(response);
  const { fetchNativePlan } = await import('../../desktop/src/main/chatgpt-plan/transport');
  const controller = new AbortController(), headers = { authorization: 'synthetic explicit bearer', 'content-type': 'application/json' };
  const result = await fetchNativePlan('https://fixture.test/responses', {
    method: 'POST', body: '{"synthetic":true}', headers, signal: controller.signal, redirect: 'error',
  });
  expect(electron.fromPartition).toHaveBeenCalledExactlyOnceWith('matrix-chatgpt-plan-network', { cache: false });
  expect(electron.privateFetch).toHaveBeenCalledExactlyOnceWith('https://fixture.test/responses', {
    method: 'POST', body: '{"synthetic":true}', headers, signal: controller.signal, redirect: 'error',
    credentials: 'omit', cache: 'no-store',
  });
  expect(result).toBe(response);
  expect(nodeFetch).not.toHaveBeenCalled(); expect(electron.defaultFetch).not.toHaveBeenCalled();
});
