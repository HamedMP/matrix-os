import { importPKCS8, SignJWT, createRemoteJWKSet, customFetch, jwtVerify, errors } from 'jose';
import { z } from 'zod/v4';
import type { AppleDeletionToken } from './types.js';

export interface AppleDeletionConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
  serviceId: string;
  nativeClientId: string;
}
/** Configuration failures remain distinct from unavailable user credentials. */
export async function assertAppleDeletionConfig(config: AppleDeletionConfig): Promise<void> {
  const client = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/);
  z.object({ teamId: z.string().regex(/^[A-Z0-9]{10}$/), keyId: z.string().regex(/^[A-Z0-9]{10}$/),
    privateKey: z.string().min(1).max(16384), serviceId: client, nativeClientId: client }).parse(config);
  await importPKCS8(config.privateKey, 'ES256');
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

function appleKeys(request: typeof fetch) {
  return createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'), {
    timeoutDuration: 10_000,
    [customFetch]: (url, init) => request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) }),
  });
}
async function verifyTokenClientId(token: z.infer<typeof tokenSchema>,
  config: Pick<AppleDeletionConfig, 'serviceId' | 'nativeClientId'>,
  keys: ReturnType<typeof createRemoteJWKSet>): Promise<void> {
  if (!token.id_token) return;
  const verified = await jwtVerify(token.id_token, keys, { algorithms: ['RS256'], issuer: 'https://appleid.apple.com',
    audience: [config.serviceId, config.nativeClientId] });
  if (typeof verified.payload.aud !== 'string') throw new Error('Apple credential provenance unavailable');
  if (token.client_id && token.client_id !== verified.payload.aud) throw new Error('Apple credential provenance mismatch');
  token.client_id = verified.payload.aud;
}
/** The Apple-signed audience binds an opaque OAuth token to its exact native or web client. */
export async function verifyAppleTokenClientIds(raw: unknown, provenance: unknown,
  config: Pick<AppleDeletionConfig, 'serviceId' | 'nativeClientId'>, request: typeof fetch = fetch): Promise<AppleDeletionToken[]> {
  const tokens = z.array(tokenSchema).max(20).parse(raw);
  const keys = appleKeys(request);
  for (const token of tokens) await verifyTokenClientId(token, config, keys);
  return prepareAppleTokens(tokens, provenance, config);
}

export interface ClerkAppleRevocationPreparation {
  tokens: AppleDeletionToken[];
  manualRevocationRequired: boolean;
}

/**
 * Clerk's documented OAuth response makes id_token and expires_at optional. An
 * opaque token cannot prove its client or remaining lifetime. Apple TN3194
 * requires deletion to continue in this case, with explicit manual-revocation
 * instructions, rather than guessing a client or retaining the account forever.
 * https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple
 */
export async function prepareClerkAppleRevocation(raw: unknown, provenance: unknown,
  config: Pick<AppleDeletionConfig, 'serviceId' | 'nativeClientId'>, request: typeof fetch = fetch,
  nowMs = Date.now()): Promise<ClerkAppleRevocationPreparation> {
  const clientSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/);
  z.object({ serviceId: clientSchema, nativeClientId: clientSchema }).parse(config);
  const tokens = z.array(tokenSchema).max(20).parse(raw);
  const clientIds = z.record(z.string().max(256), z.string().max(256))
    .refine((value) => Object.keys(value).length <= 100).parse(provenance);
  const result: ClerkAppleRevocationPreparation = { tokens: [], manualRevocationRequired: !tokens.length };
  const keys = appleKeys(request);
  for (const token of tokens) {
    const recordedClient = token.external_account_id ? clientIds[token.external_account_id] : undefined;
    if (!token.id_token && !recordedClient) {
      // client_id is not part of Clerk's documented response and is not proof.
      result.manualRevocationRequired = true;
      continue;
    }
    let verified: AppleDeletionToken[];
    try {
      const candidate = { ...token, client_id: undefined as string | undefined };
      await verifyTokenClientId(candidate, config, keys);
      verified = prepareAppleTokens([candidate], clientIds, config);
    } catch (error) {
      // jose verifies the signature before checking expiration. No operational,
      // signature, issuer, audience, or metadata errors are downgraded to absence.
      if (!(error instanceof errors.JWTExpired)) throw error;
      result.manualRevocationRequired = true;
      continue;
    }
    const expiresMs = token.expires_at === undefined ? undefined
      : token.expires_at > 1_000_000_000_000 ? token.expires_at : token.expires_at * 1000;
    if (expiresMs === undefined || expiresMs <= nowMs + 10_000) {
      result.manualRevocationRequired = true;
      continue;
    }
    result.tokens.push(...verified);
  }
  return result;
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
