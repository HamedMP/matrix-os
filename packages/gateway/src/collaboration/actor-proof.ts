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
import {
  createRateLimiter,
  type RateLimitConfig,
  type RateLimiter,
} from "../security/rate-limiter.js";

const MAX_PROOF_LIFETIME_MS = 30_000;
const MAX_CLOCK_SKEW_MS = 5_000;
const MAX_SEEN_NONCES = 10_000;
const DEFAULT_ACTOR_RATE_LIMIT: RateLimitConfig = {
  maxAttempts: 600,
  windowMs: 60_000,
  lockoutMs: 30_000,
  maxKeys: 10_000,
};

export type CollaborationActorProofErrorCode =
  | "invalid_proof"
  | "replayed_proof"
  | "rate_limited"
  | "unavailable";

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
  private readonly actorRateLimiter: RateLimiter;

  constructor(private readonly options: {
    runtimeId: string;
    keys: Readonly<Record<string, string>>;
    now?: () => Date;
    authority?: CollaborationAuthority;
    actorRateLimit?: RateLimitConfig;
  }) {
    this.now = options.now ?? (() => new Date());
    this.actorRateLimiter = createRateLimiter(options.actorRateLimit ?? DEFAULT_ACTOR_RATE_LIMIT);
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
    this.admitActor(proof, expiresAt, now);
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
  }): Promise<AuthorizedCollaborationContext> {
    const proof = await this.verifyHttp(input);
    if (!proof.scopeId || !this.options.authority) {
      throw new CollaborationActorProofError("unavailable", "Collaboration authority is unavailable");
    }
    const context = await this.options.authority.authorize({
      scopeId: proof.scopeId,
      actorId: proof.actorId,
      action: input.action,
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
    this.admitActor(proof, expiresAt, now);
    return proof;
  }

  verifyPolicy(signedPolicy: unknown): CollaborationPolicy {
    const parsed = CollaborationSignedPolicySchema.safeParse(signedPolicy);
    if (!parsed.success) throw invalidProof();
    const { policy, keyId, signature } = parsed.data;
    const key = this.options.keys[keyId];
    if (!key || Buffer.byteLength(key) < 32
      || !constantTimeSignatureMatches("policy", policy, key, signature)) throw invalidProof();
    const now = this.now().getTime();
    const issuedAt = Date.parse(policy.issuedAt);
    const expiresAt = Date.parse(policy.expiresAt);
    if (issuedAt > now + MAX_CLOCK_SKEW_MS
      || expiresAt <= now
      || expiresAt - issuedAt > MAX_PROOF_LIFETIME_MS) throw invalidProof();
    return policy;
  }

  shutdown(): void {
    this.seenNonces.clear();
  }

  private admitActor(proof: CollaborationActorProof, expiresAt: number, now: number): void {
    this.rejectReplay(proof, expiresAt, now);
    if (!this.actorRateLimiter.check(proof.actorId)) {
      throw new CollaborationActorProofError("rate_limited", "Collaboration actor rate limit reached");
    }
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
