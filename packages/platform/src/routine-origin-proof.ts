import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CanonicalCreateChatTurnRequestSchema, canonicalChatTurnRequestIdentity,
  RoutineOriginDecisionSubmitSchema, RoutineBrowserTupleSchema, RoutineBrowserProofSchema,
  type RoutineBrowserTuple } from '@matrix-os/contracts';
import { hasVerifiedClerkBrowserSession, type ClerkAuth } from './clerk-auth.js';
import type { AppDomainIdentity } from './session-routing-identity.js';
const DOMAIN = 'matrix-routine-browser-purpose:v1\0';
const TTL = 60_000;
const REF = '([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})';
const ORIGIN = new RegExp(`^/api/chats/${REF}/routine-origin/${REF}/resolve$`);
const TURN = new RegExp(`^/api/chats/${REF}/(?:turns|queued-turns)$`);
export const routineBrowserPurposePath = (method: string, path: string) => method === 'POST' && (ORIGIN.test(path) || TURN.test(path));
export const routineOriginBodyDigest = (input: object) => createHash('sha256').update(JSON.stringify(RoutineOriginDecisionSubmitSchema.parse(input))).digest('hex');
export function routineBrowserTuple(input: { method: string; path: string; body: string;
  handle: string; runtimeSlot: string; machineId: string; ownerId: string }): RoutineBrowserTuple | null {
  if (!routineBrowserPurposePath(input.method, input.path)) return null;
  let raw: unknown;
  try { raw = JSON.parse(input.body); } catch (error: unknown) { if (error instanceof SyntaxError) return null; throw error; }
  const common = { handle: input.handle, runtimeSlot: input.runtimeSlot, machineId: input.machineId, ownerId: input.ownerId, method: input.method, path: input.path };
  const origin = ORIGIN.exec(input.path);
  if (origin) {
    const body = RoutineOriginDecisionSubmitSchema.safeParse(raw);
    const parsed = body.success && RoutineBrowserTupleSchema.safeParse({ ...common, ...body.data,
      purpose: 'routine_origin_approval', sourceChatId: origin[1], interactionId: origin[2], bodyDigest: routineOriginBodyDigest(body.data) });
    return parsed && parsed.success ? parsed.data : null;
  }
  const body = CanonicalCreateChatTurnRequestSchema.safeParse(raw), turn = TURN.exec(input.path);
  if (!body.success || body.data.routineCreation !== 'matrix' || !turn) return null;
  const parsed = RoutineBrowserTupleSchema.safeParse({ ...common, purpose: 'routine_creation_route', sourceChatId: turn[1],
    routineCreation: 'matrix', clientRequestId: body.data.clientRequestId, baseRevision: body.data.baseRevision,
    bodyDigest: createHash('sha256').update(canonicalChatTurnRequestIdentity(body.data)).digest('hex') });
  return parsed.success ? parsed.data : null;
}
/** Reuses the shipped Clerk verifier, requiring the actual current session ID for these purposes.
 * A generic owner JWT or a signed browser routing label alone cannot supply that ID. */
export async function routineBrowserSession(input: { request: Request; identity: AppDomainIdentity; clerkAuth?: ClerkAuth; now?: number }) {
  if (input.identity.source !== 'auth' || !input.clerkAuth) return null;
  const now = input.now ?? Date.now(), clerk = input.clerkAuth;
  const tokens = [clerk.extractToken(input.request.headers.get('authorization') ?? undefined, undefined), clerk.extractToken(undefined, input.request.headers.get('cookie') ?? undefined)];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([(async () => {
      for (const token of tokens.filter((v, i, all): v is string => !!v && all.indexOf(v) === i)) {
        const result = await clerk.verify(token);
        const expiresAt = Math.min(now + TTL, result.tokenExpiresAt === undefined ? now : result.tokenExpiresAt * 1000);
        if (hasVerifiedClerkBrowserSession(result, input.identity.userId, Math.floor(now / 1000)) && expiresAt > now)
          return { sessionId: result.sessionId, expiresAt };
      }
      return null;
    })(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5000); timer.unref?.(); })]);
  } finally { clearTimeout(timer); }
}
export function mintRoutineBrowserProof(input: { tuple: RoutineBrowserTuple; secret: string;
  session: { sessionId: string; expiresAt: number }; now?: number }) {
  const now = input.now ?? Date.now();
  const parsed = RoutineBrowserProofSchema.safeParse({ ...input.tuple, version: 1, sessionId: input.session.sessionId,
    issuedAt: now, expiresAt: Math.min(now + TTL, input.session.expiresAt), nonce: randomBytes(16).toString('hex') });
  if (!input.secret || !parsed.success || parsed.data.expiresAt <= now) return null;
  const encoded = Buffer.from(JSON.stringify(parsed.data)).toString('base64url');
  return `${encoded}.${createHmac('sha256', input.secret).update(DOMAIN + encoded).digest('hex')}`;
}
export function verifyRoutineBrowserProof(proof: string | undefined, expected: RoutineBrowserTuple, secret: string, now = Date.now()) {
  if (!secret || !proof || proof.length > 6000) return null;
  const match = /^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(proof);
  if (!match || !timingSafeEqual(Buffer.from(match[2]!, 'hex'), createHmac('sha256', secret).update(DOMAIN + match[1]).digest())) return null;
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')); }
  catch (error: unknown) { if (error instanceof SyntaxError) return null; throw error; }
  const parsed = RoutineBrowserProofSchema.safeParse(raw), tuple = RoutineBrowserTupleSchema.safeParse(expected);
  if (!tuple.success || !parsed.success || parsed.data.issuedAt > now || parsed.data.expiresAt <= now
    || parsed.data.expiresAt > parsed.data.issuedAt + TTL || parsed.data.expiresAt > now + TTL) return null;
  return Object.entries(tuple.data).every(([key, field]) => parsed.data[key as keyof typeof parsed.data] === field) ? parsed.data : null;
}
