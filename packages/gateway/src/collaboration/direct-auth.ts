/**
 * Ticket verification on the home (S05 / T027).
 *
 * A connection ticket is verified identically whichever ingress delivered
 * it: known platform signing key, exact Ed25519 signature over the canonical
 * ticket, current protocol version, this home's logical runtime id and
 * current authority generation, a lifetime within the ticket TTL plus a
 * small skew allowance, and a single use. Proof of possession binds the
 * client's ephemeral key to the ticket's thumbprint. The replay cache is
 * bounded; when it cannot safely retain a nonce it refuses admission.
 */
import {
  COLLABORATION_DIRECT_LIMITS,
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  CollaborationClientOriginSchema,
  CollaborationSignedConnectionTicketSchema,
  type CollaborationConnectionTicket,
  CollaborationSignedOwnerRuntimeTicketSchema,
  type CollaborationOwnerRuntimeTicket,
  toLogicalRuntimeId,
} from "@matrix-os/contracts";
import { possessionPayload, proofKeyThumbprint, ticketSigningPayload, verifyEd25519 } from "./direct-crypto.js";

export type DirectAuthErrorCode =
  | "invalid_ticket"
  | "upgrade_required"
  | "stale_generation"
  | "replayed"
  | "invalid_origin"
  | "invalid_signature"
  | "expired"
  | "denied"
  | "limit"
  | "unavailable";

export class DirectAuthError extends Error {
  constructor(public readonly code: DirectAuthErrorCode, message: string) {
    super(message);
    this.name = "DirectAuthError";
  }
}

export interface DirectSigningKey {
  keyId: string;
  algorithm: "ed25519";
  publicKey: string;
}

const SKEW_MS = COLLABORATION_DIRECT_LIMITS.clockSkewSeconds * 1_000;
const TICKET_TTL_MS = COLLABORATION_DIRECT_LIMITS.ticketTtlSeconds * 1_000;

/** Single-use nonce window: TTL expiry first, then LRU; refuses when it cannot retain safely. */
export class DirectReplayCache {
  private readonly entries = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly now: () => Date;

  constructor(options: { maxEntries?: number; now?: () => Date } = {}) {
    this.maxEntries = options.maxEntries ?? COLLABORATION_DIRECT_LIMITS.replayCacheEntries;
    this.now = options.now ?? (() => new Date());
  }

