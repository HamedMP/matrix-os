import { createHmac, randomUUID } from 'node:crypto';
import {
  GMAIL_HOSTED_REVOCATION_PROOF_HEADER,
  GmailHostedRevocationReceiptSchema,
  gmailConsentRevocationAccount,
  type GmailHostedRevocationReceipt,
} from '@matrix-os/contracts';
import { timingSafeTokenEquals } from './platform-token.js';
import type { AppDomainIdentity } from './session-routing-identity.js';
import { isUserSessionProvenance } from './sync-jwt.js';

const PROOF_TTL_MS = 30_000;
type Target = { handle: string; ownerId: string; accountId: string };

function sign(value: string, target: Target, secret: string): string {
  return createHmac('sha256', secret)
    .update('matrix-gmail-hosted-revocation:v1\0')
    .update(JSON.stringify([target.handle, target.ownerId, target.accountId, value]))
    .digest('hex');
}

export function setGmailHostedRevocationProof(headers: Headers, input: {
  request: Request;
  path: string;
  target: { handle: string; clerkUserId: string };
  identity: AppDomainIdentity;
  secret: string;
}): void {
  const { request, path, target, identity, secret } = input;
  const accountId = gmailConsentRevocationAccount(request.method, path, '/api/integrations');
  if (!accountId || !secret || identity.source !== 'auth' || !isUserSessionProvenance(identity.sessionProvenance)
    || identity.userId !== target.clerkUserId || new URL(request.url).search) return;
  const now = Date.now();
  const expiresAt = Math.min(now + PROOF_TTL_MS, (identity.sessionExpiresAt ?? Infinity) * 1000);
  if (expiresAt <= now) return;
  const value = `${expiresAt}.${randomUUID()}`;
  const signature = sign(value, { handle: target.handle, ownerId: identity.userId, accountId }, secret);
  headers.set(GMAIL_HOSTED_REVOCATION_PROOF_HEADER, `${value}.${signature}`);
}

export function verifyGmailHostedRevocationProof(
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
