import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  CollaborationActorProofSchema,
  CollaborationPolicySchema,
  CollaborationSignedActorProofSchema,
  CollaborationSignedPolicySchema,
  type CollaborationActorProof,
  type CollaborationDeleteCondition,
  type CollaborationPolicy,
} from "@matrix-os/contracts";

const PROOF_LIFETIME_MS = 30_000;

export interface CollaborationProofKeyring {
  activeKeyId: string;
  keys: Readonly<Record<string, string>>;
  now?: () => Date;
  createNonce?: () => string;
}

export class CollaborationProofSigner {
  private readonly now: () => Date;
  private readonly createNonce: () => string;

  constructor(private readonly keyring: CollaborationProofKeyring) {
    requireKey(keyring.keys[keyring.activeKeyId]);
    this.now = keyring.now ?? (() => new Date());
    this.createNonce = keyring.createNonce ?? (() => randomBytes(24).toString("hex"));
  }

  signHttp(input: {
    actorId: string;
    ownerId: string;
    runtimeId: string;
    scopeId?: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    query: string;
    body: Uint8Array;
    conditionalHeaders?: CollaborationDeleteCondition;
  }) {
    const issuedAt = this.now();
    const proof = CollaborationActorProofSchema.parse({
      version: 1,
      keyId: this.keyring.activeKeyId,
      actorId: input.actorId,
      ownerId: input.ownerId,
      runtimeId: input.runtimeId,
      ...(input.scopeId ? { scopeId: input.scopeId } : {}),
      purpose: "http",
      method: input.method,
      path: input.path,
      query: input.query,
      bodyDigest: digestBody(input.body),
      conditionalHeadersDigest: digestConditionalHeaders(input.conditionalHeaders),
      nonce: this.createNonce(),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + PROOF_LIFETIME_MS).toISOString(),
    });
    return CollaborationSignedActorProofSchema.parse({
      proof,
      signature: sign("http", proof, requireKey(this.keyring.keys[this.keyring.activeKeyId])),
    });
  }

  signSocket(input: {
    actorId: string;
    ownerId: string;
    runtimeId: string;
    scopeId: string;
    purpose: "events" | "terminal";
    path: string;
    query?: string;
  }) {
    const issuedAt = this.now();
    const proof = CollaborationActorProofSchema.parse({
      version: 1,
      keyId: this.keyring.activeKeyId,
      actorId: input.actorId,
      ownerId: input.ownerId,
      runtimeId: input.runtimeId,
      scopeId: input.scopeId,
      purpose: input.purpose,
      method: "GET",
      path: input.path,
      query: input.query ?? "",
      bodyDigest: digestBody(new Uint8Array()),
      conditionalHeadersDigest: digestConditionalHeaders(undefined),
      nonce: this.createNonce(),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + PROOF_LIFETIME_MS).toISOString(),
    });
    return CollaborationSignedActorProofSchema.parse({
      proof,
      signature: sign(input.purpose, proof, requireKey(this.keyring.keys[this.keyring.activeKeyId])),
    });
  }

  signPolicy(policyInput: CollaborationPolicy) {
    const policy = CollaborationPolicySchema.parse(policyInput);
    return CollaborationSignedPolicySchema.parse({
      policy,
      keyId: this.keyring.activeKeyId,
      signature: sign("policy", policy, requireKey(this.keyring.keys[this.keyring.activeKeyId])),
    });
  }
}

export function digestBody(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function digestConditionalHeaders(value: CollaborationDeleteCondition | undefined): string {
  return createHash("sha256").update(value === undefined ? "" : JSON.stringify({
    clientRequestId: value.clientRequestId,
    expectedRevision: value.expectedRevision,
    expectedMemberRevision: value.expectedMemberRevision,
  })).digest("hex");
}

function sign(
  domain: "http" | "events" | "terminal" | "policy",
  value: CollaborationActorProof | CollaborationPolicy,
  key: string,
): string {
  return createHmac("sha256", key).update(`${domain}\n${JSON.stringify(value)}`).digest("base64url");
}

function requireKey(key: string | undefined): string {
  if (!key || Buffer.byteLength(key) < 32) throw new Error("Collaboration proof key is unavailable");
  return key;
}
