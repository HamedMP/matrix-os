import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { registerNativeAppleAuthorization, readNativeAppleCredential } from '../../packages/platform/src/account-deletion/native-apple.js';
import { generateKeyPairSync } from 'node:crypto';
const apple={teamId:'PX4JL74Y2K',keyId:'ABCDEF1234',serviceId:'web.matrix',nativeClientId:'com.matrixos.mobile',
  privateKey:generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'pem',type:'pkcs8'}).toString()};
describe('native Apple revocation credential capture',()=> {
  it('verifies subject, exchanges the native code, and encrypts refresh token in merged server-only metadata',async()=> {
    const {privateKey,publicKey}=await generateKeyPair('RS256');
    const jwt=await new SignJWT({}).setProtectedHeader({alg:'RS256',kid:'apple'}).setIssuer('https://appleid.apple.com')
      .setAudience(apple.nativeClientId).setSubject('linked-subject').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    let metadata:Record<string,unknown>={};
    const request=vi.fn(async (url:string|URL|Request,init?:RequestInit)=> {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if(String(url).includes('/auth/token')) {
        expect(new URLSearchParams(String(init?.body)).get('client_id')).toBe(apple.nativeClientId);
        return Response.json({refresh_token:'sensitive-refresh',id_token:jwt});
      }
      if(String(url).includes('/auth/keys')) return Response.json({keys:[{...await exportJWK(publicKey),kid:'apple',alg:'RS256'}]});
      if(init?.method==='PATCH') {metadata=JSON.parse(String(init.body)).private_metadata;return Response.json({});}
      return Response.json({external_accounts:[{provider:'oauth_apple',provider_user_id:'linked-subject'}],private_metadata:{unrelated:'keep'}});
    });
    await registerNativeAppleAuthorization({clerkSecretKey:'clerk',apple,credentialSecret:'s'.repeat(32),fetch:request},'user_owner','native-code');
    expect(JSON.stringify(metadata)).not.toContain('sensitive-refresh');
    expect(Object.keys(metadata)).toEqual(['matrix_native_apple_credential']);
    expect(readNativeAppleCredential(metadata,'user_owner','s'.repeat(32))).toEqual({clientId:apple.nativeClientId,token:'sensitive-refresh',tokenType:'refresh_token'});
    expect(()=>readNativeAppleCredential(metadata,'user_other','s'.repeat(32))).toThrow();
  });
  it('does not attach another Apple identity to the authenticated account',async()=> {
    const {privateKey,publicKey}=await generateKeyPair('RS256');
    const jwt=await new SignJWT({}).setProtectedHeader({alg:'RS256',kid:'apple'}).setIssuer('https://appleid.apple.com')
      .setAudience(apple.nativeClientId).setSubject('someone-else').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    const request=vi.fn(async (url:string|URL|Request)=> {
      if(String(url).includes('/auth/token')) return Response.json({refresh_token:'secret',id_token:jwt});
      if(String(url).includes('/auth/keys')) return Response.json({keys:[{...await exportJWK(publicKey),kid:'apple',alg:'RS256'}]});
      return Response.json({external_accounts:[{provider:'oauth_apple',provider_user_id:'linked-subject'}]});
    });
    await expect(registerNativeAppleAuthorization({clerkSecretKey:'clerk',apple,credentialSecret:'s'.repeat(32),fetch:request},'user_owner','code'))
      .rejects.toThrow('Apple identity mismatch');
    expect(request.mock.calls).toHaveLength(3);
  });
});
