/**
 * One-time transport tickets for the voice WebSocket upgrade.
 *
 * A ticket is a random secret minted after authenticated HTTP admission. The
 * server stores only an HMAC-SHA256 digest bound to
 * {principalId, chatId, sessionId, path, generation, expiry}; the raw ticket
 * is returned to the client exactly once and never logged or persisted.
 * Verification happens exclusively on the exact
 * `/ws/chats/:chatId/voice/:sessionId` upgrade path — these tickets are NOT
 * part of the generic query-token allowlist and are not bearer credentials
 * for canonical Chat routes.
 *
 * Rotation semantics follow the TransportLease model: minting for a session
 * supersedes every predecessor credential, the latest committed generation
 * wins, and consumption is atomic single-use. The in-process serialized
 * consume path below is correct for a single gateway instance; multi-instance
 * deployments MUST bind `VoiceTicketStore` to the DB-backed variant so
 * verify+consume stays atomic across replicas.
 *
 * Modelled on `collaboration/direct-auth.ts` (DirectTicketVerifier /
 * DirectReplayCache).
 */
import { createHmac, randomBytes } from "node:crypto";
import { timingSafeStringEquals } from "../security/timing-safe.js";

export type VoiceTicketState =
  | "minted"
  | "consumed"
  | "superseded"
  | "revoked"
  | "expired";

export type VoiceTicketErrorCode =
  | "invalid_ticket"
  | "expired"
  | "consumed"
  | "superseded"
  | "revoked"
  | "binding_mismatch"
  | "capacity";

export class VoiceTicketError extends Error {
  constructor(
    public readonly code: VoiceTicketErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VoiceTicketError";
  }
}

export interface VoiceTicketBinding {
  principalId: string;
  chatId: string;
  sessionId: string;
  /** Exact upgrade path the ticket is bound to — exact match, no pattern. */
  path: string;
  /** Monotonic credential/epoch generation for the session lease. */
  generation: number;
}

export interface MintedVoiceTicket {
  /** Raw secret returned to the client once; store nothing else. */
  ticket: string;
  expiresAtMs: number;
  generation: number;
}

export interface VoiceTicketConsumeResult {
  binding: VoiceTicketBinding;
  expiresAtMs: number;
}

interface VoiceTicketRecord {
  digest: string;
  binding: VoiceTicketBinding;
  state: VoiceTicketState;
  mintedAtMs: number;
  expiresAtMs: number;
}

const SAFE_TICKET = /^vt_[A-Za-z0-9_-]{32,128}$/;
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 4_096;
const SUPPORTED_BINDING_FIELDS = ["principalId", "chatId", "sessionId", "path", "generation"] as const;

function assertBinding(binding: VoiceTicketBinding): void {
  if (typeof binding !== "object" || binding === null) {
    throw new TypeError("ticket binding must be an object");
  }
  for (const key of Object.keys(binding)) {
    if (!(SUPPORTED_BINDING_FIELDS as readonly string[]).includes(key)) {
      throw new TypeError(`ticket binding field ${key} is not supported`);
    }
  }
  for (const field of ["principalId", "chatId", "sessionId", "path"] as const) {
    const value = binding[field];
    if (typeof value !== "string" || value.length === 0 || value.length > 512) {
      throw new TypeError(`ticket binding ${field} must be a bounded string`);
    }
    if (!/^[A-Za-z0-9_\/:.-]+$/.test(value)) {
      throw new TypeError(`ticket binding ${field} contains unsafe characters`);
    }
  }
  if (!binding.path.startsWith("/")) {
    throw new TypeError("ticket binding path must be an absolute route path");
  }
  if (!Number.isSafeInteger(binding.generation) || binding.generation <= 0) {
    throw new TypeError("ticket binding generation must be a positive integer");
  }
}

/**
 * Bounded ticket store. Records are keyed by HMAC digest — the raw ticket is
 * never retained — and single-use consumption is check-and-set inside one
 * synchronous call (no awaits), so it is atomic on a single gateway process.
 * Eviction prefers terminal-state and expired records; when no record can be
 * safely evicted the store refuses to mint rather than lose replay state.
 */
export class VoiceTicketAuthority {
  private readonly records = new Map<string, VoiceTicketRecord>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly key: Buffer;
  private readonly now: () => number;
  private readonly random: (bytes: number) => Uint8Array;

  constructor(options: {
    ttlMs?: number;
    maxEntries?: number;
    /** 32-byte HMAC key; generated in-process when omitted (dev/test only). */
    hmacKey?: Uint8Array;
    now?: () => number;
    random?: (bytes: number) => Uint8Array;
  } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.key = Buffer.from(options.hmacKey ?? randomBytes(32));
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? ((bytes) => randomBytes(bytes));
    if (!(this.ttlMs > 0) || this.ttlMs > 10 * 60_000) {
      throw new RangeError("voice ticket ttl must be within (0, 600s]");
    }
    if (this.key.length < 16) {
      throw new RangeError("voice ticket hmac key must be at least 16 bytes");
    }
  }

