import { describe, expect, it, vi } from 'vitest';
import { resolveSiteClerkIdentity } from '../../packages/platform/src/sites/clerk-identity.js';
import type { VerifyResult } from '../../packages/platform/src/clerk-auth.js';

const verified: VerifyResult = { authenticated: true, userId: 'user_recipient', sessionId: 'sess_browser', tokenExpiresAt: Math.floor(Date.now() / 1000) + 60 };
const user = {
  id: 'user_recipient', banned: false, locked: false, deprovisioned: false,
  email_addresses: [
    { email_address: 'Primary@Example.com', verification: { status: 'verified' } },
    { email_address: 'SECONDARY@example.com', verification: { status: 'verified' } },
    { email_address: 'unverified@example.com', verification: { status: 'unverified' } },
  ],
};

function fixture(overrides: Partial<typeof user> = {}, result: VerifyResult = verified) {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ...user, ...overrides }), { status: 200 }));
  const verify = vi.fn(async () => result);
  return { fetchImpl, verify, secretKey: 'sk_test_disposable' };
}

describe('Matrix.page authoritative Clerk identity', () => {
  it('uses the same verified Clerk session and includes verified primary and secondary emails only', async () => {
    const deps = fixture();
    const identity = await resolveSiteClerkIdentity('Bearer session.jwt.token', deps);
    expect(identity).toEqual({ clerkUserId: 'user_recipient', clerkSessionId: 'sess_browser',
      verifiedEmails: ['primary@example.com', 'secondary@example.com'] });
    expect(deps.verify).toHaveBeenCalledWith('session.jwt.token');
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = deps.fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://api.clerk.com/v1/users/user_recipient');
    expect(init).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer sk_test_disposable' } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('denies inactive users and refuses unverified email text or client identity claims', async () => {
    for (const key of ['banned', 'locked', 'deprovisioned'] as const) {
      const deps = fixture({ [key]: true });
      await expect(resolveSiteClerkIdentity('Bearer session.jwt.token', deps)).rejects.toMatchObject({ code: 'not_found' });
    }
    const onlyUnverified = fixture({ email_addresses: [{ email_address: 'unverified@example.com', verification: { status: 'unverified' } }] });
    await expect(resolveSiteClerkIdentity('Bearer session.jwt.token', onlyUnverified)).rejects.toMatchObject({ code: 'not_found' });
    const badSession = fixture({}, { ...verified, authenticated: false, userId: 'user_attacker' });
    await expect(resolveSiteClerkIdentity('Bearer session.jwt.token', badSession)).rejects.toMatchObject({ code: 'not_found' });
    expect(badSession.fetchImpl).not.toHaveBeenCalled();
  });

  it('enforces bounded bearer and exact authoritative response with generic provider failure', async () => {
    const deps = fixture();
    for (const header of [undefined, 'Bearer ', `Bearer ${'x'.repeat(8193)}`, 'Basic token', 'Bearer one two']) {
      await expect(resolveSiteClerkIdentity(header, deps)).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    const mismatched = fixture({ id: 'user_other' });
    await expect(resolveSiteClerkIdentity('Bearer session.jwt.token', mismatched)).rejects.toMatchObject({ code: 'not_found' });
    const oversized = fixture();
    oversized.fetchImpl.mockResolvedValueOnce(new Response('x'.repeat(1_048_577), { status: 200 }));
    await expect(resolveSiteClerkIdentity('Bearer session.jwt.token', oversized)).rejects.toMatchObject({ code: 'unavailable' });
  });
});
