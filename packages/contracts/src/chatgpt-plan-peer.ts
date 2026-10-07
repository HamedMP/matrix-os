import { z } from 'zod/v4';
// Raw SSE bytes and its worst-case JSON encoding (control characters expand 6x).
export const CHATGPT_PLAN_RESPONSE_BYTE_LIMIT = 1024 * 1024;
export const CHATGPT_PLAN_PEER_REPLY_BYTE_LIMIT = 6 * CHATGPT_PLAN_RESPONSE_BYTE_LIMIT + 1024;
export const CHATGPT_PLAN_PEER_REQUEST_LIFETIME_MS = 120000;
// Bound small device/host clock skew; the Gateway still expires pending work at 120s.
export const CHATGPT_PLAN_PEER_CLOCK_SKEW_MS = 5000;
export const CHATGPT_PLAN_PEER_MAX_SEQUENCE = 0xffffffffffff;
/** Ordered request identity keeps replay state constant-size without forgetting IDs.
 * Preserve the session UUID version/variant; its 80-bit prefix scopes the counter. */
export function chatGptPlanPeerRequestId(sessionId: string, sequence: number): string {
    if (!z.uuid().safeParse(sessionId).success || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > CHATGPT_PLAN_PEER_MAX_SEQUENCE)
        throw new Error('invalid peer sequence');
    return `${sessionId.slice(0, 24)}${sequence.toString(16).padStart(12, '0')}`;
}
const reference = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).refine(v => !v.includes('..'));
export const ChatGptPlanPeerModelSchema = z.object({ id: reference, displayName: z.string().min(1).max(160),
    input: z.array(z.enum(['text', 'image'])).min(1).max(2).refine(input => input.includes('text') && new Set(input).size === input.length), contextWindow: z.number().int().min(1024).max(2000000), maxOutputTokens: z.number().int().min(16).max(128000) }).strict();
export const ChatGptPlanPeerSnapshotSchema = z.object({ deviceId: z.string().regex(/^[a-f0-9]{64}$/), accountId: reference.nullable(),
    grantRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), enabled: z.boolean(), background: z.boolean(),
    models: z.array(ChatGptPlanPeerModelSchema).max(64),
}).strict().refine(v => (!v.background || v.enabled) && (!v.enabled || v.accountId !== null && v.grantRevision > 0 && v.models.length > 0)
    && (v.accountId !== null || v.models.length === 0) && new Set(v.models.map(m => m.id)).size === v.models.length);
export const ChatGptPlanPeerChallengeSchema = z.object({ version: z.literal(1), challenge: z.string().regex(/^[a-f0-9]{64}$/),
    ownerId: reference, computerId: reference, expiresAt: z.string().datetime() }).strict();
export const ChatGptPlanPeerConnectSchema = z.object({ version: z.literal(1), challenge: z.string().regex(/^[a-f0-9]{64}$/),
    publicKey: z.string().min(32).max(1024).regex(/^[A-Za-z0-9_-]+$/), signature: z.string().min(64).max(128).regex(/^[A-Za-z0-9_-]+$/), snapshot: ChatGptPlanPeerSnapshotSchema }).strict();
export const ChatGptPlanPeerSessionSchema = z.object({ version: z.literal(1), sessionId: z.uuid() }).strict();
export const ChatGptPlanPeerRequestSchema = z.discriminatedUnion('action', [
    z.object({ version: z.literal(1), action: z.literal('infer'), id: z.uuid(), sequence: z.number().int().min(1).max(CHATGPT_PLAN_PEER_MAX_SEQUENCE), expiresAt: z.string().datetime(), accountId: reference, grantRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        computerId: reference, requestClass: z.enum(['interactive', 'background']), runId: reference, model: reference, body: z.string().max(512000) }).strict(),
    z.object({ version: z.literal(1), action: z.literal('cancel'), id: z.uuid() }).strict(),
]);
export const ChatGptPlanPeerReplySchema = z.discriminatedUnion('ok', [
    ChatGptPlanPeerSessionSchema.extend({ id: z.uuid(), ok: z.literal(true), status: z.literal(200),
        headers: z.object({ 'content-type': z.literal('text/event-stream') }).strict(), body: z.string().max(CHATGPT_PLAN_RESPONSE_BYTE_LIMIT).refine(value => new TextEncoder().encode(value).byteLength <= CHATGPT_PLAN_RESPONSE_BYTE_LIMIT) }).strict(),
    ChatGptPlanPeerSessionSchema.extend({ id: z.uuid(), ok: z.literal(false), error: z.enum(['unavailable', 'cancelled']) }).strict(),
]);
export type ChatGptPlanPeerSnapshot = z.infer<typeof ChatGptPlanPeerSnapshotSchema>;
export type ChatGptPlanPeerRequest = z.infer<typeof ChatGptPlanPeerRequestSchema>;
export type ChatGptPlanPeerReply = z.infer<typeof ChatGptPlanPeerReplySchema>;
/** Stable signed bytes: both endpoints construct this shape rather than stringify
 * arbitrary incoming objects; bearer ownership is independently verified. */
export function chatGptPlanPeerProof(input: {
    challenge: string;
    ownerId: string;
    computerId: string;
    snapshot: ChatGptPlanPeerSnapshot;
}): string {
    return JSON.stringify({ version: 1, challenge: input.challenge, ownerId: input.ownerId, computerId: input.computerId, snapshot: input.snapshot });
}
export const ChatGptPlanPeerPollSchema = z.object({
    version: z.literal(1), requests: z.array(ChatGptPlanPeerRequestSchema).max(32),
}).strict();
