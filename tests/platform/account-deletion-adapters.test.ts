import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createAppleRevoker, prepareAppleTokens } from '../../packages/platform/src/account-deletion/apple.js';
import { eraseOwnerStorage, ownerStoragePrefixes } from '../../packages/platform/src/account-deletion/storage.js';
import { createAccountDeletionAdapters } from '../../packages/platform/src/account-deletion/adapters.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';

describe('durable Apple revocation preparation', () => {
  const apple = { teamId:'PX4JL74Y2K',keyId:'ABCDEF1234',serviceId:'web.matrix',nativeClientId:'com.matrixos.mobile',
    privateKey:generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'pem',type:'pkcs8'}).toString() };
  const context = {clerkUserId:'user_owner',appleTokens:[{clientId:'web.matrix',token:'original',tokenType:'access_token' as const}]};
  it('persists a fresh token before revocation and replays it without reading the invalidated Clerk grant', async () => {
    let revoked = false;
    const request = vi.fn(async (url:string|URL|Request) => {
      if(String(url).includes('api.clerk.com')) {
        if(revoked) throw new Error('Clerk grant unavailable after revocation');
        if(String(url).includes('oauth_access_tokens')) return Response.json([{token:'fresh',external_account_id:'e1',expires_at:Date.now()+60_000}]);
        return Response.json({external_accounts:[{id:'e1',provider:'oauth_apple'}],private_metadata:{matrix_apple_token_client_ids:{e1:'web.matrix'}}});
      }
      revoked=true;
      return new Response(null,{status:200});
    });
    const adapters=createAccountDeletionAdapters({db:{} as PlatformDB,clerkSecretKey:'key',r2PrefixRoot:'sync',apple,fetch:request});
    const persisted=await adapters.prepareAppleRevocation!(context);
    expect(persisted).toEqual({...context,appleRevocationPrepared:true,appleTokens:[{clientId:'web.matrix',token:'fresh',tokenType:'access_token'}]});
    await adapters.apple(persisted);
    request.mockClear();
    expect(await adapters.prepareAppleRevocation!(persisted)).toEqual(persisted);
    await adapters.apple(persisted);
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]?.[0])).toBe('https://appleid.apple.com/auth/revoke');
  });
  it('refuses access tokens that were not durably prepared',async()=> {
    const request=vi.fn(async()=>new Response(null,{status:200}));
    const adapters=createAccountDeletionAdapters({db:{} as PlatformDB,clerkSecretKey:'key',r2PrefixRoot:'sync',apple,fetch:request});
    await expect(adapters.apple(context)).rejects.toThrow('Apple revocation preparation required');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('account deletion Apple credentials', () => {
  it('does not guess the Services ID for a native token', () => {
    expect(() => prepareAppleTokens([{ token: 'secret', external_account_id: 'e1' }], {}, {
      serviceId: 'web.matrix', nativeClientId: 'com.matrixos.mobile',
    })).toThrow('Apple credential provenance unavailable');
  });
  it('preserves each exact native/web client and rejects unexpected client IDs', () => {
    const ids = { serviceId: 'web.matrix', nativeClientId: 'com.matrixos.mobile' };
    expect(prepareAppleTokens([{ token: 'native', external_account_id: 'e1' }], { e1: 'com.matrixos.mobile' }, ids))
      .toEqual([{ clientId: 'com.matrixos.mobile', token: 'native', tokenType: 'access_token' }]);
    expect(() => prepareAppleTokens([{ token: 'native', client_id: 'attacker' }], {}, ids)).toThrow();
    expect(() => prepareAppleTokens([], {}, ids)).toThrow('Apple credential unavailable');
  });
  it('signs a client secret and sends a bounded revocation request for the precise client', async () => {
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const request = vi.fn(async () => new Response(null, { status: 200 }));
    await createAppleRevoker({ teamId: 'PX4JL74Y2K', keyId: 'ABCDEF1234', privateKey: key,
      serviceId: 'web.matrix', nativeClientId: 'com.matrixos.mobile' }, request)([
      { clientId: 'com.matrixos.mobile', token: 'refresh', tokenType: 'refresh_token' },
    ]);
    const [url, options] = request.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://appleid.apple.com/auth/revoke');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.redirect).toBe('error');
    const body = new URLSearchParams(String(options.body));
    expect(body.get('client_id')).toBe('com.matrixos.mobile');
    expect(body.get('token_type_hint')).toBe('refresh_token');
    expect(JSON.parse(Buffer.from(body.get('client_secret')!.split('.')[1]!, 'base64url').toString()).sub)
      .toBe('com.matrixos.mobile');
  });
  it('does not swallow authorization/network failures', async () => {
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    await expect(createAppleRevoker({ teamId: 'PX4JL74Y2K', keyId: 'ABCDEF1234', privateKey: key,
      serviceId: 'web.matrix', nativeClientId: 'com.matrixos.mobile' }, async () => new Response(null, { status: 401 }))([
      { clientId: 'web.matrix', token: 'token', tokenType: 'access_token' },
    ])).rejects.toThrow('Apple revocation failed');
  });
});

describe('account deletion object storage', () => {
  it('uses delimited prefixes and never erases another owner', async () => {
    const remove = vi.fn(async () => undefined);
    const store = { listObjects: vi.fn(async () => ({ keys: ['matrixos-sync/user_ab/files/file'], nextCursor: null })),
      deleteObject: remove, abortOwnerMultipartUploads: vi.fn(async () => undefined) };
    await expect(eraseOwnerStorage(store, 'user_a', 'matrixos-sync')).rejects.toThrow('Storage ownership mismatch');
    expect(remove).not.toHaveBeenCalled();
    expect(ownerStoragePrefixes('user_a', 'custom')).toEqual([
      'matrixos-sync/user_a/', 'custom/user_a/', 'matrixos-sync/v2/owners/user_a/runtimes/',
    ]);
  });
  it('restarts listing after bounded batches and waits for multipart abort', async () => {
    const events: string[] = [];
    let calls = 0;
    const store = { listObjects: async () => ({ keys: ++calls === 1 ? ['matrixos-sync/user_a/files/one'] : [], nextCursor: null }),
      deleteObject: async () => { events.push('delete'); }, abortOwnerMultipartUploads: async () => { events.push('abort'); } };
    await eraseOwnerStorage(store, 'user_a', 'matrixos-sync');
    expect(events).toEqual(['abort', 'delete', 'abort']);
    expect(calls).toBe(3);
  });
});

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { verifyAppleTokenClientIds } from '../../packages/platform/src/account-deletion/apple.js';
describe('verified Apple token provenance',()=> {
  it('obtains the exact native audience only after verifying Apple signature and issuer',async()=> {
    const {privateKey,publicKey}=await generateKeyPair('RS256');
    const idToken=await new SignJWT({}).setProtectedHeader({alg:'RS256',kid:'apple-key'}).setIssuer('https://appleid.apple.com')
      .setAudience('com.matrixos.mobile').setSubject('apple-user').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    const request=vi.fn(async (_url:string|URL|Request,init?:RequestInit)=> {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({keys:[{...await exportJWK(publicKey),kid:'apple-key',alg:'RS256',use:'sig'}]});
    });
    const tokens=await verifyAppleTokenClientIds([{token:'access',external_account_id:'e1',id_token:idToken}],{},
      {serviceId:'web.matrix',nativeClientId:'com.matrixos.mobile'},request);
    expect(tokens[0]?.clientId).toBe('com.matrixos.mobile');
    expect(request.mock.calls[0]?.[0]).toBe('https://appleid.apple.com/auth/keys');
  });
  it('rejects ID tokens signed by another key rather than trusting unverified audience',async()=> {
    const {privateKey}=await generateKeyPair('RS256');
    const {publicKey}=await generateKeyPair('RS256');
    const idToken=await new SignJWT({}).setProtectedHeader({alg:'RS256',kid:'apple-key'}).setIssuer('https://appleid.apple.com')
      .setAudience('com.matrixos.mobile').setSubject('apple-user').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    await expect(verifyAppleTokenClientIds([{token:'access',external_account_id:'e1',id_token:idToken}],{},
      {serviceId:'web.matrix',nativeClientId:'com.matrixos.mobile'},async()=>Response.json({keys:[{...await exportJWK(publicKey),kid:'apple-key',alg:'RS256'}]})))
      .rejects.toThrow();
  });
});
import { assertAppleAccessTokensFresh } from '../../packages/platform/src/account-deletion/apple.js';
describe('Apple access token freshness',()=> {
  it('requires a currently valid token instead of accepting an expired token as successful revocation',()=> {
    expect(()=>assertAppleAccessTokensFresh([{token:'old',expires_at:100}],100_000)).toThrow('Apple credential freshness unavailable');
    expect(()=>assertAppleAccessTokensFresh([{token:'unknown'}],100_000)).toThrow('Apple credential freshness unavailable');
    expect(()=>assertAppleAccessTokensFresh([{token:'current',expires_at:200}],100_000)).not.toThrow();
  });
});
