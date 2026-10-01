import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleSlackPilotRequest } from '../../packages/edge-router/src/slack-pilot.js';

const origin = 'https://pr-2079-preview.matrix-os.com';
const upstream = 'https://pr-2079---matrix-platform-preview-example-ey.a.run.app';
const env = { SLACK_PILOT_PUBLIC_ORIGIN: origin, SLACK_PILOT_UPSTREAM_ORIGIN: upstream,
  SLACK_PILOT_NOT_AFTER: '2026-10-02T22:00:00Z' };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function clock() { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T22:00:00Z')); }
function request(path = '/sign-in', init?: RequestInit) { return new Request(origin + path, init); }

describe('bounded legacy Slack pilot sign-in route', () => {
  it('serves the platform auth shell static assets without exposing other shell APIs', async () => {
    clock(); const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('asset'));
    expect((await handleSlackPilotRequest(request('/__platform-shell/_next/static/css/auth.css'), env)).status).toBe(200);
    expect((await handleSlackPilotRequest(request('/__platform-shell/api/files'), env)).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('proxies only the exact approved hostname to its matching tagged preview', async () => {
    clock();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    expect((await handleSlackPilotRequest(request('/api/slack/install', { method: 'POST',
      headers: { origin, 'x-forwarded-host': 'app.matrix-os.com', 'x-matrix-edge-secret': 'forged',
        'x-platform-user-id': 'forged', 'x-platform-verified': 'forged', authorization: 'Bearer own-session' }, body: '{}' }), env)).status).toBe(200);
    const sent = fetch.mock.calls[0]![0] as Request;
    expect(sent.url).toBe(upstream + '/api/slack/install');
    expect(sent.headers.get('origin')).toBe(origin);
    expect(sent.headers.get('authorization')).toBe('Bearer own-session');
    expect(sent.headers.get('x-forwarded-host')).toBe('pr-2079-preview.matrix-os.com');
    for (const name of ['x-matrix-edge-secret', 'x-platform-user-id', 'x-platform-verified']) expect(sent.headers.has(name)).toBe(false);
    expect(sent.redirect).toBe('manual');
    expect(fetch.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it.each(['/vm/pr-2079/api/files', '/api/integrations', '/api/terminal/run', '/api/slack/context',
    '/_next/data/secret', '/api/slack/install/extra', '/sign-injected', '/slack/link/extra'])('denies unrelated path %s', async (path) => {
    clock(); const fetch = vi.spyOn(globalThis, 'fetch');
    expect((await handleSlackPilotRequest(request(path), env)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { SLACK_PILOT_PUBLIC_ORIGIN: 'https://app.matrix-os.com' },
    { SLACK_PILOT_PUBLIC_ORIGIN: origin + '/path' },
    { SLACK_PILOT_UPSTREAM_ORIGIN: upstream.replace('2079', '2080') },
    { SLACK_PILOT_UPSTREAM_ORIGIN: 'https://matrix-platform-preview-example-ey.a.run.app' },
    { SLACK_PILOT_UPSTREAM_ORIGIN: 'https://app.matrix-os.com' },
    { SLACK_PILOT_NOT_AFTER: 'invalid' },
    { SLACK_PILOT_NOT_AFTER: '2026-10-01T21:00:00Z' },
    { SLACK_PILOT_NOT_AFTER: '2027-10-02T22:00:00Z' },
  ])('fails closed with invalid configuration %j', async (override) => {
    clock(); const fetch = vi.spyOn(globalThis, 'fetch');
    expect((await handleSlackPilotRequest(request(), { ...env, ...override })).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('denies a sibling hostname and unauthorised writes before forwarding', async () => {
    clock(); const fetch = vi.spyOn(globalThis, 'fetch');
    expect((await handleSlackPilotRequest(new Request(origin.replace('2079', '2080') + '/sign-in'), env)).status).toBe(404);
    expect((await handleSlackPilotRequest(request('/sign-in', { method: 'POST', body: '{}' }), env)).status).toBe(405);
    expect((await handleSlackPilotRequest(request('/api/slack/install', { method: 'POST', body: '{}', headers: { origin: 'https://app.matrix-os.com' } }), env)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rewrites only same-preview auth redirects and nested return URLs', async () => {
    clock(); vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 307,
      headers: { location: upstream + '/sign-in?redirect_url=' + encodeURIComponent(upstream + '/'),
        'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' } }));
    const response = await handleSlackPilotRequest(request('/'), env);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe(origin); expect(location.searchParams.get('redirect_url')).toBe(origin + '/');
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(response.headers.has('access-control-allow-credentials')).toBe(false);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('preserves the Slack consent redirect without following it', async () => {
    clock(); const target = 'https://slack.com/oauth/v2/authorize?state=opaque';
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 302, headers: { location: target } }));
    expect((await handleSlackPilotRequest(request('/api/slack/oauth/callback'), env)).headers.get('location')).toBe(target);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('drops parent-domain cookies while retaining separate host-only cookies', async () => {
    clock(); const headers = new Headers();
    headers.append('set-cookie', 'a=1; Path=/; Secure; HttpOnly');
    headers.append('set-cookie', 'b=2; Path=/; Secure');
    headers.append('set-cookie', 'injection=3; Domain=matrix-os.com; Secure');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { headers }));
    const response = await handleSlackPilotRequest(request(), env);
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/; Secure; HttpOnly', 'b=2; Path=/; Secure']);
  });
  it('limits actual streamed request bodies rather than trusting Content-Length', async () => {
    clock(); const fetch = vi.spyOn(globalThis, 'fetch');
    const response = await handleSlackPilotRequest(request('/api/slack/install', { method: 'POST',
      headers: { origin, 'content-length': '1' }, body: 'x'.repeat(256 * 1024 + 1) }), env);
    expect(response.status).toBe(413); expect(fetch).not.toHaveBeenCalled();
  });
  it('returns a generic failure when the preview is unavailable', async () => {
    clock(); vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private host details'));
    const response = await handleSlackPilotRequest(request(), env);
    expect(response.status).toBe(503); expect(await response.text()).toBe('Preview unavailable');
  });
  it('stops a stalled incoming body at the deadline without forwarding it', async () => {
    clock(); const fetch = vi.spyOn(globalThis, 'fetch'); const cancel = vi.fn();
    const input = new ReadableStream<Uint8Array>({ cancel });
    const pending = handleSlackPilotRequest(request('/api/slack/install', { method: 'POST',
      headers: { origin }, body: input, duplex: 'half' } as RequestInit), env);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).status).toBe(503); expect(cancel).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  });
  it('aborts a stalled upstream at the deadline', async () => {
    clock();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), ms);
      return controller.signal;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    }));
    const pending = handleSlackPilotRequest(request(), env);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).status).toBe(503);
  });
});
