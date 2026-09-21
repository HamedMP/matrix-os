/** Scope-free direct identity for the owner's three initial Share setup routes. */
import { randomUUID } from "node:crypto";
import {
  COLLABORATION_DIRECT_LIMITS, COLLABORATION_DIRECT_PROTOCOL_VERSION,
  CollaborationDirectRequestSignatureSchema, CollaborationOwnerRuntimeSessionRequestSchema,
  CollaborationOwnerRuntimeSessionSchema, type CollaborationOwnerRuntimeSession,
} from "@matrix-os/contracts";
import { CollaborationAuthorizationError } from "./authority-error.js";
import { DirectAuthError, type DirectTicketVerifier } from "./direct-auth.js";
import { requestSigningPayload, sha256Hex, verifyEd25519 } from "./direct-crypto.js";
import type { OrganizationPrecondition } from "./organization-precondition.js";

const SESSION_TTL_MS = COLLABORATION_DIRECT_LIMITS.identitySessionTtlSeconds * 1_000;
const EVIDENCE_TTL_MS = COLLABORATION_DIRECT_LIMITS.organizationEvidenceTtlSeconds * 1_000;
const REQUEST_WINDOW_MS = COLLABORATION_DIRECT_LIMITS.ticketTtlSeconds * 1_000;
const SKEW_MS = COLLABORATION_DIRECT_LIMITS.clockSkewSeconds * 1_000;
const MAX_SESSIONS = 256;
const RUNTIME_PATH = /^\/api\/collaboration\/runtimes\/((?:[A-Za-z0-9:_-]|%3[Aa]){1,128})\/(catalog\/resolve|scopes\/preflight|scopes)$/;

interface SessionRecord {
  session: CollaborationOwnerRuntimeSession;
  proofPublicKey: string;
  actionsRemaining: number;
}

export interface OwnerRuntimeRequest {
  sessionId: string;
  signature: unknown;
  proof: string;
  method: "POST";
  path: string;
  query: string;
  body: Uint8Array;
}

export class OwnerRuntimeSessionService {
  private readonly now: () => Date;
  private readonly sessions = new Map<string, SessionRecord>();
  private closed = false;

  constructor(private readonly options: {
    verifier: DirectTicketVerifier;
    ownerId: string;
    runtimeId: string;
    organizationPrecondition: OrganizationPrecondition;
    now?: () => Date;
  }) {
    this.now = options.now ?? (() => new Date());
  }

