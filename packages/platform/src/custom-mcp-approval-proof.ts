import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { CanonicalSubmitChatApprovalRequestSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";

export const CUSTOM_MCP_APPROVAL_PROOF_HEADER = "x-matrix-custom-mcp-approval-proof";
const MAX_BODY_BYTES = 4_000;
const TTL_MS = 60_000;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PATH = /^\/api\/chats\/([^/]+)\/runs\/([^/]+)\/approvals\/([^/]+)$/;
export function isCustomMcpApprovalSubmitPath(method: string, path: string): boolean {
  return method === "POST" && PATH.test(path);
}
const Payload = z.object({
  version: z.literal(1), handle: z.string().min(1).max(63), actorId: z.string().min(1).max(256),
  chatId: z.string().regex(REF), runId: z.string().regex(REF), approvalId: z.string().regex(REF),
  decision: z.enum(["approve", "decline", "cancel"]), clientRequestId: z.string().regex(REF),
  bodyDigest: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int(),
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
}).strict();
type Payload = z.infer<typeof Payload>;

function bodyDigest(input: { clientRequestId: string; decision: string }): string {
  return createHash("sha256")
    .update(`matrix-custom-mcp-approval-body:v1\0${JSON.stringify([input.clientRequestId, input.decision])}`)
    .digest("hex");
}

function signature(encoded: string, secret: string): string {
  return createHmac("sha256", secret).update(`matrix-custom-mcp-user-decision:v1\0${encoded}`).digest("hex");
}

export function mintCustomMcpApprovalProof(input: {
  method: string; path: string;
  identity: { handle: string; userId: string; source?: "auth" | "mobile-session" | "static-route" };
  body: string; secret: string; now?: number;
}): string | null {
  if (input.method !== "POST" || !input.secret || !input.identity.userId
    || !input.identity.handle || input.identity.source !== "auth"
    || Buffer.byteLength(input.body) > MAX_BODY_BYTES) return null;
  const match = PATH.exec(input.path);
  if (!match || !match.slice(1).every(value => REF.test(value!))) return null;
  let value: unknown;
  try { value = JSON.parse(input.body); }
  catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
  const parsed = CanonicalSubmitChatApprovalRequestSchema.safeParse(value);
  if (!parsed.success || parsed.data.decision === "approve_for_session") return null;
  const now = input.now ?? Date.now();
  const payload = Payload.parse({
    version: 1, handle: input.identity.handle, actorId: input.identity.userId,
    chatId: match[1], runId: match[2], approvalId: match[3],
    decision: parsed.data.decision, clientRequestId: parsed.data.clientRequestId,
    bodyDigest: bodyDigest(parsed.data), expiresAt: now + TTL_MS,
    nonce: randomBytes(16).toString("hex"),
  });
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(encoded, input.secret)}`;
}

export function verifyCustomMcpApprovalProof(proof: string | undefined, expected: {
  handle: string; actorId: string; chatId: string; runId: string; approvalId: string;
  decision: "approve" | "decline" | "cancel"; clientRequestId: string;
  secret: string; now?: number;
}): boolean {
  if (!proof || proof.length > 1_500 || !expected.secret) return false;
  const match = /^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(proof);
  if (!match) return false;
  const actualMac = Buffer.from(match[2]!, "hex");
  const expectedMac = Buffer.from(signature(match[1]!, expected.secret), "hex");
  if (!timingSafeEqual(actualMac, expectedMac)) return false;
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")); }
  catch (error: unknown) {
    if (error instanceof SyntaxError || error instanceof TypeError) return false;
    throw error;
  }
  const parsed = Payload.safeParse(decoded);
  if (!parsed.success) return false;
  const value: Payload = parsed.data;
  const now = expected.now ?? Date.now();
  return value.expiresAt > now && value.expiresAt <= now + TTL_MS
    && value.handle === expected.handle && value.actorId === expected.actorId
    && value.chatId === expected.chatId && value.runId === expected.runId
    && value.approvalId === expected.approvalId && value.decision === expected.decision
    && value.clientRequestId === expected.clientRequestId
    && value.bodyDigest === bodyDigest(expected);
}
