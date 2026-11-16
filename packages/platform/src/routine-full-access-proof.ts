import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { CanonicalCreateChatTurnRequestSchema, RoutineFullAccessDecisionSubmitSchema, RoutineFullAccessIdSchema,
  RoutineFullAccessProofSchema, RoutineFullAccessTupleSchema, routineFullAccessTurnRequestIdentity,
  type RoutineFullAccessTuple } from "@matrix-os/contracts";

const DOMAIN = "matrix-routine-cli-full-access-origin:v1\0";
const TTL = 60_000;
const REF = "[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}";
const DECISION = new RegExp(`^/api/chats/(${REF})/routine-cli/full-access/challenges/(rcfull_[a-f0-9]{32})/decision$`);
const TURN = new RegExp(`^/api/chats/(${REF})/turns$`);
export function routineFullAccessPath(method: string, path: string): { kind: "scope_decision" | "turn"; chatId: string; challengeId?: string } | null {
  if (method !== "POST") return null;
  const decision = DECISION.exec(path), turn = TURN.exec(path);
  return decision ? { kind: "scope_decision", chatId: decision[1]!, challengeId: decision[2]! }
    : turn ? { kind: "turn", chatId: turn[1]! } : null;
}
const digest = (tuple: RoutineFullAccessTuple) => createHash("sha256").update(DOMAIN + JSON.stringify(tuple)).digest("hex");

export function routineFullAccessTuple(input: { method: string; path: string; body: string; scopeId?: string | null;
  handle: string; runtimeSlot: string; machineId: string; ownerId: string }): RoutineFullAccessTuple | null {
  const route = routineFullAccessPath(input.method, input.path);
  if (!route || Buffer.byteLength(input.body) > (route.kind === "turn" ? 128 * 1024 : 4000)) return null;
  let raw: unknown;
  try { raw = JSON.parse(input.body); } catch (error: unknown) { if (error instanceof SyntaxError) return null; throw error; }
  const routing = { handle: input.handle, runtimeSlot: input.runtimeSlot, machineId: input.machineId, ownerId: input.ownerId, chatId: route.chatId };
  let candidate: unknown;
  if (route.kind === "scope_decision") {
    const body = RoutineFullAccessDecisionSubmitSchema.safeParse(raw);
    if (!body.success) return null;
    candidate = { ...routing, ...body.data, kind: route.kind, challengeId: route.challengeId };
  } else {
    const body = CanonicalCreateChatTurnRequestSchema.safeParse(raw);
    if (!body.success || body.data.permissionMode !== "full_access" || body.data.interactionMode !== "default") return null;
    const request = { ...routing, clientRequestId: body.data.clientRequestId,
      requestDigest: createHash("sha256").update(routineFullAccessTurnRequestIdentity(body.data)).digest("hex") };
    if (input.scopeId == null) {
      candidate = { ...request, kind: "direct_turn" };
    } else {
      const scope = RoutineFullAccessIdSchema.safeParse(input.scopeId);
      if (!scope.success || !body.data.selection.instanceId.startsWith("claude_code_")) return null;
      candidate = { ...request, kind: route.kind, scopeId: scope.data };
    }
  }
  const tuple = RoutineFullAccessTupleSchema.safeParse(candidate);
  return tuple.success ? tuple.data : null;
}

/** Attests browser provenance for one request. Gateway separately checks the active private Chat and Run. */
export function mintRoutineFullAccessProof(input: { tuple: RoutineFullAccessTuple; secret: string; sessionExpiresAt: number; now?: number }): string | null {
  const now = input.now ?? Date.now();
  if (!input.secret || !Number.isSafeInteger(input.sessionExpiresAt) || input.sessionExpiresAt <= now) return null;
  const value = { ...input.tuple, purpose: "routine_cli_full_access_origin", version: 1,
    expiresAt: Math.min(now + TTL, input.sessionExpiresAt), nonce: randomBytes(16).toString("hex"), bodyDigest: digest(input.tuple) };
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encoded}.${createHmac("sha256", input.secret).update(DOMAIN + encoded).digest("hex")}`;
}

export function verifyRoutineFullAccessProof(proof: string | undefined, expected: RoutineFullAccessTuple, secret: string, now = Date.now()) {
  if (!proof || proof.length > 4000 || !secret) return null;
  const match = /^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(proof);
  if (!match || !timingSafeEqual(Buffer.from(match[2]!, "hex"), createHmac("sha256", secret).update(DOMAIN + match[1]).digest())) return null;
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")); }
  catch (error: unknown) { if (error instanceof SyntaxError) return null; throw error; }
  const parsed = RoutineFullAccessProofSchema.safeParse(raw), tuple = RoutineFullAccessTupleSchema.safeParse(expected);
  if (!parsed.success || !tuple.success || parsed.data.expiresAt <= now || parsed.data.expiresAt > now + TTL) return null;
  return Object.entries(tuple.data).every(([key, field]) => (parsed.data as unknown as Record<string, unknown>)[key] === field)
    && parsed.data.bodyDigest === digest(tuple.data) ? parsed.data : null;
}
