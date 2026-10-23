import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const members = ['user_pilotone', 'user_pilottwo', 'user_pilotthree'];
const upgradeToken = 'a'.repeat(64);
beforeEach(() => {
  vi.resetModules();
  for (const [key, value] of Object.entries({ MATRIX_PILOT_ACCESS_ENABLED: 'true', MATRIX_PILOT_ALLOWED_CLERK_IDS: members.join(','),
    MATRIX_SELF_HOSTED: '0', E2E_TEST_BYPASS: '0', MATRIX_CLERK_USER_ID: '', MATRIX_AUTH_TOKEN: 'internal-fixture-token',
    UPGRADE_TOKEN: upgradeToken, NEXT_PUBLIC_MATRIX_APP_URL: 'https://app.example.test' })) vi.stubEnv(key, value);
});
afterEach(() => { vi.resetModules(); vi.unstubAllEnvs(); vi.doUnmock('@clerk/nextjs/server'); vi.doUnmock('next/server'); });
async function load(userId: string | null) {
  const auth = vi.fn(async () => ({ userId }));
  const clerk = vi.fn((handler) => async (request: unknown, event: unknown) => handler(auth, request, event));
  vi.doMock('@clerk/nextjs/server', () => ({ clerkMiddleware: clerk }));
  class MockNextResponse extends Response {
    static next = vi.fn(() => new Response(null, { headers: { 'x-fixture-next': '1' } }));
    static rewrite = vi.fn(() => new Response(null, { headers: { 'x-fixture-rewrite': '1' } }));
    static redirect = vi.fn((url: URL) => new Response(null, { status: 307, headers: { location: url.toString() } }));
  }
  vi.doMock('next/server', () => ({ NextResponse: MockNextResponse }));
  const { proxy } = await import('../../shell/src/proxy');
  const send = (pathname: string, headers: HeadersInit = {}, search = '') => proxy({ headers: new Headers(headers),
    nextUrl: { host: 'app.example.test', protocol: 'https:', pathname, search } } as Parameters<typeof proxy>[0], {} as Parameters<typeof proxy>[1]);
  return { send, auth, next: MockNextResponse.next, rewrite: MockNextResponse.rewrite };
}
describe('server-owned three-person pilot shell boundary', () => {
  it.each(['/', '/runtime', '/onboarding/computer', '/auth/device', '/api/auth/device/approve', '/api/native-app-sessions', '/api/integrations/connections', '/files/private.json', '/apps/notes', '/shared'])('refuses signed noncohort actor on %s before application or gateway access', async path => {
    const f = await load('user_outside'); const response = await f.send(path);
    expect(response.status).toBe(403); expect(await response.text()).toBe('Access unavailable');
    expect(f.next).not.toHaveBeenCalled(); expect(f.rewrite).not.toHaveBeenCalled(); expect(f.auth).toHaveBeenCalled();
  });
  it('protects the formerly public billing setup query', async () => {
    const f = await load('user_outside'); expect((await f.send('/', {}, '?billing=setup')).status).toBe(403); expect(f.next).not.toHaveBeenCalled();
  });
  it.each(members)('preserves Clerk middleware and permits reviewed member %s', async userId => {
    const f = await load(userId); expect((await f.send('/')).headers.get('x-fixture-next')).toBe('1');
    expect((await f.send('/api/integrations/connections')).headers.get('x-fixture-rewrite')).toBe('1'); expect(f.auth).toHaveBeenCalled();
  });
  it('ignores forged identity/email headers on a valid noncohort Clerk session', async () => {
    const f = await load('user_outside'); expect((await f.send('/', { 'x-platform-user-id': members[0], 'x-clerk-user-id': members[0], 'x-user-email': 'pilot@example.test' })).status).toBe(403);
    expect(f.next).not.toHaveBeenCalled();
  });
  it.each(['/health', '/manifest.json', '/favicon.ico', '/og.png', '/sign-in', '/sign-in/sso-callback'])('preserves required public authentication/static boundary %s', async path => {
    const f = await load(null); expect((await f.send(path)).headers.get('x-fixture-next')).toBe('1'); expect(f.rewrite).not.toHaveBeenCalled();
  });
  it('refuses pilot enrollment and noncohort signup recovery', async () => {
    const anonymous = await load(null); expect((await anonymous.send('/sign-up')).status).toBe(403);
    const outside = await load('user_outside'); expect((await outside.send('/sign-up')).status).toBe(403);
  });
  it('redirects an unauthenticated protected request through the existing sign-in boundary', async () => {
    const f = await load(null); const response = await f.send('/'); expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/sign-in?redirect_url='); expect(f.next).not.toHaveBeenCalled();
  });
  it.each(['', 'user_bad_id', Array.from({length:101},(_,i)=>`user_member${i}`).join(','), 'user_invalid!'])('fails closed with invalid enabled cohort %s', async ids => {
    vi.stubEnv('MATRIX_PILOT_ALLOWED_CLERK_IDS', ids); const f = await load(members[0]); const response = await f.send('/api/auth/session');
    expect(response.status).toBe(503); expect(f.rewrite).not.toHaveBeenCalled(); expect(await response.text()).toBe('Access unavailable');
  });
  it('rejects an invalid enable flag instead of treating it as disabled', async () => {
    vi.stubEnv('MATRIX_PILOT_ACCESS_ENABLED', 'TRUE'); const f = await load(members[0]);
    expect((await f.send('/api/auth/session')).status).toBe(503); expect(f.rewrite).not.toHaveBeenCalled();
  });
  it('does not let test bypass or self-hosted authentication bypass an enabled pilot gate', async () => {
    vi.stubEnv('E2E_TEST_BYPASS', '1'); const f = await load('user_outside'); expect((await f.send('/')).status).toBe(403); expect(f.next).not.toHaveBeenCalled();
  });
  it('does not treat self-hosted mode as a cohort identity', async () => {
    vi.stubEnv('MATRIX_SELF_HOSTED', '1'); const f = await load(null); expect((await f.send('/api/auth/session')).status).toBe(503); expect(f.rewrite).not.toHaveBeenCalled();
  });
  it('requires a signed platform actor even for a claimed instance owner or app session', async () => {
    vi.stubEnv('MATRIX_CLERK_USER_ID', members[0]); const f = await load(null);
    const headers = { authorization: `Bearer ${upgradeToken}`, 'x-platform-user-id': members[0] };
    expect((await f.send('/', headers)).status).toBe(403);
    expect((await f.send('/apps/notes', headers, '?session=opaque-fixture-session')).status).toBe(403); expect(f.rewrite).not.toHaveBeenCalled();
  });
  it.each([members[0], 'user_outside'])('admits only membership of authenticated platform actor %s', async userId => {
    const f = await load(null); const proof = createHmac('sha256', upgradeToken).update(userId).digest('hex');
    const response = await f.send('/api/integrations/connections', { authorization: `Bearer ${upgradeToken}`, 'x-platform-user-id': userId, 'x-platform-verified': proof });
    expect(response.status).toBe(userId === members[0] ? 200 : 403); expect(f.rewrite).toHaveBeenCalledTimes(userId === members[0] ? 1 : 0);
    expect(f.auth).not.toHaveBeenCalled();
  });
  it('retains independent configured instance ownership after a cohort pass', async () => {
    vi.stubEnv('MATRIX_CLERK_USER_ID', members[1]); const f = await load(members[0]); expect((await f.send('/')).status).toBe(403); expect(f.next).not.toHaveBeenCalled();
  });
  it('disabled mode preserves existing unaffiliated user and public navigation behavior', async () => {
    vi.stubEnv('MATRIX_PILOT_ACCESS_ENABLED', 'false'); vi.stubEnv('MATRIX_PILOT_ALLOWED_CLERK_IDS', 'invalid ignored while disabled'); const f = await load('user_outside');
    expect((await f.send('/')).headers.get('x-fixture-next')).toBe('1'); expect((await f.send('/runtime')).headers.get('x-fixture-next')).toBe('1');
  });
});
