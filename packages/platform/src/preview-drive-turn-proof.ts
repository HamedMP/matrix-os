import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalPreviewDriveTurnBody, CanonicalCreateChatTurnRequestSchema } from '@matrix-os/contracts';
import { z } from 'zod/v4';

export const PREVIEW_DRIVE_TURN_PROOF_HEADER = 'x-matrix-preview-drive-turn-proof';
const TTL_MS = 60_000;
const MAX_BODY_BYTES = 128 * 1024;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PATH = /^\/api\/chats\/([^/]+)\/turns$/;
const Payload = z.strictObject({
  version: z.literal(1),
  handle: z.string().regex(/^pr-[1-9][0-9]{0,8}$/),
  actorId: z.string().min(1).max(256),
  chatId: z.string().regex(REF),
  clientRequestId: z.string().regex(REF),
  bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int(),
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
});
export type PreviewDriveTurnProof = z.infer<typeof Payload>;

function mac(encoded: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(`matrix-preview-drive-turn:v1\0${encoded}`).digest();
}

export function previewDriveTurnBodyDigest(value: unknown): string {
  return createHash('sha256').update(canonicalPreviewDriveTurnBody(value)).digest('hex');
}

/** Only the Platform proxy may mint this after resolving a live browser actor. */
export function mintPreviewDriveTurnProof(input: {
  method: string; path: string; identity: { handle: string; userId: string;
    source?: 'auth' | 'mobile-session' | 'static-route'; verifiedSyncBearer?: boolean };
  body: string; secret: string; now?: number;
}): string | null {
  if (input.method !== 'POST' || !input.secret || input.identity.source !== 'auth'
    || input.identity.verifiedSyncBearer === true || !Payload.shape.handle.safeParse(input.identity.handle).success
    || !input.identity.userId || Buffer.byteLength(input.body) > MAX_BODY_BYTES) return null;
  const match = PATH.exec(input.path);
  if (!match || !REF.test(match[1]!)) return null;
  let body: unknown;
  try { body = JSON.parse(input.body); }
  catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const parsed = CanonicalCreateChatTurnRequestSchema.safeParse(body);
  if (!parsed.success) return null;
  if (!parsed.data.selection.instanceId.startsWith('claude_code_')
    || parsed.data.permissionMode !== 'supervised'
    || parsed.data.interactionMode !== 'default') return null;
  const bodyDigest = previewDriveTurnBodyDigest(parsed.data);
  const now = input.now ?? Date.now();
  const payload: PreviewDriveTurnProof = {
    version: 1, handle: input.identity.handle, actorId: input.identity.userId,
    chatId: match[1]!, clientRequestId: parsed.data.clientRequestId,
    bodyDigest, expiresAt: now + TTL_MS, nonce: randomBytes(16).toString('hex'),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${mac(encoded, input.secret).toString('hex')}`;
}

export function verifyPreviewDriveTurnProof(proof: string | undefined | null, expected: {
  handle: string; actorId?: string; chatId: string; clientRequestId: string;
  bodyDigest: string; secret: string; now?: number;
}): PreviewDriveTurnProof | null {
  if (!proof || proof.length > 2_000 || !expected.secret) return null;
  const match = /^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(proof);
  if (!match) return null;
  const actual = Buffer.from(match[2]!, 'hex');
  if (!timingSafeEqual(actual, mac(match[1]!, expected.secret))) return null;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')); }
  catch (error: unknown) {
    if (error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
  const parsed = Payload.safeParse(value);
  if (!parsed.success) return null;
  const payload = parsed.data;
  const now = expected.now ?? Date.now();
  return payload.expiresAt > now && payload.expiresAt <= now + TTL_MS
    && payload.handle === expected.handle
    && (!expected.actorId || payload.actorId === expected.actorId)
    && payload.chatId === expected.chatId
    && payload.clientRequestId === expected.clientRequestId
    && payload.bodyDigest === expected.bodyDigest ? payload : null;
}
