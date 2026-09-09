import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  CollaborationSignedActorProofSchema,
  CollaborationSignedPolicySchema,
  type CollaborationActorProof,
  type CollaborationDeleteCondition,
  type CollaborationPolicy,
} from "@matrix-os/contracts";
import type {
  AuthorizedCollaborationContext,
  CollaborationAction,
  CollaborationAuthority,
} from "./authority.js";

const MAX_PROOF_LIFETIME_MS = 30_000;
const MAX_CLOCK_SKEW_MS = 5_000;
const MAX_SEEN_NONCES = 10_000;

export type CollaborationActorProofErrorCode = "invalid_proof" | "replayed_proof" | "unavailable";

export class CollaborationActorProofError extends Error {
  constructor(
    public readonly code: CollaborationActorProofErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CollaborationActorProofError";
  }
}

export class CollaborationActorProofVerifier {
  private readonly now: () => Date;
  private readonly seenNonces = new Map<string, number>();

  constructor(private readonly options: {
    runtimeId: string;
    keys: Readonly<Record<string, string>>;
    now?: () => Date;
    authority?: CollaborationAuthority;
  }) {
    this.now = options.now ?? (() => new Date());
  }

  async verifyHttp(input: {
    signedProof: unknown;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    query: string;
    body: Uint8Array;
    conditionalHeaders?: CollaborationDeleteCondition;
  }): Promise<CollaborationActorProof> {
    const parsed = CollaborationSignedActorProofSchema.safeParse(input.signedProof);
    if (!parsed.success) throw invalidProof();
    const { proof, signature } = parsed.data;
    const key = this.options.keys[proof.keyId];
    if (!key || Buffer.byteLength(key) < 32 || !constantTimeSignatureMatches("http", proof, key, signature)) {
      throw invalidProof();
    }
    const now = this.now().getTime();
    const issuedAt = Date.parse(proof.issuedAt);
    const expiresAt = Date.parse(proof.expiresAt);
    if (proof.runtimeId !== this.options.runtimeId
      || proof.purpose !== "http"
      || issuedAt > now + MAX_CLOCK_SKEW_MS
      || expiresAt <= now
      || expiresAt - issuedAt > MAX_PROOF_LIFETIME_MS
      || input.method !== proof.method
      || input.path !== proof.path
      || input.query !== proof.query
      || digestBody(input.body) !== proof.bodyDigest
      || digestConditionalHeaders(input.conditionalHeaders) !== proof.conditionalHeadersDigest) {
      throw invalidProof();
    }
    this.rejectReplay(proof, expiresAt, now);
    return proof;
  }

  async verifyAndAuthorize(input: {
    signedProof: unknown;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    query: string;
    body: Uint8Array;
    conditionalHeaders?: CollaborationDeleteCondition;
    action: CollaborationAction;
    signedExecutionPolicy?: unknown;
  }): Promise<AuthorizedCollaborationContext> {
    const proof = await this.verifyHttp(input);
    if (!proof.scopeId || !this.options.authority) {
      throw new CollaborationActorProofError("unavailable", "Collaboration authority is unavailable");
    }
    const context = await this.options.authority.authorize({
      scopeId: proof.scopeId,
      actorId: proof.actorId,
      action: input.action,
      ...(input.signedExecutionPolicy === undefined
        ? {}
        : { executionPolicy: this.verifyPolicy(input.signedExecutionPolicy) }),
    });
    if (context.ownerId !== proof.ownerId || context.authorityRuntimeId !== proof.runtimeId) {
      throw invalidProof();
    }
    return context;
  }

