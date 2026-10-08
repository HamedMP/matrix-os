import { describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { prepareClerkAppleRevocation } from '../../packages/platform/src/account-deletion/apple.js';

const clients = { serviceId: 'web.matrix', nativeClientId: 'com.matrixos.mobile' };

describe('Clerk Apple deletion credential fallback', () => {
  it('allows the standard opaque Clerk response to use manual revocation without guessing a client ID', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(prepareClerkAppleRevocation([{ external_account_id: 'e1', token: 'opaque-web-token' }], {}, clients, request))
      .resolves.toEqual({ tokens: [], manualRevocationRequired: true });
    expect(request).not.toHaveBeenCalled();
  });

  it('does not trust an unverified client_id or an optional expiry to manufacture provenance', async () => {
    await expect(prepareClerkAppleRevocation([{ external_account_id: 'e1', token: 'opaque',
      client_id: clients.serviceId, expires_at: Date.now() + 60_000 }], {}, clients))
      .resolves.toEqual({ tokens: [], manualRevocationRequired: true });
  });

  it('allows deletion when Clerk has no credential instead of indefinitely blocking cleanup', async () => {
    await expect(prepareClerkAppleRevocation([], {}, clients))
      .resolves.toEqual({ tokens: [], manualRevocationRequired: true });
  });

  it('requires manual revocation for a credential whose lifetime is unknown or expired', async () => {
    for (const extra of [{}, { expires_at: 100 }]) {
      await expect(prepareClerkAppleRevocation([{ token: 'opaque', external_account_id: 'e1', ...extra }],
        { e1: clients.serviceId }, clients, fetch, 100_000))
        .resolves.toEqual({ tokens: [], manualRevocationRequired: true });
    }
  });

  it('retains a fresh verified web token while reporting another opaque grant for manual revocation', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const idToken = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'apple-key' })
      .setIssuer('https://appleid.apple.com').setSubject('apple-user').setAudience(clients.serviceId)
      .setIssuedAt().setExpirationTime('1h').sign(privateKey);
    const jwk = { ...await exportJWK(publicKey), kid: 'apple-key', alg: 'RS256', use: 'sig' };
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.redirect).toBe('error');
      return Response.json({ keys: [jwk] });
    });
    await expect(prepareClerkAppleRevocation([
      { token: 'verified-web', external_account_id: 'e1', id_token: idToken, expires_at: Date.now() + 60_000 },
      { token: 'opaque-other', external_account_id: 'e2' },
    ], {}, clients, request)).resolves.toEqual({ tokens: [
      { clientId: clients.serviceId, token: 'verified-web', tokenType: 'access_token' },
    ], manualRevocationRequired: true });
    expect(request).toHaveBeenCalledOnce();
  });

  it('keeps a provider network failure retryable instead of silently claiming manual fallback', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const idToken = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'apple-key' })
      .setIssuer('https://appleid.apple.com').setAudience(clients.serviceId).setIssuedAt().setExpirationTime('1h').sign(privateKey);
    await expect(prepareClerkAppleRevocation([{ token: 'opaque', id_token: idToken, expires_at: Date.now() + 60_000 }],
      {}, clients, async () => { throw new Error('provider unavailable'); }))
      .rejects.toThrow('provider unavailable');
  });

  it('rejects invalid configuration instead of converting it into missing credentials', async () => {
    await expect(prepareClerkAppleRevocation([], {}, { ...clients, serviceId: '' }))
      .rejects.toThrow();
  });

  it('rejects a forged identity token rather than treating it as an absent credential', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const { publicKey } = await generateKeyPair('RS256');
    const idToken = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'apple-key' })
      .setIssuer('https://appleid.apple.com').setAudience(clients.serviceId).setIssuedAt().setExpirationTime('1h').sign(privateKey);
    await expect(prepareClerkAppleRevocation([{ token: 'opaque', id_token: idToken, expires_at: Date.now() + 60_000 }],
      {}, clients, async () => Response.json({ keys: [{ ...await exportJWK(publicKey), kid: 'apple-key', alg: 'RS256' }] })))
      .rejects.toThrow();
  });

});