  private digest(ticket: string): string {
    return createHmac("sha256", this.key).update(ticket, "utf8").digest("hex");
  }

  /**
   * Mint a one-time ticket. Any predecessor credential for the same session
   * is superseded: the latest committed generation wins.
   */
  mint(binding: VoiceTicketBinding): MintedVoiceTicket {
    assertBinding(binding);
    this.sweepExpired();
    for (const record of this.records.values()) {
      if (record.binding.sessionId === binding.sessionId
        && (record.state === "minted" || record.state === "consumed")) {
        record.state = "superseded";
      }
    }
    this.assertCapacity();
    const ticket = `vt_${Buffer.from(this.random(32)).toString("base64url")}`;
    const expiresAtMs = this.now() + this.ttlMs;
    const record: VoiceTicketRecord = {
      digest: this.digest(ticket),
      binding: { ...binding },
      state: "minted",
      mintedAtMs: this.now(),
      expiresAtMs,
    };
    this.records.set(record.digest, record);
    return { ticket, expiresAtMs, generation: binding.generation };
  }

  /**
   * Verify + consume in one synchronous, atomic step. The `expected` fields
   * come from the verified request (route params + reconstructed path) —
   * never from client input; the returned binding supplies the trusted
   * principal the caller must use downstream.
   */
  consume(
    ticket: unknown,
    expected: { path: string; sessionId: string; chatId: string },
  ): VoiceTicketConsumeResult {
    if (typeof ticket !== "string" || !SAFE_TICKET.test(ticket)) {
      throw new VoiceTicketError("invalid_ticket", "Ticket is malformed");
    }
    const probe = this.digest(ticket);
    const record = this.records.get(probe);
    // Constant-time digest compare even though the map key is the digest:
    // keeps the verify shape identical to a DB-backed implementation.
    if (!record || !timingSafeStringEquals(record.digest, probe)) {
      throw new VoiceTicketError("invalid_ticket", "Ticket is not recognized");
    }
    if (record.expiresAtMs <= this.now()) {
      record.state = "expired";
      throw new VoiceTicketError("expired", "Ticket has expired");
    }
    if (record.state === "consumed") {
      throw new VoiceTicketError("consumed", "Ticket was already used");
    }
    if (record.state !== "minted") {
      throw new VoiceTicketError(record.state, `Ticket is ${record.state}`);
    }
    const { binding } = record;
    if (binding.path !== expected.path
      || binding.sessionId !== expected.sessionId
      || binding.chatId !== expected.chatId) {
      throw new VoiceTicketError("binding_mismatch", "Ticket does not match this upgrade");
    }
    record.state = "consumed";
    return { binding: { ...binding }, expiresAtMs: record.expiresAtMs };
  }

  /** State of the newest credential for a session (engine idempotency checks). */
  describeSession(sessionId: string): { generation: number; state: VoiceTicketState } | undefined {
    let newest: VoiceTicketRecord | undefined;
    for (const record of this.records.values()) {
      if (record.binding.sessionId !== sessionId) continue;
      if (!newest || record.binding.generation > newest.binding.generation) newest = record;
    }
    return newest && { generation: newest.binding.generation, state: newest.state };
  }

  /** Revoke every credential for a session (terminal cleanup path). */
  revokeSession(sessionId: string): void {
    for (const record of this.records.values()) {
      if (record.binding.sessionId === sessionId && record.state === "minted") {
        record.state = "revoked";
      }
    }
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [digest, record] of this.records) {
      if (record.expiresAtMs <= now) {
        if (record.state === "minted") record.state = "expired";
        this.records.delete(digest);
      }
    }
  }

  private assertCapacity(): void {
    if (this.records.size < this.maxEntries) return;
    for (const [digest, record] of this.records) {
      if (record.state !== "minted") this.records.delete(digest);
      if (this.records.size < this.maxEntries) return;
    }
    throw new VoiceTicketError("capacity", "Ticket store is at capacity");
  }

  clear(): void {
    this.records.clear();
  }

  get size(): number {
    return this.records.size;
  }
}

/**
 * Exact-match Origin allowlist for the upgrade path. `undefined` origins are
 * rejected unless `allowMissing` (non-browser clients); no wildcards ever.
 */
export function createVoiceOriginAllowlist(
  allowedOrigins: readonly string[],
  options: { allowMissing?: boolean } = {},
): (origin: string | undefined) => boolean {
  const allowed = new Set(allowedOrigins.filter((origin) => /^https?:\/\/[^/]+$/.test(origin)));
  return (origin) => {
    if (origin === undefined || origin === "") return options.allowMissing === true;
    return allowed.has(origin);
  };
}
