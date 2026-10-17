import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BrowserDecisionProofSchema, BrowserDecisionTupleSchema, BrowserGrantRevokeRequestSchema,
  BrowserGrantRevokeTupleSchema, BrowserRevokeProofSchema, CanonicalSubmitChatApprovalRequestSchema,
  type BrowserDecisionTuple, type BrowserGrantRevokeTuple } from "@matrix-os/contracts";
import { hasVerifiedPreviewUserSession } from "./preview-drive-turn-proof.js";

export const BROWSER_APPROVAL_PROOF_HEADER = "x-matrix-browser-approval-proof";
const TTL = 60_000;
const REF = "[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}";
const DECISION_PATH = new RegExp(`^/api/chats/(${REF})/runs/(${REF})/approvals/(${REF})$`);
const REVOKE_PATH = new RegExp(`^/api/chats/(${REF})/browser-grants/([a-f0-9-]{36})$`);
const DOMAIN = "matrix-browser-user-decision:v1\0";
const REVOKE_DOMAIN = "matrix-browser-grant-revoke:v1\0";
export function isBrowserGrantRevokePath(method: string, path: string) { return method === "DELETE" && REVOKE_PATH.test(path); }
const bodyDigest = (value: object) => createHash("sha256").update(`matrix-browser-intent:v1\0${JSON.stringify(value)}`).digest("hex");
function signed(value: object, secret: string, domain: string) {
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(domain + encoded).digest("hex")}`;
}
function decoded(proof: string | undefined, secret: string, domain: string): unknown {
  if (!proof || proof.length > 4000 || !secret) return null;
  const match = /^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(proof);
  if (!match || !timingSafeEqual(Buffer.from(match[2]!, "hex"), createHmac("sha256", secret).update(domain + match[1]).digest())) return null;
  try { return JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")); }
  catch (error: unknown) { if (error instanceof SyntaxError) return null; throw error; }
}
export function mintBrowserApprovalProof(input: {
  method: string; path: string; identity: Parameters<typeof hasVerifiedPreviewUserSession>[0] & { userId: string; handle: string; runtimeSlot: string };
  body: string; secret: string; now?: number;
}): string | null {
  if (!input.secret || !hasVerifiedPreviewUserSession(input.identity) || Buffer.byteLength(input.body) > 4000) return null;
  let raw: unknown;
  try { raw = JSON.parse(input.body); } catch (error: unknown) { if (error instanceof SyntaxError) return null; throw error; }
  const common = { handle: input.identity.handle, actorId: input.identity.userId, runtimeSlot: input.identity.runtimeSlot };
  const now = input.now ?? Date.now();
  const expiresAt = Math.min(now + TTL, input.identity.sessionExpiresAt === undefined ? Infinity : input.identity.sessionExpiresAt * 1000);
  if (expiresAt <= now) return null;
  const nonce = randomBytes(16).toString("hex");
  const match = DECISION_PATH.exec(input.path);
  if (input.method === "POST" && match) {
    const parsed = CanonicalSubmitChatApprovalRequestSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.browserApproval || !parsed.data.actionDigest) return null;
    const browser = parsed.data.browserApproval;
    const tuple = BrowserDecisionTupleSchema.safeParse({ ...common, chatId: match[1], runId: match[2], approvalId: match[3],
      clientRequestId: parsed.data.clientRequestId, browserDecision: browser.decision, actionDigest: parsed.data.actionDigest,
      leaseEpoch: browser.leaseEpoch, challengeRevision: browser.challengeRevision, scopeVersion: browser.scopeVersion });
    return tuple.success ? signed({ ...tuple.data, version: 1, expiresAt, nonce, bodyDigest: bodyDigest(tuple.data) }, input.secret, DOMAIN) : null;
  }
  const revoke = REVOKE_PATH.exec(input.path);
  if (input.method !== "DELETE" || !revoke) return null;
  const parsed = BrowserGrantRevokeRequestSchema.safeParse(raw);
  if (!parsed.success) return null;
  const tuple = BrowserGrantRevokeTupleSchema.safeParse({ ...common, chatId: revoke[1], grantId: revoke[2], ...parsed.data });
  return tuple.success ? signed({ ...tuple.data, version: 1, operation: "revoke_grant", expiresAt, nonce,
    bodyDigest: bodyDigest(tuple.data) }, input.secret, REVOKE_DOMAIN) : null;
}
export function verifyBrowserDecisionProof(proof: string | undefined, expected: BrowserDecisionTuple, secret: string, now = Date.now()) {
  const tuple = BrowserDecisionTupleSchema.safeParse(expected);
  const parsed = BrowserDecisionProofSchema.safeParse(decoded(proof, secret, DOMAIN));
  if (!tuple.success || !parsed.success || parsed.data.expiresAt <= now || parsed.data.expiresAt > now + TTL) return null;
  const value = parsed.data;
  return Object.entries(tuple.data).every(([key, field]) => value[key as keyof typeof value] === field)
    && value.bodyDigest === bodyDigest(tuple.data) ? value : null;
}
export function verifyBrowserRevokeProof(proof: string | undefined, expected: BrowserGrantRevokeTuple, secret: string, now = Date.now()) {
  const tuple = BrowserGrantRevokeTupleSchema.safeParse(expected);
  const parsed = BrowserRevokeProofSchema.safeParse(decoded(proof, secret, REVOKE_DOMAIN));
  if (!tuple.success || !parsed.success || parsed.data.expiresAt <= now || parsed.data.expiresAt > now + TTL) return null;
  const value = parsed.data;
  return Object.entries(tuple.data).every(([key, field]) => value[key as keyof typeof value] === field)
    && value.bodyDigest === bodyDigest(tuple.data) ? value : null;
}
/** Only classifies a proof just minted by this process; never verifies caller authority. */
export function browserApprovalProofHeader(proof: string): string {
  try { const value = JSON.parse(Buffer.from(proof.split(".")[0]!, "base64url").toString("utf8"));
    return BrowserDecisionProofSchema.safeParse(value).success || BrowserRevokeProofSchema.safeParse(value).success
      ? BROWSER_APPROVAL_PROOF_HEADER : "x-matrix-custom-mcp-approval-proof";
  } catch (error: unknown) { if (error instanceof SyntaxError) throw new Error("Approval proof unavailable"); throw error; }
}
