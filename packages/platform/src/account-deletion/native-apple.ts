import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, customFetch, importPKCS8, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod/v4';
import type { AppleDeletionConfig } from './apple.js';
import type { AppleDeletionToken } from './types.js';

const credentialSchema=z.object({clientId:z.string().min(1).max(256),token:z.string().min(1).max(16384),tokenType:z.literal('refresh_token')}).strict();
export interface NativeAppleAuthorizationOptions {
  clerkSecretKey:string;
  credentialSecret:string;
  apple:AppleDeletionConfig;
  fetch?:typeof fetch;
}
function credentialKey(secret:string) {
  if(secret.length<32)throw new Error('Apple credential encryption unavailable');
  return createHash('sha256').update('matrix-native-apple\0').update(secret).digest();
}
function encryptCredential(credential:AppleDeletionToken,owner:string,secret:string):string {
  const iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',credentialKey(secret),iv);
  cipher.setAAD(Buffer.from(owner));
  const body=Buffer.concat([cipher.update(JSON.stringify(credential),'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');
}
/** A user-bound encrypted credential is readable only with the deployment's credential secret. */
export function readNativeAppleCredential(metadata:Record<string,unknown>,owner:string,secret:string):AppleDeletionToken|null {
  const raw=metadata.matrix_native_apple_credential;
  if(raw===undefined || raw===null)return null;
  const bytes=Buffer.from(z.string().min(40).max(32768).regex(/^[A-Za-z0-9_-]+$/).parse(raw),'base64url');
  const cipher=createDecipheriv('aes-256-gcm',credentialKey(secret),bytes.subarray(0,12));
  cipher.setAAD(Buffer.from(owner));
  cipher.setAuthTag(bytes.subarray(12,28));
  const plain=Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString();
  return credentialSchema.parse(JSON.parse(plain));
}

/** Caller must hold owner deletion admission until this completes, including metadata persistence. */
export async function registerNativeAppleAuthorization(options:NativeAppleAuthorizationOptions,owner:string,code:string):Promise<void> {
  z.string().regex(/^user_[A-Za-z0-9_-]{1,150}$/).parse(owner);
  z.string().min(1).max(4096).parse(code);
  const config=options.apple;
  z.string().regex(/^[A-Z0-9]{10}$/).parse(config.teamId);
  z.string().regex(/^[A-Z0-9]{10}$/).parse(config.keyId);
  credentialKey(options.credentialSecret);
  const request=options.fetch??fetch;
  const userResponse=await request(`https://api.clerk.com/v1/users/${encodeURIComponent(owner)}`,{
    signal:AbortSignal.timeout(10_000),redirect:'error',headers:{Authorization:`Bearer ${options.clerkSecretKey}`},
  });
  if(!userResponse.ok)throw new Error('Apple authorization unavailable');
  const user=z.object({external_accounts:z.array(z.object({provider:z.string(),provider_user_id:z.string()})).max(100)})
    .parse(await userResponse.json());
  const appleAccounts=user.external_accounts.filter((account)=>['oauth_apple','apple'].includes(account.provider));
  if(!appleAccounts.length)throw new Error('Apple identity mismatch');
  const privateKey=await importPKCS8(config.privateKey,'ES256');
  const secret=await new SignJWT({}).setProtectedHeader({alg:'ES256',kid:config.keyId}).setIssuer(config.teamId)
    .setSubject(config.nativeClientId).setAudience('https://appleid.apple.com').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const response=await request('https://appleid.apple.com/auth/token',{
    method:'POST',signal:AbortSignal.timeout(10_000),redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:config.nativeClientId,client_secret:secret,code,grant_type:'authorization_code'}),
  });
  if(!response.ok)throw new Error('Apple authorization exchange failed');
  const tokens=z.object({refresh_token:z.string().min(1).max(16384),id_token:z.string().min(1).max(16384)}).parse(await response.json());
  const keys=createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'),{
    timeoutDuration:10_000,[customFetch]:(url,init)=>request(url,{...init,redirect:'error',signal:AbortSignal.timeout(10_000)}),
  });
  const identity=await jwtVerify(tokens.id_token,keys,{issuer:'https://appleid.apple.com',audience:config.nativeClientId,algorithms:['RS256']});
  if(!identity.payload.sub || !appleAccounts.some((account)=>account.provider_user_id===identity.payload.sub)) {
    throw new Error('Apple identity mismatch');
  }
  const encrypted=encryptCredential({clientId:config.nativeClientId,token:tokens.refresh_token,tokenType:'refresh_token'},owner,options.credentialSecret);
  // Clerk's metadata PATCH merges this field, preserving unrelated private metadata.
  const saved=await request(`https://api.clerk.com/v1/users/${encodeURIComponent(owner)}/metadata`,{
    method:'PATCH',signal:AbortSignal.timeout(10_000),redirect:'error',headers:{Authorization:`Bearer ${options.clerkSecretKey}`,'Content-Type':'application/json'},
    body:JSON.stringify({private_metadata:{matrix_native_apple_credential:encrypted}}),
  });
  if(!saved.ok)throw new Error('Apple credential storage unavailable');
  await saved.body?.cancel();
}
