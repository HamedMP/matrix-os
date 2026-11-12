import { afterEach, describe, expect, it, vi } from 'vitest';
import { handlePreviewRequest } from '../../packages/edge-router/src/preview.js';

const publicOrigin = 'https://pr-3314-preview.matrix-os.com';
const upstream = 'https://pr-3314---matrix-platform-preview-example.a.run.app';
const now = new Date('2026-11-12T17:00:00Z');
const env = {
  PREVIEW_PLATFORM_ORIGIN: 'https://matrix-platform-preview-example.a.run.app',
  PREVIEW_LEGACY_PUBLIC_ORIGIN: publicOrigin,
  PREVIEW_LEGACY_NOT_AFTER: '2026-11-12T21:00:00Z',
  PREVIEW_LEGACY_EDGE_SECRET: 'dedicated-staging-edge-secret-at-least-32-characters',
};

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('owner-approved, expiring evidence alias', () => {
  it('opens the matching preview with staging authentication and replaces forged routing headers', async () => {
    vi.setSystemTime(now);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('preview'));
    const response = await handlePreviewRequest(new Request(publicOrigin + '/vm/pr-3314/api/health', {
      headers: { 'x-forwarded-host': 'app.matrix-os.com', 'x-matrix-edge-secret': 'forged',
        'x-platform-user-id': 'forged-owner' },
    }), env);
    expect(response.status).toBe(200);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe(upstream + '/vm/pr-3314/api/health');
    expect(request.headers.get('x-forwarded-host')).toBe('pr-3314-preview.matrix-os.com');
    expect(request.headers.get('x-matrix-edge-secret')).toBe(env.PREVIEW_LEGACY_EDGE_SECRET);
    expect(request.headers.get('x-platform-user-id')).toBeNull();
  });

  it.each([
    'https://pr-3315-preview.matrix-os.com/',
    'https://pr-3314.preview.matrix-os.com/',
    publicOrigin + '/vm/pr-3315/api/health',
    publicOrigin + '/vm/pr-3314/~runtime/pr-3315/api/health',
    publicOrigin + '/vm/pr-3314/api/health?runtime=primary',
  ])('refuses sibling hosts and computers: %s', async (url) => {
    vi.setSystemTime(now);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('wrong runtime'));
    expect((await handlePreviewRequest(new Request(url), env)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['2026-11-12T17:00:00Z', '2026-11-12T16:59:59Z', '2026-11-12T21:00:01Z', 'invalid'])
    ('never forwards an expired, unbounded or malformed approval: %s', async (expiry) => {
      vi.setSystemTime(now);
      const fetchMock = vi.spyOn(globalThis, 'fetch');
      expect((await handlePreviewRequest(new Request(publicOrigin), { ...env, PREVIEW_LEGACY_NOT_AFTER: expiry })).status).toBe(503);
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it.each([
    { PREVIEW_LEGACY_PUBLIC_ORIGIN: '' },
    { PREVIEW_LEGACY_PUBLIC_ORIGIN: 'https://app.matrix-os.com' },
    { PREVIEW_LEGACY_PUBLIC_ORIGIN: publicOrigin + '/nested' },
    { PREVIEW_LEGACY_EDGE_SECRET: '' },
    { PREVIEW_LEGACY_NOT_AFTER: '' },
  ])('fails closed for incomplete alias configuration: %j', async (patch) => {
    vi.setSystemTime(now);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const response = await handlePreviewRequest(new Request(publicOrigin), { ...env, ...patch });
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires same-origin browser mutations while preserving authenticated native calls', async () => {
    vi.setSystemTime(now);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const denied = await handlePreviewRequest(new Request(publicOrigin + '/api/mcp-servers', {
      method: 'POST', headers: { cookie: '__session=owner', origin: 'https://evil.test' }, body: '{}',
    }), env);
    expect(denied.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    const native = await handlePreviewRequest(new Request(publicOrigin + '/mcp', {
      method: 'POST', headers: { authorization: 'Bearer native-client' }, body: '{}',
    }), env);
    expect(native.status).toBe(200);
  });

  it('keeps sign-in redirects on the approved alias and strips parent-domain cookies', async () => {
    vi.setSystemTime(now);
    const headers = new Headers({ location: upstream + '/sign-in?redirect_url=' + encodeURIComponent(upstream + '/vm/pr-3314') });
    headers.append('set-cookie', 'preview_session=ok; Path=/; Secure; HttpOnly');
    headers.append('set-cookie', 'parent=denied; Domain=.matrix-os.com; Path=/');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 302, headers }));
    const response = await handlePreviewRequest(new Request(publicOrigin), env);
    const redirect = new URL(response.headers.get('location')!);
    expect(redirect.origin).toBe(publicOrigin);
    expect(redirect.searchParams.get('redirect_url')).toBe(publicOrigin + '/vm/pr-3314');
    expect(response.headers.getSetCookie()).toEqual(['preview_session=ok; Path=/; Secure; HttpOnly']);
  });
});
