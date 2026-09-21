/**
 * Control stream (S05 / T026, T028).
 *
 * Homes hold one authenticated WebSocket to the platform over which the
 * control authority pushes signed assertions (denials, generations) and
 * receives fence acknowledgements. The stream carries no customer payload.
 * Admission needs the enrolled runtime identity plus a one-use, short-lived
 * upgrade ticket handed out by the registration route. Every attached socket
 * receives a periodic `generation` keepalive (at most every 10 s) that the
 * home acknowledges; the acknowledgement is the liveness signal the ticket
 * issuer reads. Connections and pending tickets are bounded; shutdown drains
 * every connection.
 */
import { randomBytes } from "node:crypto";

/** Thrown when this instance does not hold the runtime's socket; another instance may. */
export class ControlStreamNotConnectedError extends Error {
  constructor(runtimeId: string) {
    super(`Runtime ${runtimeId} is not connected to this control stream instance`);
    this.name = "ControlStreamNotConnectedError";
  }
}

/** Shared one-use upgrade ticket store (Postgres) so any instance can admit a ticket another issued. */
export interface ControlUpgradeTicketStore {
  issueControlTicket(runtimeId: string, token: string, expiresAt: Date): Promise<void>;
  consumeControlTicket(token: string, runtimeId: string): Promise<boolean>;
}
import {
  COLLABORATION_DIRECT_LIMITS,
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  CollaborationControlAckSchema,
  CollaborationControlAssertionSchema,
  type CollaborationControlAck,
  type CollaborationControlAssertion,
} from "@matrix-os/contracts";

const DEFAULT_TICKET_TTL_MS = COLLABORATION_DIRECT_LIMITS.ticketTtlSeconds * 1_000;
const DEFAULT_MAX_CONNECTIONS = 4_096;
const MAX_FRAME_BYTES = COLLABORATION_DIRECT_LIMITS.wsFrameBytes;
/**
 * Keepalive period: half the home's evidence refresh target so the home's
 * fixed control snapshot (organizationEvidenceTtlSeconds) is refreshed by an
 * inbound frame well before it lapses, and the home's acknowledgement keeps
 * `last_control_at` inside the issuer's liveness window.
 */
const DEFAULT_KEEPALIVE_INTERVAL_MS = COLLABORATION_DIRECT_LIMITS.evidenceRefreshTargetSeconds * 1_000;
const MAX_KEEPALIVE_INTERVAL_MS = 10_000;
/** Acknowledgements queued per connection while the authority is slow; one more closes the socket. */
const MAX_PENDING_FRAMES = 32;

export interface ControlSocket {
  send(value: string): void;
  close(code?: number, reason?: string): void;
}

export interface ControlConnection {
  runtimeId: string;
  /** Feeds one inbound frame; rejects invalid frames so the caller can close the socket. */
  receive(raw: string): Promise<void>;
  /** Records an authenticated heartbeat only while this socket is the current runtime connection. */
  heartbeat(): void;
  close(): void;
}

export interface ControlAuthorityPort {
  registerTransport(transport: (runtimeId: string, assertion: CollaborationControlAssertion) => Promise<void>, connectedRuntimes?: () => readonly string[]): void;
  acknowledge(authenticatedRuntimeId: string, ack: CollaborationControlAck): Promise<{ completedDenialIds: string[] }>;
}

export class CollaborationControlStream {
  static readonly MAX_PENDING_FRAMES = MAX_PENDING_FRAMES;
  private readonly now: () => Date;
  private readonly ticketTtlMs: number;
  private readonly maxConnections: number;
  private readonly connections = new Map<string, { socket: ControlSocket; generation: number; pending: number; inbound: Promise<void>; close(): void }>();
  /** Frame chains still running after their connection closed; shutdown drains them. */
  private readonly draining = new Set<Promise<void>>();
  private closed = false;
  private readonly createToken: () => string;
  private readonly controlAuthority: ControlAuthorityPort;
  private readonly tickets: ControlUpgradeTicketStore;
  private readonly onAttach: ((runtimeId: string) => Promise<void>) | undefined;
  private readonly keepaliveIntervalMs: number;
  private readonly authorityGeneration: ((runtimeId: string) => Promise<number | null>) | undefined;

  constructor(options: {
    controlAuthority: ControlAuthorityPort;
    /** Postgres-backed so a ticket issued by one platform instance admits on any instance. */
    tickets: ControlUpgradeTicketStore;
    /** Liveness hook (attach and acknowledgement); the ticket issuer reads it as home health. */
    onAttach?(runtimeId: string): Promise<void>;
    /**
     * Periodic `generation` keepalive per attached socket (at most every 10 s). The home
     * acknowledges it, which refreshes its control snapshot and this side's liveness.
     * `authorityGeneration` reads the runtime's recorded generation once at attach.
     */
    keepalive?: { intervalMs?: number; authorityGeneration(runtimeId: string): Promise<number | null> };
    now?: () => Date;
    ticketTtlMs?: number;
    maxConnections?: number;
    createToken?: () => string;
  }) {
    this.now = options.now ?? (() => new Date());
    this.ticketTtlMs = options.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS;
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.createToken = options.createToken ?? (() => randomBytes(32).toString("base64url"));
    this.controlAuthority = options.controlAuthority;
    this.tickets = options.tickets;
    this.onAttach = options.onAttach;
    this.keepaliveIntervalMs = Math.min(MAX_KEEPALIVE_INTERVAL_MS, Math.max(1, options.keepalive?.intervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS));
    this.authorityGeneration = options.keepalive?.authorityGeneration;
    options.controlAuthority.registerTransport((runtimeId, assertion) => this.deliver(runtimeId, assertion), () => this.connectedRuntimes());
  }

