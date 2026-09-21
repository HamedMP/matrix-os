/**
 * Control stream (S05 / T026, T028).
 *
 * Homes hold one authenticated WebSocket to the platform over which the
 * control authority pushes signed assertions (denials, generations) and
 * receives fence acknowledgements. The stream carries no customer payload.
 * Admission needs the enrolled runtime identity plus a one-use, short-lived
 * upgrade ticket handed out by the registration route. Connections and
 * pending tickets are bounded; shutdown drains every connection.
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
  CollaborationControlAckSchema,
  type CollaborationControlAck,
  type CollaborationControlAssertion,
} from "@matrix-os/contracts";

const DEFAULT_TICKET_TTL_MS = COLLABORATION_DIRECT_LIMITS.ticketTtlSeconds * 1_000;
const DEFAULT_MAX_CONNECTIONS = 4_096;
const MAX_FRAME_BYTES = COLLABORATION_DIRECT_LIMITS.wsFrameBytes;

export interface ControlSocket {
  send(value: string): void;
  close(code?: number, reason?: string): void;
}

export interface ControlConnection {
  runtimeId: string;
  /** Feeds one inbound frame; rejects invalid frames so the caller can close the socket. */
  receive(raw: string): Promise<void>;
  close(): void;
}

export interface ControlAuthorityPort {
  registerTransport(transport: (runtimeId: string, assertion: CollaborationControlAssertion) => Promise<void>): void;
  acknowledge(authenticatedRuntimeId: string, ack: CollaborationControlAck): Promise<{ completedDenialIds: string[] }>;
}

export class CollaborationControlStream {
  private readonly now: () => Date;
  private readonly ticketTtlMs: number;
  private readonly maxConnections: number;
  private readonly connections = new Map<string, { socket: ControlSocket; close(): void }>();
  private closed = false;
  private readonly createToken: () => string;
  private readonly controlAuthority: ControlAuthorityPort;
  private readonly tickets: ControlUpgradeTicketStore;
  private readonly onAttach: ((runtimeId: string) => Promise<void>) | undefined;

  constructor(options: {
    controlAuthority: ControlAuthorityPort;
    /** Postgres-backed so a ticket issued by one platform instance admits on any instance. */
    tickets: ControlUpgradeTicketStore;
    /** Liveness hook (attach and acknowledgement); the ticket issuer reads it as home health. */
    onAttach?(runtimeId: string): Promise<void>;
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
    options.controlAuthority.registerTransport((runtimeId, assertion) => this.deliver(runtimeId, assertion));
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
    const entry = {
      socket,
      close: () => {
        if (this.connections.get(runtimeId) === entry) this.connections.delete(runtimeId);
        try {
          socket.close(1001, "Control stream closed");
        } catch (error: unknown) {
          console.warn("[collaboration-control-stream] socket close failed", error instanceof Error ? error.name : "UnknownError");
        }
      },
    };
    this.connections.set(runtimeId, entry);
    this.touch(runtimeId);
    return {
      runtimeId,
      receive: async (raw) => {
        if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) throw new Error("Control frame too large");
        const ack = CollaborationControlAckSchema.parse(JSON.parse(raw) as unknown);
        if (ack.runtimeId !== runtimeId) throw new Error("Control acknowledgement runtime mismatch");
        await this.controlAuthority.acknowledge(runtimeId, ack);
        this.touch(runtimeId);
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
    try {
      entry.socket.send(JSON.stringify(assertion));
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
  }

  private touch(runtimeId: string): void {
    this.onAttach?.(runtimeId).catch((error: unknown) => {
      console.warn("[collaboration-control-stream] liveness update failed", error instanceof Error ? error.name : "UnknownError");
    });
  }
}