  admit(key: string, expiresAtMs: number): "admitted" | "replayed" | "unretainable" {
    const current = this.now().getTime();
    for (const [existing, expiry] of this.entries) if (expiry <= current) this.entries.delete(existing);
    if (this.entries.has(key)) return "replayed";
    if (this.entries.size >= this.maxEntries) return "unretainable";
    this.entries.set(key, expiresAtMs);
    return "admitted";
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export class DirectTicketVerifier {
  private readonly now: () => Date;
  private readonly logicalRuntimeId: string;
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(private readonly options: {
    /** Enrolled runtime id (`vps:<uuid>`) or an already logical id. */
    runtimeId: string;
    platformKeys(): readonly DirectSigningKey[];
    /** True while the last control snapshot is inside its fixed lifetime; stale control denies every exchange. */
    controlFresh(): boolean;
    allowedClientOrigins: readonly string[];
    replay: DirectReplayCache;
    now?: () => Date;
  }) {
    this.now = options.now ?? (() => new Date());
    this.logicalRuntimeId = toLogicalRuntimeId(options.runtimeId);
    this.allowedOrigins = new Set(options.allowedClientOrigins);
  }

  runtimeId(): string {
    return this.logicalRuntimeId;
  }

  /** Verifies signature, binding and lifetime; does not consume the nonce. */
  verifyTicket(signedTicket: unknown): CollaborationConnectionTicket {
    const version = (signedTicket as { ticket?: { protocolVersion?: unknown } } | null)?.ticket?.protocolVersion;
    if (typeof version === "number" && version !== COLLABORATION_DIRECT_PROTOCOL_VERSION) {
      throw new DirectAuthError("upgrade_required", "Collaboration protocol version is not supported");
    }
    const parsed = CollaborationSignedConnectionTicketSchema.safeParse(signedTicket);
    if (!parsed.success) throw invalidTicket();
    if (!this.options.controlFresh()) throw new DirectAuthError("unavailable", "Control snapshot is stale");
    const { ticket, keyId, signature } = parsed.data;
    const key = this.options.platformKeys().find((entry) => entry.keyId === keyId && entry.algorithm === "ed25519");
    if (!key || !verifyEd25519(key.publicKey, ticketSigningPayload(ticket), signature)) throw invalidTicket();
    if (ticket.runtime.runtimeId !== this.logicalRuntimeId) throw invalidTicket();
    // The ticket binds the resource's own authority generation; the session service compares it with the scope.
    const current = this.now().getTime();
    const issuedAt = Date.parse(ticket.issuedAt);
    const expiresAt = Date.parse(ticket.expiresAt);
    if (issuedAt > current + SKEW_MS || expiresAt <= current || expiresAt - issuedAt > TICKET_TTL_MS) throw invalidTicket();
    return ticket;
  }

  /** Same signature, runtime and expiry checks for the distinct scope-free owner setup ticket. */
  verifyOwnerRuntimeTicket(signedTicket: unknown): CollaborationOwnerRuntimeTicket {
    const version = (signedTicket as { ticket?: { protocolVersion?: unknown } } | null)?.ticket?.protocolVersion;
    if (typeof version === "number" && version !== COLLABORATION_DIRECT_PROTOCOL_VERSION) {
      throw new DirectAuthError("upgrade_required", "Collaboration protocol version is not supported");
    }
    const parsed = CollaborationSignedOwnerRuntimeTicketSchema.safeParse(signedTicket);
    if (!parsed.success) throw invalidTicket();
    if (!this.options.controlFresh()) throw new DirectAuthError("unavailable", "Control snapshot is stale");
    const { ticket, keyId, signature } = parsed.data;
    const key = this.options.platformKeys().find((entry) => entry.keyId === keyId && entry.algorithm === "ed25519");
    if (!key || !verifyEd25519(key.publicKey, ticketSigningPayload(ticket), signature)) throw invalidTicket();
    if (ticket.runtime.runtimeId !== this.logicalRuntimeId) throw invalidTicket();
    const current = this.now().getTime();
    const issuedAt = Date.parse(ticket.issuedAt);
    const expiresAt = Date.parse(ticket.expiresAt);
    if (issuedAt > current + SKEW_MS || expiresAt <= current || expiresAt - issuedAt > TICKET_TTL_MS) throw invalidTicket();
    return ticket;
  }

  /** Consumes the ticket nonce exactly once. */
  consume(ticket: Pick<CollaborationConnectionTicket, "nonce" | "expiresAt">): void {
    const outcome = this.options.replay.admit(`ticket:${ticket.nonce}`, Date.parse(ticket.expiresAt) + SKEW_MS);
    if (outcome === "replayed") throw new DirectAuthError("replayed", "Ticket was already used");
    if (outcome === "unretainable") throw new DirectAuthError("unavailable", "Replay protection is at capacity");
  }

  admitRequestNonce(sessionId: string, nonce: string, expiresAtMs: number): void {
    const outcome = this.options.replay.admit(`request:${sessionId}:${nonce}`, expiresAtMs);
    if (outcome === "replayed") throw new DirectAuthError("replayed", "Request nonce was already used");
    if (outcome === "unretainable") throw new DirectAuthError("unavailable", "Replay protection is at capacity");
  }

  verifyPossession(input: { ticket: { nonce: string; purpose: string; expiresAt: string; proofKeyThumbprint: string }; proofPublicKey: string; possession: string; sessionId?: string }): void {
    // Possession is proven at consumption time, which may be later than verification: the ticket must still be live.
    if (Date.parse(input.ticket.expiresAt) <= this.now().getTime()) throw invalidTicket();
    if (proofKeyThumbprint(input.proofPublicKey) !== input.ticket.proofKeyThumbprint) throw invalidTicket();
    const payload = possessionPayload({ ticketNonce: input.ticket.nonce, purpose: input.ticket.purpose, ...(input.sessionId ? { sessionId: input.sessionId } : {}) });
    if (!verifyEd25519(input.proofPublicKey, payload, input.possession)) throw invalidTicket();
  }

  requireClientOrigin(origin: unknown): string {
    const parsed = CollaborationClientOriginSchema.safeParse(origin);
    if (!parsed.success || !this.allowedOrigins.has(parsed.data)) {
      throw new DirectAuthError("invalid_origin", "Client origin is not allowed");
    }
    return parsed.data;
  }
}

function invalidTicket(): DirectAuthError {
  return new DirectAuthError("invalid_ticket", "Connection ticket is invalid");
}
