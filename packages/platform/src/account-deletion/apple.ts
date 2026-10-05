import { importPKCS8, SignJWT, createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { z } from 'zod/v4';
import type { AppleDeletionToken } from './types.js';

export interface AppleDeletionConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
  serviceId: string;
  nativeClientId: string;
}
const tokenSchema = z.object({
  token: z.string().min(1).max(16384),
  external_account_id: z.string().max(256).optional(),
  client_id: z.string().min(1).max(256).optional(),
  id_token: z.string().max(16384).optional(),
  expires_at: z.number().int().positive().optional(),
});
/** Tokens are opaque. Never infer native/web client ID from the user's email or platform. */
export function prepareAppleTokens(raw: unknown, provenance: unknown,
  config: Pick<AppleDeletionConfig, 'serviceId' | 'nativeClientId'>): AppleDeletionToken[] {
  const tokens = z.array(tokenSchema).max(20).parse(raw);
  if (!tokens.length) throw new Error('Apple credential unavailable');
  const clientIds = z.record(z.string().max(256), z.string().max(256)).parse(provenance);
  return tokens.map((token) => {
    const clientId = token.client_id ?? (token.external_account_id ? clientIds[token.external_account_id] : undefined);
    if (!clientId || ![config.serviceId, config.nativeClientId].includes(clientId)) {
      throw new Error('Apple credential provenance unavailable');
    }
    return { clientId, token: token.token, tokenType: 'access_token' };
  });
}
export function assertAppleAccessTokensFresh(raw: unknown, nowMs = Date.now()): void {
  const tokens = z.array(tokenSchema).max(20).parse(raw);
  if (!tokens.length || tokens.some((token)=>!token.expires_at ||
    (token.expires_at > 1_000_000_000_000 ? token.expires_at : token.expires_at*1000) <= nowMs+10_000)) {
    throw new Error('Apple credential freshness unavailable');
  }
}

/** The Apple-signed audience binds an opaque OAuth token to its exact native or web client. */
export async function verifyAppleTokenClientIds(raw: unknown, provenance: unknown,
  config: Pick<AppleDeletionConfig, 'serviceId' | 'nativeClientId'>, request: typeof fetch = fetch): Promise<AppleDeletionToken[]> {
  const tokens = z.array(tokenSchema).max(20).parse(raw);
  const keys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'), {
    timeoutDuration: 10_000,
    [customFetch]: (url, init) => request(url, { ...init, redirect:'error', signal:AbortSignal.timeout(10_000) }),
  });
  for (const token of tokens) {
    if (!token.id_token) continue;
    const verified = await jwtVerify(token.id_token, keys, { algorithms:['RS256'], issuer:'https://appleid.apple.com',
      audience:[config.serviceId,config.nativeClientId] });
    if (typeof verified.payload.aud !== 'string') throw new Error('Apple credential provenance unavailable');
    if (token.client_id && token.client_id !== verified.payload.aud) throw new Error('Apple credential provenance mismatch');
    token.client_id = verified.payload.aud;
  }
  return prepareAppleTokens(tokens,provenance,config);
}

export function createAppleRevoker(config: AppleDeletionConfig, request: typeof fetch = fetch) {
  return async (tokens: AppleDeletionToken[]): Promise<void> => {
    if (!tokens.length) return;
    z.string().regex(/^[A-Z0-9]{10}$/).parse(config.teamId);
    z.string().regex(/^[A-Z0-9]{10}$/).parse(config.keyId);
    const privateKey = await importPKCS8(config.privateKey, 'ES256');
    for (const token of tokens) {
      if (![config.serviceId, config.nativeClientId].includes(token.clientId)) throw new Error('Apple credential provenance unavailable');
      const secret = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: config.keyId })
        .setIssuer(config.teamId).setSubject(token.clientId).setAudience('https://appleid.apple.com')
        .setIssuedAt().setExpirationTime('5m').sign(privateKey);
      const response = await request('https://appleid.apple.com/auth/revoke', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: token.clientId, client_secret: secret,
          token: token.token, token_type_hint: token.tokenType }),
      });
      // Apple's success is idempotent, including an already revoked token.
      if (!response.ok) throw new Error('Apple revocation failed');
      await response.body?.cancel();
    }
  };
}
