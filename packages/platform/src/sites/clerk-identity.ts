import { z } from 'zod/v4';
import { hasVerifiedClerkBrowserSession, type VerifyResult } from '../clerk-auth.js';
import { SiteError } from './types.js';

const CLERK_USER_RESPONSE_MAX_BYTES = 1024 * 1024;
const CLERK_USER_TIMEOUT_MS = 10_000;
const ClerkUserIdSchema = z.string().regex(/^user_[A-Za-z0-9_-]{1,200}$/);
const ClerkSessionIdSchema = z.string().regex(/^sess_[A-Za-z0-9_-]{1,200}$/);
const ClerkUserSchema = z.object({
  id: ClerkUserIdSchema,
  banned: z.boolean(), locked: z.boolean(), deprovisioned: z.boolean(),
  email_addresses: z.array(z.object({
    email_address: z.email().max(254),
    verification: z.object({ status: z.string().min(1).max(32) }).nullable(),
  })).max(100),
});

export interface SiteClerkIdentity {
  clerkUserId: string;
  clerkSessionId: string;
  verifiedEmails: string[];
}
export interface SiteClerkIdentityDeps {
  secretKey: string;
  verify: (token: string) => Promise<VerifyResult>;
  fetchImpl?: typeof fetch;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new SiteError('unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > CLERK_USER_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new SiteError('unavailable');
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw new SiteError('unavailable');
    throw error;
  }
}

/** Resolve identity from the existing Clerk instance before opening any DB transaction. */
export async function resolveSiteClerkIdentity(
  authorization: string | undefined, deps: SiteClerkIdentityDeps,
): Promise<SiteClerkIdentity> {
  if (!authorization || authorization.length > 8192 || !/^Bearer [A-Za-z0-9._-]{1,8185}$/.test(authorization))
    throw new SiteError('not_found');
  if (!deps.secretKey || !deps.secretKey.startsWith('sk_')) throw new SiteError('unavailable');
  const token = authorization.slice(7);
  let verification: VerifyResult;
  try { verification = await deps.verify(token); }
  catch (error) {
    console.warn('[sites] Clerk token verification unavailable', error instanceof Error ? error.name : 'UnknownError');
    throw new SiteError('unavailable');
  }
  const userId = verification.userId;
  if (!userId || !ClerkUserIdSchema.safeParse(userId).success
    || !hasVerifiedClerkBrowserSession(verification, userId)
    || !ClerkSessionIdSchema.safeParse(verification.sessionId).success) throw new SiteError('not_found');
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${deps.secretKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(CLERK_USER_TIMEOUT_MS), redirect: 'error', cache: 'no-store',
    });
  } catch (error) {
    console.warn('[sites] Clerk user lookup unavailable', error instanceof Error ? error.name : 'UnknownError');
    throw new SiteError('unavailable');
  }
  if (response.status === 404) throw new SiteError('not_found');
  if (!response.ok) throw new SiteError('unavailable');
  let raw: unknown;
  try { raw = await readBoundedJson(response); }
  catch (error) {
    if (error instanceof SiteError) throw error;
    console.warn('[sites] Clerk user response unavailable', error instanceof Error ? error.name : 'UnknownError');
    throw new SiteError('unavailable');
  }
  const parsed = ClerkUserSchema.safeParse(raw);
  if (!parsed.success) throw new SiteError('unavailable');
  const user = parsed.data;
  if (user.id !== userId || user.banned || user.locked || user.deprovisioned) throw new SiteError('not_found');
  const verifiedEmails = [...new Set(user.email_addresses
    .filter(address => address.verification?.status === 'verified')
    .map(address => address.email_address.trim().toLowerCase()))];
  if (!verifiedEmails.length) throw new SiteError('not_found');
  return { clerkUserId: userId, clerkSessionId: verification.sessionId, verifiedEmails };
}
