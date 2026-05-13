import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { MESSAGING_HERMES_CAPABILITY_TTL_MS } from "./constants.js";

export const HERMES_REPLY_SCOPE = "messages.reply.request" as const;
export type HermesCapabilityScope = typeof HERMES_REPLY_SCOPE;

export interface HermesCapabilityClaims {
  ownerId: string;
  roomId: string;
  scope: HermesCapabilityScope;
  jti: string;
  exp: number;
}

export interface CreateHermesCapabilityTokenInput {
  secret: string;
  ownerId: string;
  roomId: string;
  scope: HermesCapabilityScope;
  ttlMs?: number;
  nowMs?: number;
}

export interface VerifyHermesCapabilityTokenInput {
  token: string;
  secret: string;
  ownerId: string;
  roomId: string;
  scope: HermesCapabilityScope;
  nowMs?: number;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createHermesCapabilityToken(input: CreateHermesCapabilityTokenInput): string {
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = Math.min(input.ttlMs ?? MESSAGING_HERMES_CAPABILITY_TTL_MS, MESSAGING_HERMES_CAPABILITY_TTL_MS);
  const claims: HermesCapabilityClaims = {
    ownerId: input.ownerId,
    roomId: input.roomId,
    scope: input.scope,
    jti: randomUUID(),
    exp: Math.floor((nowMs + ttlMs) / 1000),
  };
  const payload = base64url(JSON.stringify(claims));
  return `${payload}.${sign(payload, input.secret)}`;
}

export function verifyHermesCapabilityToken(input: VerifyHermesCapabilityTokenInput): HermesCapabilityClaims | null {
  const [payload, signature, extra] = input.token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expectedSignature = sign(payload, input.secret);
  if (!constantTimeEqual(signature, expectedSignature)) return null;

  let claims: HermesCapabilityClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as HermesCapabilityClaims;
  } catch (err: unknown) {
    console.error("[messages/hermes-capability] Invalid capability payload", err instanceof Error ? err.name : typeof err);
    return null;
  }

  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (claims.exp <= nowSeconds) return null;
  if (claims.ownerId !== input.ownerId) return null;
  if (claims.roomId !== input.roomId) return null;
  if (claims.scope !== input.scope) return null;
  return claims;
}
