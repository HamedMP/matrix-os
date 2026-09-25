import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  classifyPreviewHost,
  handlePreviewRequest,
} from '../../packages/edge-router/src/preview.js';

const env = {
  PREVIEW_PLATFORM_ORIGIN: 'https://matrix-platform-preview-example.a.run.app',
  PREVIEW_EDGE_MASTER_SECRET: 'a-private-preview-edge-master-secret-with-adequate-length',
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('per-PR Preview edge router', () => {
  it('accepts only an exact PR hostname', () => {
    expect(classifyPreviewHost('pr-1907.preview.matrix-os.com')).toEqual({ prNumber: '1907' });
    for (const host of [
      'preview.matrix-os.com',
      'pr-0.preview.matrix-os.com',
      'pr-01907.preview.matrix-os.com',
      'pr-1907.preview.matrix-os.com.evil.test',
      'foo.pr-1907.preview.matrix-os.com',
      'pr-1907-preview.matrix-os.com',
    ]) {
      expect(classifyPreviewHost(host)).toBeNull();
    }
  });

  it('routes each PR to its tagged staging revision with a trusted host header', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const response = await handlePreviewRequest(new Request(
      'https://pr-1907.preview.matrix-os.com/vm/pr-1907/api/health?x=1',
      { headers: {
        'x-forwarded-host': 'app.matrix-os.com',
        'x-matrix-edge-secret': 'forged',
        'cf-connecting-ip': '203.0.113.7',
      } },
    ), env);

    expect(response.status).toBe(200);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe('https://pr-1907---matrix-platform-preview-example.a.run.app/vm/pr-1907/api/health?x=1');
    expect(request.headers.get('x-forwarded-host')).toBe('pr-1907.preview.matrix-os.com');
    expect(request.headers.get('x-matrix-edge-secret')).toBe(createHmac('sha256', env.PREVIEW_EDGE_MASTER_SECRET)
      .update('matrix-preview-edge-v1:pr-1907').digest('hex'));
    expect(request.headers.get('x-forwarded-for')).toBe('203.0.113.7');
  });

  it('fails closed when the staging origin or secret is missing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('wrong origin'));
    for (const candidate of [
      { ...env, PREVIEW_PLATFORM_ORIGIN: 'not-a-url' },
      { ...env, PREVIEW_PLATFORM_ORIGIN: 'https://app.matrix-os.com' },
      { ...env, PREVIEW_PLATFORM_ORIGIN: 'http://matrix-platform-preview-example.a.run.app' },
      { ...env, PREVIEW_EDGE_MASTER_SECRET: '' },
    ]) {
      const response = await handlePreviewRequest(
        new Request('https://pr-1907.preview.matrix-os.com/'), candidate,
      );
      expect(response.status).toBe(503);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unknown hosts without calling an upstream', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('wrong origin'));
    const response = await handlePreviewRequest(
      new Request('https://preview.matrix-os.com/'), env,
    );
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a different PR runtime beneath a valid PR hostname', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('wrong runtime'));
    const response = await handlePreviewRequest(
      new Request('https://pr-1907.preview.matrix-os.com/vm/pr-1908/api/chat'), env,
    );
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not expose cross-origin response permissions', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-credentials': 'true',
    } }));
    const response = await handlePreviewRequest(
      new Request('https://pr-1907.preview.matrix-os.com/'), env,
    );
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('drops parent-domain cookies but keeps cookies scoped to the PR host', async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'preview_session=abc; Path=/; Secure; HttpOnly');
    headers.append('set-cookie', 'shared_session=bad; Domain=.matrix-os.com; Path=/; Secure');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { headers }));
    const response = await handlePreviewRequest(
      new Request('https://pr-1907.preview.matrix-os.com/'), env,
    );
    expect(response.headers.getSetCookie()).toEqual(['preview_session=abc; Path=/; Secure; HttpOnly']);
  });

  it('rejects oversized uploads before forwarding', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('wrong origin'));
    const response = await handlePreviewRequest(new Request(
      'https://pr-1907.preview.matrix-os.com/api/files',
      { method: 'POST', headers: { 'content-length': String(10 * 1024 * 1024 + 1) }, body: 'x' },
    ), env);
    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '/vm/pr-1907/api/chats/events',
    '/vm/pr-1907/api/files/media?download=true',
  ])('keeps a healthy streaming response alive beyond the header deadline on %s', async (path) => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    let signal!: AbortSignal;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_request, options) => {
      signal = options!.signal!;
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        setTimeout(() => {
          if (!signal.aborted) {
            controller.enqueue(new Uint8Array([9]));
            controller.close();
          }
        }, 35_000);
      } }));
    });
    const response = await handlePreviewRequest(
      new Request(`https://pr-1907.preview.matrix-os.com${path}`), env,
    );
    await vi.advanceTimersByTimeAsync(35_001);
    expect(signal.aborted).toBe(false);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([9]));
  });

  it('bounds the wait for streaming response headers', async () => {
    vi.useFakeTimers();
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    vi.spyOn(globalThis, 'fetch').mockImplementation((_request, options) => {
      fetchStarted();
      return new Promise((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
      });
    });
    const pending = handlePreviewRequest(
      new Request('https://pr-1907.preview.matrix-os.com/vm/pr-1907/api/chats/events'), env,
    );
    await started;
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await pending).status).toBe(503);
  });

  it('preserves the WebSocket handle on a Preview upgrade', async () => {
    vi.useFakeTimers();
    const NativeResponse = Response;
    const webSocket = {} as WebSocket;
    const upstream = {
      status: 101,
      statusText: 'Switching Protocols',
      headers: new Headers(),
      body: null,
      webSocket,
    } as Response & { webSocket: WebSocket };
    let signal!: AbortSignal;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_request, options) => {
      signal = options!.signal!;
      return upstream;
    });
    vi.spyOn(globalThis, 'Response').mockImplementation(function PreviewResponseMock(body, init) {
      if (init?.status === 101) {
        return { ...upstream, headers: new Headers(init.headers), webSocket: (init as typeof init & { webSocket: WebSocket }).webSocket };
      }
      return new NativeResponse(body, init);
    });

    const response = await handlePreviewRequest(new Request(
      'https://pr-1907.preview.matrix-os.com/vm/pr-1907/api/terminal',
      { headers: { upgrade: 'websocket' } },
    ), env) as Response & { webSocket: WebSocket };
    await vi.advanceTimersByTimeAsync(35_001);
    expect(response.status).toBe(101);
    expect(response.webSocket).toBe(webSocket);
    expect(signal.aborted).toBe(false);
  });
});
