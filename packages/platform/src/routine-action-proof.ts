import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { RoutineActionProofSchema, RoutineActionSubmitSchema, RoutineActionTupleSchema,
  ROUTINE_ACTION_PROOF_HEADER, type RoutineActionTuple } from "@matrix-os/contracts";
import type { ClerkAuth } from "./clerk-auth.js";
import type { AppDomainIdentity } from "./session-routing-identity.js";

const DOMAIN = "matrix-routine-cli-owner-action:v1\0";
const TTL = 60_000;
const CHAT = /^\/api\/chats\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\/runs\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\/approvals\/(rcact_[a-f0-9]{32})$/;
const DIRECT = /^\/api\/routine-cli\/actions\/(rcact_[a-f0-9]{32})\/decision$/;
export { ROUTINE_ACTION_PROOF_HEADER };
export function routineActionPathId(method: string, path: string) { return method === "POST" ? (DIRECT.exec(path) ?? CHAT.exec(path))?.[1] ?? null : null; }
const digest = (tuple: RoutineActionTuple) => createHash("sha256").update(DOMAIN + JSON.stringify(tuple)).digest("hex");
/** Narrow, independently verified human-session gate. Routing source=auth and native labels are insufficient. */
export async function routineOwnerSession(input: { request: Request; identity: AppDomainIdentity; clerkAuth?: ClerkAuth; now?: number }): Promise<number | null> {
  const now = input.now ?? Date.now(), identity = input.identity;
  if (identity.source !== "auth") return null;
  if (identity.sessionProvenance === "clerk-browser" && identity.sessionExpiresAt !== undefined && identity.sessionExpiresAt * 1000 > now)
    return Math.min(now + TTL, identity.sessionExpiresAt * 1000);
  if (!input.clerkAuth) return null;
  // At most two actual Clerk candidates; device Bearer must not shadow a real Clerk cookie.
  const candidates = [input.clerkAuth.extractToken(input.request.headers.get("authorization") ?? undefined, undefined),
    input.clerkAuth.extractToken(undefined, input.request.headers.get("cookie") ?? undefined)];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5000); timer.unref?.(); });
  try {
    return await Promise.race([(async () => {
      for (const token of candidates.filter((value, i, all): value is string => !!value && all.indexOf(value) === i)) {
        const result = await input.clerkAuth!.verify(token);
        if (result.authenticated && result.userId === identity.userId && result.sessionId) {
          const expiresAt = Math.min(now + TTL, result.tokenExpiresAt === undefined ? Infinity : result.tokenExpiresAt * 1000);
          if (expiresAt > now) return expiresAt;
        }
      }
      return null;
    })(), timeout]);
  } finally { clearTimeout(timer); }
}
export function mintRoutineActionProof(input: { method: string; path: string; body: string; secret: string;
  handle: string; runtimeSlot: string; machineId: string; ownerId: string; sessionExpiresAt: number; now?: number }): string | null {
  const challengeId = routineActionPathId(input.method, input.path), now = input.now ?? Date.now();
  if (!challengeId || !input.secret || Buffer.byteLength(input.body) > 4000 || input.sessionExpiresAt <= now) return null;
  let raw: unknown;
  try { raw = JSON.parse(input.body); } catch (error: unknown) { if (error instanceof SyntaxError) return null; throw error; }
  const body = RoutineActionSubmitSchema.safeParse(raw);
  const tuple = RoutineActionTupleSchema.safeParse({ ...(body.success ? body.data : {}), handle: input.handle,
    runtimeSlot: input.runtimeSlot, machineId: input.machineId, ownerId: input.ownerId, challengeId });
  if (!body.success || !tuple.success) return null;
  const value = { ...tuple.data, purpose: "routine_cli_owner_action", version: 1,
    expiresAt: Math.min(now + TTL, input.sessionExpiresAt), nonce: randomBytes(16).toString("hex"), bodyDigest: digest(tuple.data) };
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encoded}.${createHmac("sha256", input.secret).update(DOMAIN + encoded).digest("hex")}`;
}
export function verifyRoutineActionProof(proof: string | undefined, expected: RoutineActionTuple, secret: string, now = Date.now()) {
  if (!proof || proof.length > 4000 || !secret) return null;
  const match = /^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(proof);
  if (!match || !timingSafeEqual(Buffer.from(match[2]!, "hex"), createHmac("sha256", secret).update(DOMAIN + match[1]).digest())) return null;
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")); }
  catch (error: unknown) { if (error instanceof SyntaxError) return null; throw error; }
  const parsed = RoutineActionProofSchema.safeParse(raw), tuple = RoutineActionTupleSchema.safeParse(expected);
  if (!parsed.success || !tuple.success || parsed.data.expiresAt <= now || parsed.data.expiresAt > now + TTL) return null;
  return Object.entries(tuple.data).every(([key, field]) => parsed.data[key as keyof typeof parsed.data] === field)
    && parsed.data.bodyDigest === digest(tuple.data) ? parsed.data : null;
}
