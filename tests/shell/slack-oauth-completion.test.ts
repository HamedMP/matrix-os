import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { finishSlackOAuth, readSlackOAuthQuery } from '../../shell/src/lib/slack-oauth-completion';
import { SLACK_DEV_OAUTH_SCRUB_SCRIPT } from '../../shell/src/lib/slack-dev-oauth-privacy';
import { isPublicShellPath } from '../../shell/src/lib/proxy-routes';
import { finishSlackDevOAuth, loadSlackDevOAuthConfig, readSlackDevOAuthLocation, startSlackDevOAuth } from '../../shell/src/lib/slack-dev-oauth';

const query = { state: 'a'.repeat(43), code: 'opaque.code' };
const ticket = ['v1', 'a'.repeat(16), 'A'.repeat(22), 'b'.repeat(96)].join('.');
const ticketFragment = '#' + new URLSearchParams({ ticket });
const devPage = 'https://app.matrix-os.com/vm/fixture-dev/slack/oauth/complete';
const devConfig = {
  handle: 'fixture-dev', machineId: '11111111-2222-4333-8444-555555555555', organizationId: 'org_fixture',
  platformOrigin: 'https://slack-dev-11111111---matrix-platform-preview-fixture-ey.a.run.app',
};
describe('Dev browser Slack OAuth', () => {
  it('clears the fragment before other shell scripts and hands it only to an in-memory listener', () => {
    const layout = readFileSync(new URL('../../shell/src/app/layout.tsx', import.meta.url), 'utf8');
    expect(layout).toMatch(/id="matrix-slack-dev-oauth-privacy" strategy="beforeInteractive"\s*>\{SLACK_DEV_OAUTH_SCRUB_SCRIPT\}/);
    expect(layout.indexOf('id="matrix-slack-dev-oauth-privacy"')).toBeLessThan(layout.indexOf('/billing/tracking.js'));
    const location = new URL(devPage + ticketFragment);
    const capture = vi.fn();
    const listener = vi.fn((_, receive: (event: { detail: typeof capture }) => void) => receive({ detail: capture }));
    const replaceState = vi.fn((_, __, path: string) => { location.href = 'https://app.matrix-os.com' + path; });
    runInNewContext(SLACK_DEV_OAUTH_SCRUB_SCRIPT, { window: { location, history: { replaceState }, addEventListener: listener } });
    expect(location.href).toBe(devPage);
    expect(replaceState).toHaveBeenCalledBefore(listener);
    expect(listener).toHaveBeenCalledWith('matrix-slack-dev-oauth-handoff', expect.any(Function), { once: true });
    expect(capture).toHaveBeenCalledWith({ search: '', hash: ticketFragment });
    const otherPage = new URL(devPage.replace('fixture-dev', 'other-machine') + '#unrelated');
    runInNewContext(SLACK_DEV_OAUTH_SCRUB_SCRIPT, { window: { location: otherPage, history: { replaceState }, addEventListener: listener } });
    expect(otherPage.hash).toBe('#unrelated');
    expect(replaceState).toHaveBeenCalledOnce();
  });
  it('accepts one bounded sealed ticket in the exact Dev fragment and rejects plaintext callback fields', () => {
    expect(readSlackDevOAuthLocation(new URL(devPage + ticketFragment))).toEqual({ handle: devConfig.handle, ticket });
    expect(readSlackDevOAuthLocation(new URL(devPage + '?' + ticketFragment.slice(1)))).toBeNull();
    expect(readSlackDevOAuthLocation(new URL(devPage.replace('app.matrix-os.com', 'other.test') + ticketFragment))).toBeNull();
    expect(readSlackDevOAuthLocation(new URL(devPage.replace('fixture-dev', 'primary')))).toBeNull();
    for (const invalid of [
      '#' + new URLSearchParams(query), ticketFragment + '&code=plaintext', ticketFragment + '&ticket=' + ticket, ticketFragment + 'a'.repeat(3_000),
    ]) expect(readSlackDevOAuthLocation(new URL(devPage + invalid))).toEqual({ handle: devConfig.handle, error: 'invalid' });
  });
  it('reads the bound target using same-origin authentication and refuses a different VM or tag', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(devConfig));
    expect(await loadSlackDevOAuthConfig(devConfig.handle, fetch)).toEqual(devConfig);
    expect(fetch).toHaveBeenCalledWith('/vm/fixture-dev/api/slack/dev-oauth/config',
      expect.objectContaining({ credentials: 'same-origin', redirect: 'error' }));
    for (const altered of [
      { ...devConfig, handle: 'other-dev' },
      { ...devConfig, platformOrigin: 'https://slack-dev-22222222---matrix-platform-preview-fixture-ey.a.run.app' },
      { ...devConfig, platformOrigin: 'https://other.example' },
    ]) expect(await loadSlackDevOAuthConfig(devConfig.handle, vi.fn().mockResolvedValue(Response.json(altered)))).toBeNull();
  });
  it('requests a fresh session only on invocation and sends it only to the validated tag, without cookies or URL secrets', async () => {
    const token = vi.fn().mockResolvedValue('real-clerk-bearer');
    const fetch = vi.fn().mockResolvedValue(Response.json({ connected: true }));
    expect(await finishSlackDevOAuth(devConfig, ticket, token, fetch)).toBe('connected');
    expect(token).toHaveBeenCalledExactlyOnceWith({ skipCache: true });
    expect(fetch).toHaveBeenCalledWith(devConfig.platformOrigin + '/api/slack/oauth/complete', expect.objectContaining({
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: expect.objectContaining({ authorization: 'Bearer real-clerk-bearer' }),
      body: JSON.stringify({ ticket }),
    }));
    token.mockClear();
    fetch.mockClear();
    expect(await finishSlackDevOAuth({ ...devConfig, platformOrigin: 'https://other.example' }, ticket, token, fetch)).toBe('unavailable');
    expect(await finishSlackDevOAuth(devConfig, query.code, token, fetch)).toBe('unavailable');
    expect(token).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(Response.json({ url: 'https://other.example/oauth/v2/authorize' }));
    expect(await startSlackDevOAuth(devConfig, token, fetch)).toEqual({ status: 'unavailable' });
  });
});
describe('browser Slack OAuth completion', () => {
  it('exposes only the exact callback completion page before sign-in', () => {
    expect(isPublicShellPath('/slack/oauth/complete')).toBe(true);
    expect(isPublicShellPath('/slack/oauth/complete/extra')).toBe(false);
  });
  it.each(['?state=bad&code=ok', '?state='+query.state+'&code=ok&extra=x', '?state='+query.state+'&state='+query.state+'&code=ok'])('rejects malformed or ambiguous callback query %s', (search) => {
    expect(readSlackOAuthQuery(search)).toBeNull();
  });
  it('refreshes its own session and submits the same code and state only to the callback', async () => {
    const token = vi.fn().mockResolvedValue('fresh-own-token');
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ connected: true, teamId: 'T123' }), { status: 200 }));
    expect(await finishSlackOAuth(query, token, fetch)).toBe('connected');
    expect(token).toHaveBeenCalledWith({ skipCache: true });
    const [path, options] = fetch.mock.calls[0];
    const url = new URL(path, 'https://app.matrix-os.com');
    expect(url.pathname).toBe('/api/slack/oauth/callback');
    expect(Object.fromEntries(url.searchParams)).toEqual(query);
    expect(options.headers.authorization).toBe('Bearer fresh-own-token');
    expect(options.credentials).toBe('omit');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.redirect).toBe('error');
  });
  it('does not submit without a refreshed signed-in session', async () => {
    const fetch = vi.fn();
    expect(await finishSlackOAuth(query, async()=>null, fetch)).toBe('signed_out');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([[401,'signed_out'],[403,'forbidden'],[409,'expired'],[503,'unavailable']] as const)('maps status %s without provider details', async (status, result) => {
    const fetch = vi.fn().mockResolvedValue(new Response('private upstream error', { status }));
    expect(await finishSlackOAuth(query, async()=>'own', fetch)).toBe(result);
  });
  it('contains credential refresh and network failures', async () => {
    expect(await finishSlackOAuth(query, async()=>{throw new Error('secret detail')}, vi.fn())).toBe('unavailable');
    expect(await finishSlackOAuth(query, async()=>'own', vi.fn().mockRejectedValue(new Error('private network')))).toBe('unavailable');
  });
  it('bounds a stalled session refresh without sending the callback', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn();
      const pending = finishSlackOAuth(query, () => new Promise(() => {}), fetch);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toBe('unavailable');
      expect(fetch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('rejects an unexpected success payload', async () => {
    expect(await finishSlackOAuth(query, async()=>'own', vi.fn().mockResolvedValue(new Response('{"connected":false}')))).toBe('unavailable');
  });
});
