import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KyselyPGlite } from 'kysely-pglite';
import { createPlatformDb, type PlatformDb } from '../../packages/gateway/src/platform-db.js';
import { NativeGmailOAuthManager } from '../../packages/gateway/src/integrations/native-gmail/oauth.js';
import { createNativeGmailRequest } from '../../packages/gateway/src/integrations/native-gmail/request.js';
import { GMAIL_SCOPE } from '../../packages/gateway/src/integrations/native-gmail/types.js';

describe('native Gmail final eligibility/revision ordering', () => {
  let db: PlatformDb; let owner: string; let now: number; let provider: ReturnType<typeof vi.fn>; let manager: NativeGmailOAuthManager;
  const key = Buffer.alloc(32, 9);
  const credentials = (accessToken: string) => Response.json({ access_token: accessToken, refresh_token: `${accessToken}-refresh`, expires_in: 3600, token_type: 'Bearer', scope: GMAIL_SCOPE });
  const createManager = (isEligible?: (userId: string) => Promise<boolean>) => new NativeGmailOAuthManager({ store: db.nativeGmailStore!, clientId: 'client', clientSecret: 'secret',
    redirectUri: 'https://app.matrix-os.com/api/integrations/gmail/oauth/callback', encryptionKey: key, fetcher: provider, now: () => now, isEligible });
  const connect = async (accessToken: string) => {
    provider.mockResolvedValueOnce(credentials(accessToken)).mockResolvedValueOnce(Response.json({ emailAddress: 'owner@example.test' }));
    const state = new URL((await manager.start({ userId: owner, externalUserId: 'external' })).url).searchParams.get('state')!;
    return manager.complete(state, 'code', (await manager.authorization(state, { userId: owner })).browserProof);
  };
  beforeEach(async () => {
    const pg = await KyselyPGlite.create(); db = createPlatformDb({ dialect: pg.dialect }); await db.migrate();
    owner = (await db.createUser({ clerkId: 'user_owner', handle: 'owner', displayName: 'Owner', email: 'owner@example.test', containerId: 'owner', pipedreamExternalId: 'external' })).id;
    now = Date.parse('2026-10-07T10:00:00Z'); provider = vi.fn(); manager = createManager();
  });
  afterEach(async () => db.destroy());

  it.each([
    ['fresh', 'revoke'], ['fresh', 'reconnect'], ['refresh', 'revoke'], ['refresh', 'reconnect'],
  ] as const)('rejects stale %s dispatch when %s settles during final eligibility', async (kind, mutation) => {
    const connected = await connect('original'); const canonical = await db.getConnectedService(connected.connectionId);
    if (kind === 'refresh') { now += 3_700_000; provider.mockResolvedValueOnce(credentials('refreshed-before-race')); }
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const paused = new Promise<void>(resolve => { entered = resolve; });
    let checks = 0;
    const guarded = createManager(async userId => {
      expect(userId).toBe(owner);
      if (++checks === (kind === 'fresh' ? 2 : 3)) { entered(); await held; }
      return true;
    });
    const mailbox = vi.fn<typeof fetch>(async () => Response.json({ emailAddress: 'owner@example.test' }));
    const request = createNativeGmailRequest({ oauth: guarded, fetcher: mailbox });
    const result = request({ externalUserId: 'external', accountId: canonical!.pipedream_account_id,
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile' }, 'GET').then(() => 'dispatched', () => 'rejected');
    await paused;
    try {
      if (mutation === 'revoke') {
        provider.mockResolvedValueOnce(new Response(null, { status: 200 }));
        expect(await manager.revoke({ userId: owner, connectionId: connected.connectionId })).toBe(true);
      } else {
        expect((await connect('replacement')).connectionId).toBe(connected.connectionId);
      }
    } finally { release(); }
    const outcome = await result;
    const stale = kind === 'fresh' ? 'original' : 'refreshed-before-race';
    expect(mailbox.mock.calls.some(call => (call[1] as RequestInit | undefined)?.headers &&
      new Headers((call[1] as RequestInit).headers).get('Authorization') === `Bearer ${stale}`)).toBe(false);
    if (mutation === 'revoke' || kind === 'refresh') { expect(outcome).toBe('rejected'); expect(mailbox).not.toHaveBeenCalled(); }
    else { expect(outcome).toBe('dispatched'); expect(mailbox).toHaveBeenCalledOnce();
      expect(new Headers((mailbox.mock.calls[0][1] as RequestInit).headers).get('Authorization')).toBe('Bearer replacement'); }
  });
});
