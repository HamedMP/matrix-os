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
import {
  COLLABORATION_DIRECT_LIMITS,
  CollaborationControlAckSchema,
  type CollaborationControlAck,
  type CollaborationControlAssertion,
} from "@matrix-os/contracts";

const DEFAULT_TICKET_TTL_MS = COLLABORATION_DIRECT_LIMITS.ticketTtlSeconds * 1_000;
const DEFAULT_MAX_PENDING_TICKETS = 1_024;
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
  private readonly maxPendingTickets: number;
  private readonly maxConnections: number;
  private readonly pendingTickets = new Map<string, { runtimeId: string; expiresAt: number }>();
  private readonly connections = new Map<string, { socket: ControlSocket; close(): void }>();
  private closed = false;

  constructor(options: {
    controlAuthority: ControlAuthorityPort;
    now?: () => Date;
    ticketTtlMs?: number;
    maxPendingTickets?: number;
    maxConnections?: number;
    createToken?: () => string;
  }) {
    this.now = options.now ?? (() => new Date());
    this.ticketTtlMs = options.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS;
    this.maxPendingTickets = options.maxPendingTickets ?? DEFAULT_MAX_PENDING_TICKETS;
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.createToken = options.createToken ?? (() => randomBytes(32).toString("base64url"));
    this.controlAuthority = options.controlAuthority;
    options.controlAuthority.registerTransport((runtimeId, assertion) => this.deliver(runtimeId, assertion));
  }

  private readonly createToken: () => string;
  private readonly controlAuthority: ControlAuthorityPort;

  /** One-use ticket a freshly registered runtime presents on the control upgrade. */
  issueUpgradeTicket(runtimeId: string): string {
    if (this.closed) throw new Error("Control stream is shutting down");
    this.sweepTickets();
    while (this.pendingTickets.size >= this.maxPendingTickets) {
      const oldest = this.pendingTickets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pendingTickets.delete(oldest);
    }
    const token = this.createToken();
    this.pendingTickets.set(token, { runtimeId, expiresAt: this.now().getTime() + this.ticketTtlMs });
    return token;
  }

  consumeUpgradeTicket(token: string, runtimeId: string): boolean {
    this.sweepTickets();
    const pending = this.pendingTickets.get(token);
    if (!pending) return false;
    this.pendingTickets.delete(token);
    return pending.runtimeId === runtimeId && pending.expiresAt > this.now().getTime();
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
    return {
      runtimeId,
      receive: async (raw) => {
        if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) throw new Error("Control frame too large");
        const ack = CollaborationControlAckSchema.parse(JSON.parse(raw) as unknown);
        if (ack.runtimeId !== runtimeId) throw new Error("Control acknowledgement runtime mismatch");
        await this.controlAuthority.acknowledge(runtimeId, ack);
      },
      close: () => entry.close(),
    };
  }

  async deliver(runtimeId: string, assertion: CollaborationControlAssertion): Promise<void> {
    const entry = this.connections.get(runtimeId);
    if (!entry) throw new Error("Runtime is not connected to the control stream");
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
    this.pendingTickets.clear();
    for (const entry of [...this.connections.values()]) entry.close();
    this.connections.clear();
  }

  private sweepTickets(): void {
    const current = this.now().getTime();
    for (const [token, pending] of this.pendingTickets) if (pending.expiresAt <= current) this.pendingTickets.delete(token);
  }
}
