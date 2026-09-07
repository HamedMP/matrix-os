import { CollaborationEventFrameSchema, type CollaborationEventFrame } from "@matrix-os/contracts";
import type { Kysely } from "kysely";
import type { AuthorizedCollaborationContext } from "./authority.js";
import type { OwnerCollaborationDatabase } from "./database.js";

const MAX_CONNECTIONS = 256;
const MAX_SCOPE_CONNECTIONS = 32;
const MAX_ACTOR_SCOPE_CONNECTIONS = 4;
const STALE_AFTER_MS = 30_000;
const SWEEP_INTERVAL_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_REPLAY_EVENTS = 100;

export class CollaborationEventRegistryError extends Error {
  constructor(public readonly code: "capacity" | "unavailable", message: string) {
    super(message);
    this.name = "CollaborationEventRegistryError";
  }
}

export interface CollaborationEventSocket {
  send(value: string): void;
  close(code?: number, reason?: string): void;
}

interface Connection {
  connectionId: string;
  scopeId: string;
  actorId: string;
  resourceId: string;
  resourceKind: "chat" | "terminal" | "project";
  authorityGeneration: number;
  lastSequence: number;
  lastTouchedAt: number;
  socket: CollaborationEventSocket;
  delivery: Promise<void>;
}

export class CollaborationEventRegistry {
  private readonly connections = new Map<string, Connection>();
  private readonly now: () => Date;
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private closing = false;

  constructor(private readonly options: {
    db: Kysely<OwnerCollaborationDatabase>;
    authorize(scopeId: string, actorId: string): Promise<AuthorizedCollaborationContext>;
    now?: () => Date;
    startTimers?: boolean;
  }) {
    this.now = options.now ?? (() => new Date());
    if (options.startTimers !== false) {
      const sweep = setInterval(() => this.sweep(this.now()), SWEEP_INTERVAL_MS);
      const heartbeat = setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS);
      sweep.unref?.();
      heartbeat.unref?.();
      this.timers.push(sweep, heartbeat);
    }
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  async open(input: {
    connectionId: string;
    scopeId: string;
    actorId: string;
    authorityGeneration: number;
    afterSequence?: number;
    socket: CollaborationEventSocket;
  }): Promise<{ sequence: number; close(): void; touch(): void; resume(sequence: number, authorityGeneration: number): Promise<void> }> {
    if (this.closing) throw new CollaborationEventRegistryError("unavailable", "Event delivery is shutting down");
    const context = await this.options.authorize(input.scopeId, input.actorId);
    if (context.authorityGeneration !== input.authorityGeneration) {
      throw new CollaborationEventRegistryError("unavailable", "Event authority changed");
    }
    await this.requireValidCursor(input.scopeId, input.afterSequence ?? 0);
    this.requireCapacity(input.scopeId, input.actorId, input.connectionId);
    const existing = this.connections.get(input.connectionId);
    if (existing) this.remove(existing.connectionId, 1000, "Replaced");
    const connection: Connection = {
      connectionId: input.connectionId,
      scopeId: input.scopeId,
      actorId: input.actorId,
      resourceId: context.resourceId,
      resourceKind: context.resourceKind,
      authorityGeneration: context.authorityGeneration,
      lastSequence: input.afterSequence ?? 0,
      lastTouchedAt: this.now().getTime(),
      socket: input.socket,
      delivery: Promise.resolve(),
    };
    this.connections.set(connection.connectionId, connection);
    try {
      await this.enqueueDelivery(connection, async () => {
        await this.sendReplay(connection);
        this.send(connection, {
          version: 1,
          type: "ready",
          scopeId: connection.scopeId,
          resourceId: connection.resourceId,
          authorityGeneration: String(connection.authorityGeneration),
          sequence: String(connection.lastSequence),
        });
      });
    } catch (error: unknown) {
      this.remove(connection.connectionId, 1011, "Unavailable");
      throw error;
    }
    return {
      sequence: connection.lastSequence,
      close: () => this.remove(connection.connectionId, 1000, "Closed"),
      touch: () => {
        const current = this.connections.get(connection.connectionId);
        if (current) current.lastTouchedAt = this.now().getTime();
      },
      resume: async (sequence, authorityGeneration) => {
        const current = this.connections.get(connection.connectionId);
        if (!current || authorityGeneration !== current.authorityGeneration) {
          throw new CollaborationEventRegistryError("unavailable", "Event cursor is unavailable");
        }
        await this.enqueueDelivery(current, async () => {
          const authorized = await this.options.authorize(current.scopeId, current.actorId);
          if (authorized.authorityGeneration !== current.authorityGeneration) {
            throw new CollaborationEventRegistryError("unavailable", "Event authority changed");
          }
          await this.requireValidCursor(current.scopeId, sequence);
          current.lastSequence = Math.max(current.lastSequence, sequence);
          current.lastTouchedAt = this.now().getTime();
          await this.sendReplay(current);
        });
      },
    };
  }

  async broadcastScope(scopeId: string): Promise<void> {
    const targets = [...this.connections.values()].filter((connection) => connection.scopeId === scopeId);
    const remove: string[] = [];
    for (const connection of targets) {
      try {
        await this.enqueueDelivery(connection, async () => {
          const context = await this.options.authorize(connection.scopeId, connection.actorId);
          if (context.authorityGeneration !== connection.authorityGeneration) throw new Error("authority changed");
          await this.sendReplay(connection);
        });
      } catch (error: unknown) {
        console.warn("[collaboration-events] subscriber unavailable", error instanceof Error ? error.name : "UnknownError");
        this.sendBestEffort(connection, {
          version: 1,
          type: "unavailable",
          scopeId: connection.scopeId,
          resourceId: connection.resourceId,
          authorityGeneration: String(connection.authorityGeneration),
          code: "revoked",
        });
        remove.push(connection.connectionId);
      }
    }
    for (const connectionId of remove) this.remove(connectionId, 1008, "Unavailable");
  }