  /** One-use ticket a freshly registered runtime presents on the control upgrade; stored, never kept in memory. */
  async issueUpgradeTicket(runtimeId: string): Promise<string> {
    if (this.closed) throw new Error("Control stream is shutting down");
    const token = this.createToken();
    await this.tickets.issueControlTicket(runtimeId, token, new Date(this.now().getTime() + this.ticketTtlMs));
    return token;
  }

  /** Atomic single consumption in the shared store: a replay on any instance fails. */
  consumeUpgradeTicket(token: string, runtimeId: string): Promise<boolean> {
    return this.tickets.consumeControlTicket(token, runtimeId);
  }

  /** Binds an admitted socket; a second connection for the same runtime replaces the first. */
  attach(runtimeId: string, socket: ControlSocket): ControlConnection {
    if (this.closed) throw new Error("Control stream is shutting down");
    const previous = this.connections.get(runtimeId);
    if (previous) previous.close();
    if (this.connections.size >= this.maxConnections) throw new Error("Control stream connection limit reached");
    let keepalive: ReturnType<typeof setInterval> | undefined;
    const entry = {
      socket,
      generation: 1,
      pending: 0,
      inbound: Promise.resolve(),
      close: () => {
        if (keepalive) clearInterval(keepalive);
        keepalive = undefined;
        if (this.connections.get(runtimeId) === entry) this.connections.delete(runtimeId);
        if (entry.pending > 0) {
          const chain = entry.inbound;
          this.draining.add(chain);
          void chain.finally(() => { this.draining.delete(chain); });
        }
        try {
          socket.close(1001, "Control stream closed");
        } catch (error: unknown) {
          console.warn("[collaboration-control-stream] socket close failed", error instanceof Error ? error.name : "UnknownError");
        }
      },
    };
    this.connections.set(runtimeId, entry);
    this.touch(runtimeId);
    if (this.authorityGeneration) {
      this.authorityGeneration(runtimeId).then((generation) => {
        if (generation !== null && generation > entry.generation) entry.generation = generation;
      }).catch((error: unknown) => {
        console.warn("[collaboration-control-stream] generation lookup failed", error instanceof Error ? error.name : "UnknownError");
      });
      keepalive = setInterval(() => {
        if (this.closed || this.connections.get(runtimeId) !== entry) {
          entry.close();
          return;
        }
        this.deliver(runtimeId, { protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, type: "generation", runtimeId, authorityGeneration: entry.generation })
          .catch((error: unknown) => {
            console.warn("[collaboration-control-stream] keepalive failed", error instanceof Error ? error.name : "UnknownError");
          });
      }, this.keepaliveIntervalMs);
      keepalive.unref?.();
    }
    return {
      runtimeId,
      receive: (raw) => {
        if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) return Promise.reject(new Error("Control frame too large"));
        if (entry.pending >= MAX_PENDING_FRAMES) return Promise.reject(new Error("Too many pending control frames"));
        // Frames are applied in order, one at a time per connection, so a slow authority
        // never fans out into unbounded concurrent transactions.
        entry.pending += 1;
        const run = entry.inbound.then(async () => {
          const ack = CollaborationControlAckSchema.parse(JSON.parse(raw) as unknown);
          if (ack.runtimeId !== runtimeId) throw new Error("Control acknowledgement runtime mismatch");
          await this.controlAuthority.acknowledge(runtimeId, ack);
          this.touch(runtimeId);
        });
        entry.inbound = run.catch((error: unknown) => {
          console.warn("[collaboration-control-stream] frame failed", error instanceof Error ? error.name : "UnknownError");
        }).finally(() => { entry.pending -= 1; });
        return run;
      },
      heartbeat: () => {
        if (!this.closed && this.connections.get(runtimeId) === entry) this.touch(runtimeId);
      },
      close: () => entry.close(),
    };
  }

  /**
   * Delivers to the socket this instance holds. Another instance may hold
   * it: the control authority treats the not-connected error as "not mine"
   * and leaves the delivery due for whichever instance has the socket.
   */
  async deliver(runtimeId: string, assertion: CollaborationControlAssertion): Promise<void> {
    const entry = this.connections.get(runtimeId);
    if (!entry) throw new ControlStreamNotConnectedError(runtimeId);
    const frame = JSON.stringify(CollaborationControlAssertionSchema.parse(assertion));
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new Error("Control frame too large");
    if (assertion.type === "generation" && assertion.runtimeId === runtimeId && assertion.authorityGeneration > entry.generation) {
      entry.generation = assertion.authorityGeneration;
    }
    try {
      entry.socket.send(frame);
    } catch (error: unknown) {
      entry.close();
      throw error;
    }
  }

  connectedRuntimes(): string[] {
    return [...this.connections.keys()];
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const entry of [...this.connections.values()]) entry.close();
    this.connections.clear();
    // Admitted acknowledgement work finishes before the stream reports shut down.
    await Promise.allSettled([...this.draining]);
  }

  private touch(runtimeId: string): void {
    this.onAttach?.(runtimeId).catch((error: unknown) => {
      console.warn("[collaboration-control-stream] liveness update failed", error instanceof Error ? error.name : "UnknownError");
    });
  }
}