  async create(request: unknown): Promise<CollaborationOwnerRuntimeSession> {
    if (this.closed) throw unavailable();
    const parsed = CollaborationOwnerRuntimeSessionRequestSchema.safeParse(request);
    if (!parsed.success) throw new DirectAuthError("invalid_ticket", "Owner runtime session request is invalid");
    const ticket = this.options.verifier.verifyOwnerRuntimeTicket(parsed.data.signedTicket);
    this.options.verifier.requireClientOrigin(parsed.data.clientOrigin);
    this.options.verifier.verifyPossession({ ticket, proofPublicKey: parsed.data.proofPublicKey, possession: parsed.data.possession });
    if (ticket.actorId !== this.options.ownerId || ticket.runtime.runtimeId !== this.options.verifier.runtimeId()) throw denied();
    const evidenceExpiresAt = await this.requireMembership(ticket.organizationId, ticket.actorId);
    this.options.verifier.consume(ticket);
    this.sweep();
    if (this.sessions.size >= MAX_SESSIONS) throw new DirectAuthError("limit", "Too many owner runtime sessions");
    const issuedAt = this.now();
    const session = CollaborationOwnerRuntimeSessionSchema.parse({
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
      id: randomUUID(), actorId: ticket.actorId, organizationId: ticket.organizationId,
      runtimeId: ticket.runtime.runtimeId, authorityGeneration: ticket.runtime.authorityGeneration,
      purpose: "owner_runtime", proofKeyThumbprint: ticket.proofKeyThumbprint,
      issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + SESSION_TTL_MS).toISOString(),
      evidenceExpiresAt: new Date(Math.min(evidenceExpiresAt, issuedAt.getTime() + EVIDENCE_TTL_MS)).toISOString(),
      renewAfter: new Date(issuedAt.getTime() + SESSION_TTL_MS - 60_000).toISOString(),
    });
    this.sessions.set(session.id, { session, proofPublicKey: parsed.data.proofPublicKey, actionsRemaining: ticket.maxActions });
    return session;
  }

  async authenticate(input: OwnerRuntimeRequest): Promise<CollaborationOwnerRuntimeSession> {
    if (this.closed) throw unavailable();
    const record = this.sessions.get(input.sessionId);
    if (!record || Date.parse(record.session.expiresAt) <= this.now().getTime()) {
      if (record) this.sessions.delete(input.sessionId);
      throw new DirectAuthError("expired", "Session is not active");
    }
    const route = RUNTIME_PATH.exec(input.path);
    if (!route || route[1]!.replace(/%3[aA]/g, ":") !== this.options.runtimeId || input.method !== "POST" || input.query) throw denied();
    const parsed = CollaborationDirectRequestSignatureSchema.safeParse(input.signature);
    if (!parsed.success || parsed.data.sessionId !== input.sessionId) throw invalidSignature();
    const signature = parsed.data;
    const current = this.now().getTime();
    const issuedAt = Date.parse(signature.issuedAt);
    if (issuedAt > current + SKEW_MS || current - issuedAt > REQUEST_WINDOW_MS
      || signature.method !== input.method || signature.path !== input.path || signature.query !== input.query
      || signature.bodyDigest !== sha256Hex(input.body)
      || signature.conditionalHeadersDigest !== sha256Hex(new Uint8Array())
      || !verifyEd25519(record.proofPublicKey, requestSigningPayload(signature), input.proof)) throw invalidSignature();
    this.options.verifier.admitRequestNonce(record.session.id, signature.nonce, issuedAt + REQUEST_WINDOW_MS + SKEW_MS);
    try {
      const evidenceExpiresAt = await this.requireMembership(record.session.organizationId, record.session.actorId);
      record.session = { ...record.session, evidenceExpiresAt: new Date(Math.min(evidenceExpiresAt, Date.parse(record.session.expiresAt))).toISOString() };
    } catch (error: unknown) {
      this.sessions.delete(record.session.id);
      throw error;
    }
    if (record.actionsRemaining <= 0) {
      this.sessions.delete(record.session.id);
      throw new DirectAuthError("limit", "Session action budget is exhausted");
    }
    record.actionsRemaining -= 1;
    return { ...record.session };
  }

  close(sessionId: string): void { this.sessions.delete(sessionId); }

  sweep(): void {
    const current = this.now().getTime();
    for (const [id, record] of this.sessions) if (Date.parse(record.session.expiresAt) <= current) this.sessions.delete(id);
  }

  async shutdown(): Promise<void> { this.closed = true; this.sessions.clear(); }

  private async requireMembership(organizationId: string, actorId: string): Promise<number> {
    try {
      const evidence = await this.options.organizationPrecondition.require({ organizationId, actorId });
      const expiresAt = Date.parse(evidence.expiresAt);
      return Number.isFinite(expiresAt) ? expiresAt : this.now().getTime() + EVIDENCE_TTL_MS;
    } catch (error: unknown) {
      if (error instanceof CollaborationAuthorizationError) {
        throw new DirectAuthError(error.code === "unavailable" ? "unavailable" : "denied", "Owner runtime membership is required");
      }
      throw error;
    }
  }
}

function denied(): DirectAuthError { return new DirectAuthError("denied", "Owner runtime access is required"); }
function unavailable(): DirectAuthError { return new DirectAuthError("unavailable", "Owner runtime sessions are unavailable"); }
function invalidSignature(): DirectAuthError { return new DirectAuthError("invalid_signature", "Request proof is invalid"); }
