/**
 * Direct identity sessions on the home (S05 / T027, T028).
 *
 * A ticket is exchanged exactly once for a session that lives at most five
 * minutes and carries organization evidence with its own fixed deadline.
 * Every request is signed against the session and its proof key; every
 * authorization re-runs the local authority. Evidence is refreshed through
 * the organization precondition at its deadline, never from receipt time.
 * Sessions end on expiry, evidence loss, platform denial, explicit close or
 * shutdown. Connections are counted per home, scope and actor.
 */
import { randomUUID } from "node:crypto";
import {
  COLLABORATION_DIRECT_LIMITS,
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  CollaborationDirectRequestSignatureSchema,
  CollaborationDirectSessionRenewRequestSchema,
  CollaborationDirectSessionRequestSchema,
  CollaborationDirectSessionSchema,
  type CollaborationConnectionTicket,
  type CollaborationDenial,
  type CollaborationDirectSession,
} from "@matrix-os/contracts";
import { CollaborationAuthorizationError } from "./authority-error.js";
import type { AuthorizedCollaborationContext, CollaborationAction, CollaborationAuthority } from "./authority.js";
import { DirectAuthError, type DirectTicketVerifier } from "./direct-auth.js";
import { requestSigningPayload, sha256Hex, verifyEd25519 } from "./direct-crypto.js";
import type { CollaborationRepository } from "./repository.js";

const SESSION_TTL_MS = COLLABORATION_DIRECT_LIMITS.identitySessionTtlSeconds * 1_000;
const EVIDENCE_TTL_MS = COLLABORATION_DIRECT_LIMITS.organizationEvidenceTtlSeconds * 1_000;
const RENEW_AFTER_MS = SESSION_TTL_MS - 60_000;
const REQUEST_WINDOW_MS = COLLABORATION_DIRECT_LIMITS.ticketTtlSeconds * 1_000;
const SKEW_MS = COLLABORATION_DIRECT_LIMITS.clockSkewSeconds * 1_000;
const MAX_SESSIONS = 4_096;
const SWEEP_INTERVAL_MS = COLLABORATION_DIRECT_LIMITS.streamWatchdogSeconds * 1_000;

interface SessionRecord {
  session: CollaborationDirectSession;
  proofPublicKey: string;
  connections: number;
  /** Signed `maxActions` from the admitting ticket; every authorized request or stream input spends one. */
  actionsRemaining: number;
  pendingActions: number;
  budgetVersion: number;
}

export type DirectSessionEndReason = "expired" | "denied" | "revoked" | "closed" | "shutdown" | "exhausted";
export type DirectSessionEndedListener = (session: CollaborationDirectSession, reason: DirectSessionEndReason) => void;

export interface DirectConnectionLimits {
  perHome: number;
  perScope: number;
  perActorScope: number;
}

export interface DirectAuthorizeInput {
  sessionId: string;
  signature: unknown;
  proof: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query: string;
  body: Uint8Array;
  conditionalHeadersDigest?: string;
  action: CollaborationAction;
}

export class DirectSessionService {
  private readonly now: () => Date;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly scopeConnections = new Map<string, number>();
  private readonly actorScopeConnections = new Map<string, number>();
  private homeConnections = 0;
  private closed = false;
  private readonly limits: DirectConnectionLimits;
  private readonly sweepTimer: ReturnType<typeof setInterval> | undefined;
  private readonly endedListeners = new Set<DirectSessionEndedListener>();

  constructor(private readonly options: {
    verifier: DirectTicketVerifier;
    authority: CollaborationAuthority;
    repository: CollaborationRepository;
    now?: () => Date;
    limits?: Partial<DirectConnectionLimits>;
    /** Called when a session ends for any reason so streams can be closed. */
    onEnded?: DirectSessionEndedListener;
    /** Called only after a fresh verified session is stored or renewed. */
    onAdmitted?: (session: CollaborationDirectSession) => void;
    startTimers?: boolean;
  }) {
    this.now = options.now ?? (() => new Date());
    this.limits = {
      perHome: options.limits?.perHome ?? COLLABORATION_DIRECT_LIMITS.connectionsPerHome,
      perScope: options.limits?.perScope ?? COLLABORATION_DIRECT_LIMITS.connectionsPerScope,
      perActorScope: options.limits?.perActorScope ?? COLLABORATION_DIRECT_LIMITS.connectionsPerActorScope,
    };
    if (options.startTimers) {
      this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
    }
  }

