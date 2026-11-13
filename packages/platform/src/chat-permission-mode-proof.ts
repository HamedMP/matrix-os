import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import { CanonicalSetChatPermissionModeRequestSchema } from "@matrix-os/contracts";

export const CHAT_PERMISSION_MODE_PROOF_HEADER = "x-matrix-chat-permission-mode-proof";
const ref = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const pathPattern = /^\/api\/chats\/([^/]+)\/runs\/([^/]+)\/permission-mode$/;
const TTL = 60_000;
export const ChatPermissionModeProofSchema = z.object({
  purpose: z.literal("chat_permission_mode"), handle: z.string().min(1).max(63), actorId: z.string().min(1).max(256),
  chatId: ref, runId: ref, clientRequestId: ref, permissionMode: z.enum(["supervised", "full_access"]), expiresAt: z.number().int(),
}).strict();
export function isChatPermissionModePath(method: string, path: string) { return method === "POST" && pathPattern.test(path); }
function sign(encoded: string, secret: string) { return createHmac("sha256", secret).update(`matrix-chat-permission-mode:v1\0${encoded}`).digest(); }
export function mintChatPermissionModeProof(input: {
  method: string; path: string; body: string; secret: string; identity: { handle: string; userId: string; source?: string }; now?: number;
}): string | null {
  if (!isChatPermissionModePath(input.method, input.path) || !input.secret || input.identity.source !== "auth" || Buffer.byteLength(input.body) > 4000) return null;
  let value: unknown;
  try { value = JSON.parse(input.body); } catch (error: unknown) { if (error instanceof SyntaxError) return null; throw error; }
  const request = CanonicalSetChatPermissionModeRequestSchema.safeParse(value);
  const match = pathPattern.exec(input.path);
  if (!request.success || !match) return null;
  const payload = ChatPermissionModeProofSchema.safeParse({ purpose: "chat_permission_mode", handle: input.identity.handle,
    actorId: input.identity.userId, chatId: match[1], runId: match[2], ...request.data, expiresAt: (input.now ?? Date.now()) + TTL });
  if (!payload.success) return null;
  const encoded = Buffer.from(JSON.stringify(payload.data)).toString("base64url");
  return `${encoded}.${sign(encoded, input.secret).toString("hex")}`;
}
export function verifyChatPermissionModeProof(proof: string | undefined, expected: {
  handle: string; actorId: string; chatId: string; runId: string; clientRequestId: string; permissionMode: "supervised" | "full_access"; secret: string; now?: number;
}): boolean {
  if (!proof || proof.length > 1500 || !expected.secret) return false;
  const match = /^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(proof);
  if (!match || !timingSafeEqual(Buffer.from(match[2]!, "hex"), sign(match[1]!, expected.secret))) return false;
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")); }
  catch (error: unknown) { if (error instanceof SyntaxError || error instanceof TypeError) return false; throw error; }
  const parsed = ChatPermissionModeProofSchema.safeParse(decoded);
  if (!parsed.success) return false;
  const { secret: _secret, now: suppliedNow, ...tuple } = expected;
  const now = suppliedNow ?? Date.now();
  return parsed.data.expiresAt > now && parsed.data.expiresAt <= now + TTL
    && Object.entries(tuple).every(([key, value]) => parsed.data[key as keyof typeof parsed.data] === value);
}
