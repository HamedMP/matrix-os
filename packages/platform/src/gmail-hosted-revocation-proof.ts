import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  GMAIL_HOSTED_GRANT_PROOF_HEADER,
  GMAIL_HOSTED_REVOCATION_PROOF_HEADER,
  GmailHostedRevocationReceiptSchema,
  gmailConsentRevocationAccount,
  isGmailConsentGrant,
  type GmailHostedRevocationReceipt,
} from '@matrix-os/contracts';
import { timingSafeTokenEquals } from './platform-token.js';
import { readRoutineProofProxyBody } from './routine-proof-proxy-body.js';
import type { AppDomainIdentity } from './session-routing-identity.js';
import { isUserSessionProvenance } from './sync-jwt.js';

const PROOF_TTL_MS = 30_000;
type Target = { handle: string; ownerId: string } & ({ accountId: string } | { grantBody: string });

function sign(value: string, target: Target, secret: string): string {
  const scope = 'accountId' in target
    ? { purpose: 'revocation', binding: target.accountId }
    : { purpose: 'grant', binding: createHash('sha256').update(target.grantBody).digest('hex') };
  return createHmac('sha256', secret)
    .update(`matrix-gmail-hosted-${scope.purpose}:v1\0`)
    .update(JSON.stringify([target.handle, target.ownerId, scope.binding, value]))
    .digest('hex');
}

export async function setGmailHostedConsentProof(headers: Headers, input: {
  request: Request;
  path: string;
  forwardedQuery: string;
  target: { handle: string; clerkUserId: string };
  identity: AppDomainIdentity;
  secret: string;
}): Promise<{ status: 400 | 408 | 413 | 503 } | undefined> {
  const { request, path, forwardedQuery, target, identity, secret } = input;
  const accountId = gmailConsentRevocationAccount(request.method, path, '/api/integrations');
  const grant = isGmailConsentGrant(request.method, path, '/api/integrations');
  if ((!accountId && !grant) || !secret || identity.source !== 'auth' || !isUserSessionProvenance(identity.sessionProvenance)
    || identity.userId !== target.clerkUserId || forwardedQuery) return;
  const subject = { handle: target.handle, ownerId: identity.userId };
  let scope: Target;
  if (accountId) {
    scope = { ...subject, accountId };
  } else {
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return { status: 400 };
    const body = await readRoutineProofProxyBody(request, 4096);
    if (typeof body !== 'string') return body ?? { status: 400 };
    scope = { ...subject, grantBody: body };
  }
  const now = Date.now();
  const expiresAt = Math.min(now + PROOF_TTL_MS, (identity.sessionExpiresAt ?? Infinity) * 1000);
  if (expiresAt <= now) return;
  const value = `${expiresAt}.${randomUUID()}`;
  const signature = sign(value, scope, secret);
  const header = grant ? GMAIL_HOSTED_GRANT_PROOF_HEADER : GMAIL_HOSTED_REVOCATION_PROOF_HEADER;
  headers.set(header, `${value}.${signature}`);
}

export function verifyGmailHostedConsentProof(
  proof: string, target: Target, secret: string,
): GmailHostedRevocationReceipt | null {
  if (!secret || proof.length !== 115) return null;
  const match = /^(\d{13})\.([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(proof);
  if (!match) return null;
  const [, expiry, nonce, signature] = match;
  const receipt = GmailHostedRevocationReceiptSchema.safeParse({ nonce, expiresAt: Number(expiry) });
  const now = Date.now();
  if (!receipt.success || receipt.data.expiresAt <= now || receipt.data.expiresAt > now + PROOF_TTL_MS
    || !timingSafeTokenEquals(signature, sign(`${expiry}.${nonce}`, target, secret))) return null;
  return receipt.data;
}