  /** `POST /api/collaboration/direct-sessions`: one-use ticket exchange with proof of possession. */
  async create(request: unknown): Promise<CollaborationDirectSession> {
    if (this.closed) throw new DirectAuthError("unavailable", "Direct sessions are shutting down");
    assertProtocolVersion(request);
    const parsed = CollaborationDirectSessionRequestSchema.safeParse(request);
    if (!parsed.success) throw new DirectAuthError("invalid_ticket", "Session request is invalid");
    const ticket = this.options.verifier.verifyTicket(parsed.data.signedTicket);
    if (ticket.purpose !== "direct_session") throw new DirectAuthError("invalid_ticket", "Ticket purpose does not admit a session");
    this.options.verifier.requireClientOrigin(parsed.data.clientOrigin);
    this.options.verifier.verifyPossession({ ticket, proofPublicKey: parsed.data.proofPublicKey, possession: parsed.data.possession });
    const evidenceExpiresAt = await this.admit(ticket);
    this.options.verifier.consume(ticket);
    if (this.sessions.size >= MAX_SESSIONS) this.sweep();
    if (this.sessions.size >= MAX_SESSIONS) throw new DirectAuthError("limit", "Too many direct sessions");
    const issuedAt = this.now();
    const session = CollaborationDirectSessionSchema.parse({
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
      id: randomUUID(),
      actorId: ticket.actorId,
      organizationId: ticket.organizationId,
      scopeId: ticket.resource.scopeId,
      ...(ticket.resource.pendingGrantId ? { pendingGrantId: ticket.resource.pendingGrantId } : {}),
      runtimeId: ticket.runtime.runtimeId,
      authorityGeneration: ticket.runtime.authorityGeneration,
      purpose: ticket.purpose,
      proofKeyThumbprint: ticket.proofKeyThumbprint,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + SESSION_TTL_MS).toISOString(),
      evidenceExpiresAt: new Date(Math.min(evidenceExpiresAt, issuedAt.getTime() + EVIDENCE_TTL_MS)).toISOString(),
      renewAfter: new Date(issuedAt.getTime() + RENEW_AFTER_MS).toISOString(),
    });
    this.sessions.set(session.id, { session, proofPublicKey: parsed.data.proofPublicKey, connections: 0, actionsRemaining: ticket.maxActions, pendingActions: 0, budgetVersion: 0 });
    this.notifyAdmitted(session);
    return session;
  }

  /** Streams and registries subscribe so a denial closes their sockets immediately. */
  subscribeEnded(listener: DirectSessionEndedListener): () => void {
    this.endedListeners.add(listener);
    return () => { this.endedListeners.delete(listener); };
  }

  /** `POST /api/collaboration/direct-sessions/:id/renew`: a fresh ticket for the same actor, scope and proof key. */
  async renew(sessionId: string, request: unknown): Promise<CollaborationDirectSession> {
    const record = this.live(sessionId);
    assertProtocolVersion(request);
    const parsed = CollaborationDirectSessionRenewRequestSchema.safeParse(request);
    if (!parsed.success) throw new DirectAuthError("invalid_ticket", "Renewal request is invalid");
    const ticket = this.options.verifier.verifyTicket(parsed.data.signedTicket);
    if (ticket.purpose !== "direct_session" || ticket.actorId !== record.session.actorId || ticket.resource.scopeId !== record.session.scopeId
      || ticket.resource.pendingGrantId !== record.session.pendingGrantId
      || ticket.organizationId !== record.session.organizationId || ticket.proofKeyThumbprint !== record.session.proofKeyThumbprint) {
      throw new DirectAuthError("invalid_ticket", "Renewal ticket does not match the session");
    }
    const evidenceExpiresAt = await this.admit(ticket);
    this.options.verifier.consume(ticket);
    const issuedAt = this.now();
    const session = CollaborationDirectSessionSchema.parse({
      ...record.session,
      authorityGeneration: ticket.runtime.authorityGeneration,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + SESSION_TTL_MS).toISOString(),
      evidenceExpiresAt: new Date(Math.min(evidenceExpiresAt, issuedAt.getTime() + EVIDENCE_TTL_MS)).toISOString(),
      renewAfter: new Date(issuedAt.getTime() + RENEW_AFTER_MS).toISOString(),
    });
    record.session = session;
    record.actionsRemaining = ticket.maxActions;
    record.pendingActions = 0;
    record.budgetVersion += 1;
    this.notifyAdmitted(session);
    return session;
  }

  close(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record) this.end(record, "closed");
  }

  describe(sessionId: string): CollaborationDirectSession | null {
    const record = this.sessions.get(sessionId);
    if (!record) return null;
    return Date.parse(record.session.expiresAt) > this.now().getTime() ? { ...record.session } : null;
  }

  /** Verifies a signed request and returns the live session with fresh evidence. */
  async authenticate(input: Omit<DirectAuthorizeInput, "action">): Promise<CollaborationDirectSession> {
    const record = this.live(input.sessionId);
    const parsed = CollaborationDirectRequestSignatureSchema.safeParse(input.signature);
    if (!parsed.success || parsed.data.sessionId !== input.sessionId) throw new DirectAuthError("invalid_signature", "Request signature is invalid");
    const signature = parsed.data;
    const current = this.now().getTime();
    const issuedAt = Date.parse(signature.issuedAt);
    if (issuedAt > current + SKEW_MS || current - issuedAt > REQUEST_WINDOW_MS) throw new DirectAuthError("invalid_signature", "Request signature is stale");
    if (signature.method !== input.method || signature.path !== input.path || signature.query !== input.query
      || signature.bodyDigest !== sha256Hex(input.body)
      || signature.conditionalHeadersDigest !== (input.conditionalHeadersDigest ?? sha256Hex(new Uint8Array()))) {
      throw new DirectAuthError("invalid_signature", "Request signature does not match the request");
    }
    if (!verifyEd25519(record.proofPublicKey, requestSigningPayload(signature), input.proof)) {
      throw new DirectAuthError("invalid_signature", "Request proof is invalid");
    }
    this.options.verifier.admitRequestNonce(record.session.id, signature.nonce, issuedAt + REQUEST_WINDOW_MS + SKEW_MS);
    await this.refreshEvidence(record);
    return { ...record.session };
  }

  /** Charges one action from the ticket-signed budget; exhaustion ends the session. */
  spend(record: SessionRecord): void {
    if (record.actionsRemaining <= 0) {
      if (record.pendingActions === 0) this.end(record, "exhausted");
      throw new DirectAuthError("limit", "Session action budget is exhausted");
    }
    record.actionsRemaining -= 1;
  }

  /** Charge a signed operation that authenticates without a local authority action (session close). */
  spendAuthenticatedAction(sessionId: string): void {
    this.spend(this.live(sessionId));
  }

  /** Reserve before asynchronous stream work; rejected local work returns its action to the same live budget. */
  async runStreamInput<T>(sessionId: string, action: () => Promise<T> | T): Promise<T> {
    const reservation = this.reserve(this.live(sessionId));
    try {
      const result = await action();
      reservation.commit();
      return result;
    } catch (error: unknown) {
      reservation.rollback();
      throw error;
    }
  }

  actionsRemaining(sessionId: string): number | null {
    return this.sessions.get(sessionId)?.actionsRemaining ?? null;
  }

  async authorize(input: DirectAuthorizeInput): Promise<AuthorizedCollaborationContext> {
    const session = await this.authenticate(input);
    if (session.pendingGrantId) throw new DirectAuthError("invalid_signature", "Pending grant sessions only permit acceptance");
    let context: AuthorizedCollaborationContext;
    try {
      context = await this.options.authority.authorize({ scopeId: session.scopeId, actorId: session.actorId, action: input.action });
    } catch (error: unknown) {
      if (error instanceof CollaborationAuthorizationError) {
        throw new DirectAuthError(error.code === "unavailable" ? "unavailable" : "invalid_signature", "Session does not permit this action");
      }
      throw error;
    }
    if (context.authorityGeneration !== session.authorityGeneration) {
      const record = this.sessions.get(session.id);
      if (record) this.end(record, "expired");
      throw new DirectAuthError("expired", "Authority generation changed");
    }
    this.spend(this.live(session.id));
    return context;
  }

  /**
   * Stream admission (events/terminal): a purpose ticket verified by the
   * caller, a first-frame handshake proving possession of the session's key,
   * one-use consumption of the ticket, fresh evidence and a counted connection.
   */
  async openStream(input: {
    ticket: CollaborationConnectionTicket;
    handshake: { sessionId: string; ticketNonce: string; possession: string };
  }): Promise<{ session: CollaborationDirectSession; context: AuthorizedCollaborationContext; commitAdmission(): void; release(): void }> {
    const record = this.live(input.handshake.sessionId);
    const { ticket } = input;
    if (ticket.nonce !== input.handshake.ticketNonce || ticket.actorId !== record.session.actorId
      || ticket.resource.scopeId !== record.session.scopeId || ticket.organizationId !== record.session.organizationId
      || ticket.proofKeyThumbprint !== record.session.proofKeyThumbprint || ticket.purpose === "direct_session") {
      throw new DirectAuthError("invalid_ticket", "Stream ticket does not match the session");
    }
    if (Date.parse(ticket.expiresAt) <= this.now().getTime()) throw new DirectAuthError("invalid_ticket", "Stream ticket has expired");
    this.options.verifier.verifyPossession({ ticket, proofPublicKey: record.proofPublicKey, possession: input.handshake.possession, sessionId: record.session.id });
    this.options.verifier.consume(ticket);
    await this.refreshEvidence(record);
    let context: AuthorizedCollaborationContext;
    try {
      context = await this.options.authority.authorize({ scopeId: record.session.scopeId, actorId: record.session.actorId, action: "read" });
    } catch (error: unknown) {
      if (error instanceof CollaborationAuthorizationError) throw new DirectAuthError(error.code === "unavailable" ? "unavailable" : "denied", "Stream access is unavailable");
      throw error;
    }
    if (context.authorityGeneration !== record.session.authorityGeneration) {
      this.end(record, "expired");
      throw new DirectAuthError("expired", "Authority generation changed");
    }
    if (context.resourceKind !== ticket.resource.kind || (ticket.purpose === "terminal" && context.resourceKind !== "terminal")) throw denied();
    const connection = this.connections.open({ sessionId: record.session.id });
    let reservation: ReturnType<DirectSessionService["reserve"]>;
    try {
      reservation = this.reserve(this.live(record.session.id));
    } catch (error: unknown) {
      connection.release();
      throw error;
    }
    return {
      session: { ...record.session }, context,
      commitAdmission: reservation.commit,
      release: () => { reservation.rollback(); connection.release(); },
    };
  }

  /** Ends every session the denial covers and reports their ids. */
  revoke(denial: Pick<CollaborationDenial, "organizationId" | "actorId" | "scopeId">): string[] {
    const ended: string[] = [];
    for (const record of [...this.sessions.values()]) {
      const { session } = record;
      if ((denial.actorId && session.actorId !== denial.actorId)
        || (denial.scopeId && session.scopeId !== denial.scopeId)
        || (denial.organizationId && session.organizationId !== denial.organizationId)) continue;
      this.end(record, "revoked");
      ended.push(session.id);
    }
    return ended;
  }

  /** Bounded stream admission (T028): per home, per scope, per actor and scope. */
  readonly connections = {
    open: (input: { sessionId: string }): { release(): void } => {
      const record = this.live(input.sessionId);
      const scopeKey = record.session.scopeId;
      const actorKey = `${record.session.scopeId}\u0000${record.session.actorId}`;
      if (this.homeConnections >= this.limits.perHome || (this.scopeConnections.get(scopeKey) ?? 0) >= this.limits.perScope
        || (this.actorScopeConnections.get(actorKey) ?? 0) >= this.limits.perActorScope) {
        throw new DirectAuthError("limit", "Connection limit reached");
      }
      this.homeConnections += 1;
      this.scopeConnections.set(scopeKey, (this.scopeConnections.get(scopeKey) ?? 0) + 1);
      this.actorScopeConnections.set(actorKey, (this.actorScopeConnections.get(actorKey) ?? 0) + 1);
      record.connections += 1;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          this.homeConnections = Math.max(0, this.homeConnections - 1);
          this.decrement(this.scopeConnections, scopeKey);
          this.decrement(this.actorScopeConnections, actorKey);
          record.connections = Math.max(0, record.connections - 1);
        },
      };
    },
  };

  sweep(): void {
    const current = this.now().getTime();
    for (const record of [...this.sessions.values()]) {
      if (Date.parse(record.session.expiresAt) <= current) this.end(record, "expired");
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const record of [...this.sessions.values()]) this.end(record, "shutdown");
    this.scopeConnections.clear();
    this.actorScopeConnections.clear();
    this.homeConnections = 0;
  }

  private live(sessionId: string): SessionRecord {
    if (this.closed) throw new DirectAuthError("unavailable", "Direct sessions are shutting down");
    const record = this.sessions.get(sessionId);
    if (!record) throw new DirectAuthError("expired", "Session is not active");
    if (Date.parse(record.session.expiresAt) <= this.now().getTime()) {
      this.end(record, "expired");
      throw new DirectAuthError("expired", "Session has expired");
    }
    return record;
  }

  private reserve(record: SessionRecord): { commit(): void; rollback(): void } {
    this.spend(record);
    record.pendingActions += 1;
    const version = record.budgetVersion;
    let pending = true;
    const settle = (refund: boolean) => {
      if (!pending) return;
      pending = false;
      if (this.sessions.get(record.session.id) !== record || record.budgetVersion !== version) return;
      record.pendingActions -= 1;
      if (refund) record.actionsRemaining += 1;
    };
    return { commit: () => settle(false), rollback: () => settle(true) };
  }

  /** Admission at exchange: scope exists on this home in the ticket's organization; actor is a member or an invitee; evidence is fresh. */
  private async admit(ticket: CollaborationConnectionTicket): Promise<number> {
    const scope = await this.options.repository.db.selectFrom("collaboration_scopes")
      .select(["id", "organization_id", "authority_runtime_id", "authority_generation", "kind", "membership_mode", "parent_scope_id", "deleted_at"])
      .where("id", "=", ticket.resource.scopeId).executeTakeFirst();
    if (!scope || scope.deleted_at !== null || scope.organization_id !== ticket.organizationId
      || scope.kind !== ticket.resource.kind || toLogical(scope.authority_runtime_id) !== ticket.runtime.runtimeId) throw denied();
    if (Number(scope.authority_generation) !== ticket.runtime.authorityGeneration) {
      throw new DirectAuthError("stale_generation", "Ticket generation does not match the resource");
    }
    const evidence = await this.evidenceFor(ticket.organizationId, ticket.actorId);
    const membershipScopeId = scope.membership_mode === "inherited" && scope.parent_scope_id ? scope.parent_scope_id : scope.id;
    if (ticket.resource.pendingGrantId) {
      if (ticket.purpose !== "direct_session") throw denied();
      const member = await this.options.repository.getMember(membershipScopeId, ticket.actorId);
      if (member?.status === "revoked" || member?.status === "expired") throw denied();
      const grant = await this.options.repository.db.selectFrom("collaboration_grants")
        .select(["scope_id", "organization_id", "audience_kind", "state", "expires_at"])
        .where("id", "=", ticket.resource.pendingGrantId).executeTakeFirst();
      if (!grant || grant.scope_id !== scope.id || grant.organization_id !== ticket.organizationId
        || grant.audience_kind !== "organization" || grant.state !== "active"
        || (grant.expires_at !== null && new Date(grant.expires_at).getTime() <= this.now().getTime())) throw denied();
      return evidence;
    }
    try {
      await this.options.authority.authorize({ scopeId: ticket.resource.scopeId, actorId: ticket.actorId, action: "read" });
      return evidence;
    } catch (error: unknown) {
      if (!(error instanceof CollaborationAuthorizationError) || error.code === "unavailable") throw denied();
    }
    // Not yet a participant: an invitee may open a direct session to accept, nothing more.
    if (ticket.purpose !== "direct_session") throw denied();
    const member = await this.options.repository.getMember(membershipScopeId, ticket.actorId);
    if (!member || member.status !== "pending") throw denied();
    return evidence;
  }

  private async evidenceFor(organizationId: string, actorId: string): Promise<number> {
    try {
      const evidence = await this.options.authority.organizationPrecondition.require({ organizationId, actorId });
      const expiresAt = Date.parse((evidence as { expiresAt?: string } | undefined)?.expiresAt ?? "");
      return Number.isFinite(expiresAt) ? expiresAt : this.now().getTime() + EVIDENCE_TTL_MS;
    } catch (error: unknown) {
      if (error instanceof CollaborationAuthorizationError) throw denied();
      throw error;
    }
  }

  private async refreshEvidence(record: SessionRecord): Promise<void> {
    if (Date.parse(record.session.evidenceExpiresAt) > this.now().getTime()) return;
    try {
      const expiresAt = await this.evidenceFor(record.session.organizationId, record.session.actorId);
      record.session = { ...record.session, evidenceExpiresAt: new Date(Math.min(expiresAt, Date.parse(record.session.expiresAt))).toISOString() };
    } catch (error: unknown) {
      this.end(record, "denied");
      throw error;
    }
  }

  private end(record: SessionRecord, reason: DirectSessionEndReason): void {
    if (!this.sessions.delete(record.session.id)) return;
    for (const listener of [this.options.onEnded, ...this.endedListeners]) {
      if (!listener) continue;
      try {
        listener(record.session, reason);
      } catch (error: unknown) {
        console.warn("[collaboration-direct-sessions] end hook failed", error instanceof Error ? error.name : "UnknownError");
      }
    }
  }

  private notifyAdmitted(session: CollaborationDirectSession): void {
    try {
      this.options.onAdmitted?.(session);
    } catch (error: unknown) {
      console.warn("[collaboration-direct-sessions] admission hook failed", error instanceof Error ? error.name : "UnknownError");
    }
  }

  private decrement(map: Map<string, number>, key: string): void {
    const next = (map.get(key) ?? 1) - 1;
    if (next <= 0) map.delete(key); else map.set(key, next);
  }
}

/** An old client is told to upgrade before any other validation runs. */
function assertProtocolVersion(request: unknown): void {
  const candidate = request as { protocolVersion?: unknown; signedTicket?: { ticket?: { protocolVersion?: unknown } } } | null;
  const outerVersion = candidate?.protocolVersion;
  const ticketVersion = candidate?.signedTicket?.ticket?.protocolVersion;
  if ((typeof outerVersion === "number" && outerVersion !== COLLABORATION_DIRECT_PROTOCOL_VERSION)
    || (typeof ticketVersion === "number" && ticketVersion !== COLLABORATION_DIRECT_PROTOCOL_VERSION)) {
    throw new DirectAuthError("upgrade_required", "Collaboration protocol version is not supported");
  }
}

function toLogical(runtimeId: string): string {
  const vps = /^vps:([0-9a-f-]{36})$/i.exec(runtimeId);
  return vps ? `vps-${vps[1]!.toLowerCase()}` : runtimeId;
}

function denied(): DirectAuthError {
  return new DirectAuthError("denied", "Current membership is required");
}
