import { describe, expect, it, vi } from 'vitest';
import { finishSlackOAuth, readSlackOAuthQuery } from '../../shell/src/lib/slack-oauth-completion';
import { isPublicShellPath } from '../../shell/src/lib/proxy-routes';

const query = { state: 'a'.repeat(43), code: 'opaque.code' };
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