  async verifySocket(input: {
    signedProof: unknown;
    purpose: "events" | "terminal";
    path: string;
    query?: string;
  }): Promise<CollaborationActorProof> {
    const parsed = CollaborationSignedActorProofSchema.safeParse(input.signedProof);
    if (!parsed.success) throw invalidProof();
    const { proof, signature } = parsed.data;
    const key = this.options.keys[proof.keyId];
    if (!key || Buffer.byteLength(key) < 32
      || !constantTimeSignatureMatches(input.purpose, proof, key, signature)) {
      throw invalidProof();
    }
    const now = this.now().getTime();
    const issuedAt = Date.parse(proof.issuedAt);
    const expiresAt = Date.parse(proof.expiresAt);
    if (proof.runtimeId !== this.options.runtimeId
      || proof.purpose !== input.purpose
      || proof.method !== "GET"
      || proof.path !== input.path
      || proof.query !== (input.query ?? "")
      || proof.bodyDigest !== digestBody(new Uint8Array())
      || proof.conditionalHeadersDigest !== digestConditionalHeaders(undefined)
      || !proof.scopeId
      || issuedAt > now + MAX_CLOCK_SKEW_MS
      || expiresAt <= now
      || expiresAt - issuedAt > MAX_PROOF_LIFETIME_MS) {
      throw invalidProof();
    }
    this.rejectReplay(proof, expiresAt, now);
    return proof;
  }

  verifyPolicy(input: unknown): CollaborationPolicy {
    const parsed = CollaborationSignedPolicySchema.safeParse(input);
    if (!parsed.success) throw invalidProof();
    const key = this.options.keys[parsed.data.keyId];
    if (!key || Buffer.byteLength(key) < 32
      || !constantTimeSignatureMatches("policy", parsed.data.policy, key, parsed.data.signature)) {
      throw invalidProof();
    }
    const now = this.now().getTime();
    if (Date.parse(parsed.data.policy.issuedAt) > now + MAX_CLOCK_SKEW_MS
      || Date.parse(parsed.data.policy.expiresAt) <= now
      || Date.parse(parsed.data.policy.expiresAt) - Date.parse(parsed.data.policy.issuedAt) > MAX_PROOF_LIFETIME_MS) {
      throw invalidProof();
    }
    return parsed.data.policy;
  }

  shutdown(): void {
    this.seenNonces.clear();
  }

  private rejectReplay(proof: CollaborationActorProof, expiresAt: number, now: number): void {
    for (const [nonce, expiry] of this.seenNonces) {
      if (expiry <= now) this.seenNonces.delete(nonce);
    }
    const replayKey = `${proof.keyId}:${proof.nonce}`;
    if (this.seenNonces.has(replayKey)) {
      throw new CollaborationActorProofError("replayed_proof", "Collaboration proof was already used");
    }
    while (this.seenNonces.size >= MAX_SEEN_NONCES) {
      const oldest = this.seenNonces.keys().next().value as string | undefined;
      if (!oldest) break;
      this.seenNonces.delete(oldest);
    }
    this.seenNonces.set(replayKey, expiresAt);
  }
}

function constantTimeSignatureMatches(
  domain: "http" | "events" | "terminal" | "policy",
  value: CollaborationActorProof | CollaborationPolicy,
  key: string,
  signature: string,
): boolean {
  const expected = createHmac("sha256", key).update(`${domain}\n${JSON.stringify(value)}`).digest();
  const received = Buffer.from(signature, "base64url");
  const padded = Buffer.alloc(expected.length);
  received.copy(padded, 0, 0, expected.length);
  const contentMatches = timingSafeEqual(padded, expected);
  return received.length === expected.length && contentMatches;
}

function digestBody(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function digestConditionalHeaders(value: CollaborationDeleteCondition | undefined): string {
  return createHash("sha256").update(value === undefined ? "" : JSON.stringify({
    clientRequestId: value.clientRequestId,
    expectedRevision: value.expectedRevision,
    expectedMemberRevision: value.expectedMemberRevision,
  })).digest("hex");
}

function invalidProof(): CollaborationActorProofError {
  return new CollaborationActorProofError("invalid_proof", "Collaboration proof is invalid");
}
