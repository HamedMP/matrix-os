import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod/v4';

export const GOOGLE_PROCESSING_HEADER = 'x-matrix-google-processing';
const MAX_HEADER_BYTES = 4096;
const LIFETIME_MS = 30_000;
const Reference = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Claim = z.strictObject({
  ownerId: Reference, runId: Reference, runtimeHandle: z.string().regex(/^runtime_[a-f0-9]{32}$/),
  executionGeneration: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  profileId: z.uuid(), profileRevision: Revision, consentId: z.uuid(), consentRevision: Revision,
  googleAccountId: Reference, purposeId: Reference, routeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policyExpiresAt: z.iso.datetime(),
});
const Envelope = Claim.extend({ version: z.literal(1), requestId: z.uuid(),
  method: z.literal('POST'), path: z.enum(['/call', '/read-call']), bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type GoogleProcessingClaim = z.infer<typeof Claim>;
export type GoogleProcessingEnvelope = z.infer<typeof Envelope>;
type RequestBinding = { method: string; path: string; body: string; machineToken: string; now?: number };
export class GoogleProcessingEnvelopeError extends Error {
  constructor() { super('Google data request unavailable'); this.name = 'GoogleProcessingEnvelopeError'; }
}
function digest(body: string) { return createHash('sha256').update(body).digest('hex'); }
function signature(encoded: string, key: string) { return createHmac('sha256', key).update(`matrix-google-processing:v1:${encoded}`).digest(); }
function validKey(key: string) { return key.length >= 16 && key.length <= 4096; }
function validTime(at: number) { return Number.isSafeInteger(at) && at >= 0; }

/** Trusted server composition only. A signature authenticates the machine's
 * claim, not provider eligibility. Receiver must revalidate the durable policy
 * and consume requestId once before dispatch. Never return this to a model. */
export function signGoogleProcessingEnvelope(input: GoogleProcessingClaim, request: RequestBinding): string {
  const now = request.now ?? Date.now();
  const parsed = Claim.safeParse(input);
  if (!parsed.success || !validKey(request.machineToken) || !validTime(now) || Buffer.byteLength(request.body) > 65536) throw new GoogleProcessingEnvelopeError();
  const expiresAt = Math.min(now + LIFETIME_MS, Date.parse(parsed.data.policyExpiresAt));
  const envelope = Envelope.safeParse({ ...parsed.data, version: 1, requestId: randomUUID(),
    method: request.method, path: request.path, bodyDigest: digest(request.body), issuedAt: now, expiresAt });
  if (!envelope.success || expiresAt <= now) throw new GoogleProcessingEnvelopeError();
  const encoded = Buffer.from(JSON.stringify(envelope.data)).toString('base64url');
  const token = `${encoded}.${signature(encoded, request.machineToken).toString('base64url')}`;
  if (token.length > MAX_HEADER_BYTES) throw new GoogleProcessingEnvelopeError();
  return token;
}

/** Call only after machine/owner authentication. This verifies request binding;
 * it does not establish a live run, consume replay state or approve processing. */
export function verifyGoogleProcessingEnvelope(token: string, request: RequestBinding & { ownerId: string }): GoogleProcessingEnvelope {
  const now = request.now ?? Date.now();
  if (!validKey(request.machineToken) || !validTime(now) || token.length > MAX_HEADER_BYTES
    || Buffer.byteLength(request.body) > 65536 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new GoogleProcessingEnvelopeError();
  const [encoded, proof] = token.split('.') as [string, string];
  const actual = Buffer.from(proof, 'base64url');
  const expected = signature(encoded, request.machineToken);
  if (actual.length !== expected.length || actual.toString('base64url') !== proof || !timingSafeEqual(actual, expected)) throw new GoogleProcessingEnvelopeError();
  let body: unknown;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new GoogleProcessingEnvelopeError();
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error: unknown) {
    if (error instanceof SyntaxError || error instanceof TypeError || error instanceof GoogleProcessingEnvelopeError) throw new GoogleProcessingEnvelopeError();
    throw error;
  }
  const parsed = Envelope.safeParse(body);
  if (!parsed.success) throw new GoogleProcessingEnvelopeError();
  const value = parsed.data;
  if (value.ownerId !== request.ownerId || value.method !== request.method || value.path !== request.path
    || value.bodyDigest !== digest(request.body) || value.issuedAt > now + 5000 || value.expiresAt <= now
    || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > LIFETIME_MS
    || value.expiresAt > Date.parse(value.policyExpiresAt)) throw new GoogleProcessingEnvelopeError();
  return value;
}