  notifyRevoked(scopeId: string, actorId: string): void {
    const targets = [...this.connections.values()].filter(
      (connection) => connection.scopeId === scopeId && connection.actorId === actorId,
    );
    for (const connection of targets) {
      this.sendBestEffort(connection, {
        version: 1,
        type: "unavailable",
        scopeId: connection.scopeId,
        resourceId: connection.resourceId,
        authorityGeneration: String(connection.authorityGeneration),
        code: "revoked",
      });
      this.remove(connection.connectionId, 1008, "Revoked");
    }
  }

  sweep(at: Date): void {
    const cutoff = at.getTime() - STALE_AFTER_MS;
    for (const connection of [...this.connections.values()]) {
      if (connection.lastTouchedAt <= cutoff) this.remove(connection.connectionId, 1001, "Stale");
    }
  }

  shutdown(): void {
    if (this.closing) return;
    this.closing = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    for (const connection of [...this.connections.values()]) {
      this.sendBestEffort(connection, {
        version: 1,
        type: "unavailable",
        scopeId: connection.scopeId,
        resourceId: connection.resourceId,
        authorityGeneration: String(connection.authorityGeneration),
        code: "unavailable",
      });
      this.remove(connection.connectionId, 1001, "Shutdown");
    }
  }

  private requireCapacity(scopeId: string, actorId: string, replacingId: string): void {
    const current = [...this.connections.values()].filter((connection) => connection.connectionId !== replacingId);
    if (current.length >= MAX_CONNECTIONS
      || current.filter((connection) => connection.scopeId === scopeId).length >= MAX_SCOPE_CONNECTIONS
      || current.filter((connection) => connection.scopeId === scopeId && connection.actorId === actorId).length
        >= MAX_ACTOR_SCOPE_CONNECTIONS) {
      throw new CollaborationEventRegistryError("capacity", "Event connection capacity reached");
    }
  }

  private async sendReplay(connection: Connection): Promise<void> {
    const rows = await this.options.db.selectFrom("collaboration_events")
      .selectAll()
      .where("scope_id", "=", connection.scopeId)
      .where("scope_seq", ">", connection.lastSequence)
      .orderBy("scope_seq", "asc")
      .limit(MAX_REPLAY_EVENTS + 1)
      .execute();
    if (rows.length > MAX_REPLAY_EVENTS) {
      this.send(connection, {
        version: 1,
        type: "refresh_required",
        scopeId: connection.scopeId,
        resourceId: connection.resourceId,
        authorityGeneration: String(connection.authorityGeneration),
      });
      return;
    }
    for (const row of rows) {
      this.send(connection, {
        version: 1,
        type: "changed",
        scopeId: row.scope_id,
        resourceId: row.resource_id,
        authorityGeneration: String(row.authority_generation),
        eventId: row.event_id,
        sequence: String(row.scope_seq),
        resourceKind: row.resource_kind,
        revision: String(row.revision),
      });
      connection.lastSequence = Number(row.scope_seq);
    }
  }

  private enqueueDelivery(connection: Connection, operation: () => Promise<void>): Promise<void> {
    const active = connection.delivery.then(operation);
    connection.delivery = active.catch((error: unknown) => {
      console.warn(
        "[collaboration-events] serialized delivery failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    });
    return active;
  }

  private async requireValidCursor(scopeId: string, sequence: number): Promise<void> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new CollaborationEventRegistryError("unavailable", "Event cursor is unavailable");
    }
    const row = await this.options.db.selectFrom("collaboration_events")
      .select(({ fn }) => fn.max("scope_seq").as("sequence"))
      .where("scope_id", "=", scopeId)
      .executeTakeFirst();
    if (sequence > Number(row?.sequence ?? 0)) {
      throw new CollaborationEventRegistryError("unavailable", "Event cursor is unavailable");
    }
  }

  private async heartbeat(): Promise<void> {
    const remove: string[] = [];
    for (const connection of this.connections.values()) {
      try {
        this.send(connection, {
          version: 1,
          type: "heartbeat",
          scopeId: connection.scopeId,
          resourceId: connection.resourceId,
          authorityGeneration: String(connection.authorityGeneration),
          sequence: String(connection.lastSequence),
        });
      } catch (error: unknown) {
        console.warn("[collaboration-events] heartbeat failed", error instanceof Error ? error.name : "UnknownError");
        remove.push(connection.connectionId);
      }
    }
    for (const connectionId of remove) this.remove(connectionId, 1011, "Send failed");
  }

  private send(connection: Connection, frame: CollaborationEventFrame): void {
    connection.socket.send(JSON.stringify(CollaborationEventFrameSchema.parse(frame)));
  }

  private sendBestEffort(connection: Connection, frame: CollaborationEventFrame): void {
    try {
      this.send(connection, frame);
    } catch (error: unknown) {
      console.warn("[collaboration-events] final send failed", error instanceof Error ? error.name : "UnknownError");
    }
  }

  private remove(connectionId: string, code: number, reason: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.connections.delete(connectionId);
    try {
      connection.socket.close(code, reason);
    } catch (error: unknown) {
      console.warn("[collaboration-events] socket close failed", error instanceof Error ? error.name : "UnknownError");
    }
  }
}
