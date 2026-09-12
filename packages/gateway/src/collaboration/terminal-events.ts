import {
  CollaborationTerminalFrameSchema,
  type CollaborationTerminal,
  type CollaborationTerminalFrame,
} from "@matrix-os/contracts";
import type { AuthorizedCollaborationContext } from "./authority.js";
import type { CollaborationTerminalMetadata } from "./terminal-dispatcher.js";

const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_MAX_SCOPE_CONNECTIONS = 32;
const DEFAULT_MAX_ACTOR_SCOPE_CONNECTIONS = 4;
const DEFAULT_MAX_REPLAY_BYTES = 2 * 1024 * 1024;
const MAX_FRAME_DATA_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const STALE_AFTER_MS = 30_000;
const SWEEP_INTERVAL_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

export class CollaborationTerminalEventError extends Error {
  constructor(public readonly code: "capacity" | "unavailable") {
    super("Shared terminal events are unavailable");
    this.name = "CollaborationTerminalEventError";
  }
}

export interface CollaborationTerminalEventSocket {
  send(value: string): void;
  close(code?: number, reason?: string): void;
  bufferedAmount?: number;
  raw?: { bufferedAmount?: number };
}

interface OutputRecord {
  sequence: number;
  data: string;
  bytes: number;
}

interface TerminalRuntime {
  metadata: CollaborationTerminalMetadata;
  sequence: number;
  records: OutputRecord[];
  replayBytes: number;
  evictedThrough: number;
  connections: Set<string>;
  lastTouchedAt: number;
}

interface TerminalConnection {
  connectionId: string;
  scopeId: string;
  actorId: string;
  authorityGeneration: number;
  lastSequence: number;
  lastTouchedAt: number;
  socket: CollaborationTerminalEventSocket;
  delivery: Promise<void>;
}

export class CollaborationTerminalEventRegistry {
  private readonly connections = new Map<string, TerminalConnection>();
  private readonly runtimes = new Map<string, TerminalRuntime>();
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly now: () => Date;
  private readonly maxConnections: number;
  private readonly maxScopeConnections: number;
  private readonly maxActorScopeConnections: number;
  private readonly maxReplayBytes: number;
  private readonly maxSessions: number;
  private closing = false;

  constructor(private readonly options: {
    authorize(scopeId: string, actorId: string): Promise<AuthorizedCollaborationContext>;
    getTerminal(scopeId: string, terminalId: string): Promise<CollaborationTerminalMetadata | null>;
    projectTerminal(metadata: CollaborationTerminalMetadata): Promise<CollaborationTerminal>;
    now?: () => Date;
    startTimers?: boolean;
    maxConnections?: number;
    maxScopeConnections?: number;
    maxActorScopeConnections?: number;
    maxReplayBytes?: number;
    maxSessions?: number;
  }) {
    this.now = options.now ?? (() => new Date());
    this.maxConnections = bounded(options.maxConnections ?? DEFAULT_MAX_CONNECTIONS, 1, 256);
    this.maxScopeConnections = bounded(options.maxScopeConnections ?? DEFAULT_MAX_SCOPE_CONNECTIONS, 1, 32);
    this.maxActorScopeConnections = bounded(options.maxActorScopeConnections ?? DEFAULT_MAX_ACTOR_SCOPE_CONNECTIONS, 1, 4);
    this.maxReplayBytes = bounded(options.maxReplayBytes ?? DEFAULT_MAX_REPLAY_BYTES, 1, DEFAULT_MAX_REPLAY_BYTES);
    this.maxSessions = bounded(options.maxSessions ?? 256, 1, 256);
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
    socket: CollaborationTerminalEventSocket;
  }): Promise<{ close(): void; touch(): void }> {
    if (this.closing) throw new CollaborationTerminalEventError("unavailable");
    const context = await this.options.authorize(input.scopeId, input.actorId);
    if (context.resourceKind !== "terminal" || context.authorityGeneration !== input.authorityGeneration) {
      throw new CollaborationTerminalEventError("unavailable");
    }
    this.requireCapacity(input);
    const metadata = await this.options.getTerminal(context.scopeId, context.resourceId);
    if (!metadata || metadata.status !== "active") throw new CollaborationTerminalEventError("unavailable");
    const runtime = this.runtimeFor(metadata);
    const existing = this.connections.get(input.connectionId);
    if (existing) this.remove(existing, 1000, "Replaced");
    const connection: TerminalConnection = {
      connectionId: input.connectionId,
      scopeId: input.scopeId,
      actorId: input.actorId,
      authorityGeneration: input.authorityGeneration,
      lastSequence: input.afterSequence ?? 0,
      lastTouchedAt: this.now().getTime(),
      socket: input.socket,
      delivery: Promise.resolve(),
    };
    this.connections.set(connection.connectionId, connection);
    runtime.connections.add(connection.connectionId);
    runtime.lastTouchedAt = this.now().getTime();
    try {
      await this.deliverReplay(connection, runtime);
      this.send(connection, {
        version: 1,
        type: "terminal.ready",
        connectionId: connection.connectionId,
        scopeId: metadata.scopeId,
        resourceId: metadata.terminalId,
        authorityGeneration: String(connection.authorityGeneration),
        incarnation: metadata.incarnation,
        sequence: String(runtime.sequence),
        terminal: await this.options.projectTerminal(metadata),
      });
    } catch (error: unknown) {
      this.remove(connection, 1011, "Unavailable");
      throw error;
    }
    return {
      close: () => this.remove(connection, 1000, "Closed"),
      touch: () => {
        const current = this.connections.get(connection.connectionId);
        if (current) current.lastTouchedAt = this.now().getTime();
      },
    };
  }

  async publishOutput(scopeId: string, incarnation: string, data: string): Promise<void> {
    const runtime = this.runtimes.get(scopeId);
    if (!runtime || runtime.metadata.incarnation !== incarnation || runtime.metadata.status !== "active") {
      throw new CollaborationTerminalEventError("unavailable");
    }
    for (const chunk of byteChunks(data, MAX_FRAME_DATA_BYTES)) {
      runtime.sequence += 1;
      const record = { sequence: runtime.sequence, data: chunk, bytes: Buffer.byteLength(chunk) };
      runtime.records.push(record);
      runtime.replayBytes += record.bytes;
      while (runtime.replayBytes > this.maxReplayBytes && runtime.records.length > 0) {
        const removed = runtime.records.shift()!;
        runtime.replayBytes -= removed.bytes;
        runtime.evictedThrough = removed.sequence;
      }
      await this.broadcastRecord(runtime, record);
    }
  }

  async publishState(scopeId: string): Promise<void> {
    const runtime = this.runtimes.get(scopeId);
    if (!runtime) return;
    const current = await this.options.getTerminal(scopeId, runtime.metadata.terminalId);
    if (!current || current.incarnation !== runtime.metadata.incarnation) {
      await this.publishUnavailable(runtime, "unavailable");
      return;
    }
    runtime.metadata = current;
    const terminal = await this.options.projectTerminal(current);
    await this.broadcast(runtime, {
      version: 1,
      type: "terminal.state",
      scopeId,
      resourceId: current.terminalId,
      authorityGeneration: "1",
      incarnation: current.incarnation,
      sequence: String(runtime.sequence),
      terminal,
    });
  }

  async publishExit(scopeId: string, incarnation: string): Promise<void> {
    const runtime = this.runtimes.get(scopeId);
    if (!runtime || runtime.metadata.incarnation !== incarnation) {
      throw new CollaborationTerminalEventError("unavailable");
    }
    runtime.metadata = { ...runtime.metadata, status: "exited", exitedAt: this.now().toISOString() };
    await this.publishUnavailable(runtime, "exited");
  }

  notifyRevoked(scopeId: string, actorId: string): void {
    for (const connection of [...this.connections.values()]) {
      if (connection.scopeId === scopeId && connection.actorId === actorId) {
        this.sendBestEffort(connection, unavailableFrame(connection, this.runtimes.get(scopeId), "revoked"));
        this.remove(connection, 1008, "Revoked");
      }
    }
  }

  sweep(at: Date): void {
    const cutoff = at.getTime() - STALE_AFTER_MS;
    for (const connection of [...this.connections.values()]) {
      if (connection.lastTouchedAt <= cutoff) this.remove(connection, 1001, "Stale");
    }
    for (const [scopeId, runtime] of [...this.runtimes]) {
      if (runtime.connections.size === 0 && runtime.lastTouchedAt <= cutoff) this.runtimes.delete(scopeId);
    }
  }

  shutdown(): void {
    if (this.closing) return;
    this.closing = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    for (const connection of [...this.connections.values()]) {
      this.sendBestEffort(connection, unavailableFrame(connection, this.runtimes.get(connection.scopeId), "unavailable"));
      this.remove(connection, 1001, "Shutdown");
    }
    this.runtimes.clear();
  }

  private runtimeFor(metadata: CollaborationTerminalMetadata): TerminalRuntime {
    const existing = this.runtimes.get(metadata.scopeId);
    if (existing) {
      if (existing.metadata.incarnation !== metadata.incarnation) throw new CollaborationTerminalEventError("unavailable");
      return existing;
    }
    if (this.runtimes.size >= this.maxSessions) {
      const idle = [...this.runtimes].find(([, candidate]) => candidate.connections.size === 0);
      if (idle) this.runtimes.delete(idle[0]);
    }
    if (this.runtimes.size >= this.maxSessions) throw new CollaborationTerminalEventError("capacity");
    const runtime: TerminalRuntime = {
      metadata,
      sequence: 0,
      records: [],
      replayBytes: 0,
      evictedThrough: 0,
      connections: new Set(),
      lastTouchedAt: this.now().getTime(),
    };
    this.runtimes.set(metadata.scopeId, runtime);
    return runtime;
  }

  private requireCapacity(input: { connectionId: string; scopeId: string; actorId: string }): void {
    const current = [...this.connections.values()].filter((item) => item.connectionId !== input.connectionId);
    if (current.length >= this.maxConnections
      || current.filter((item) => item.scopeId === input.scopeId).length >= this.maxScopeConnections
      || current.filter((item) => item.scopeId === input.scopeId && item.actorId === input.actorId).length
        >= this.maxActorScopeConnections) throw new CollaborationTerminalEventError("capacity");
  }

  private async deliverReplay(connection: TerminalConnection, runtime: TerminalRuntime): Promise<void> {
    if (connection.lastSequence < runtime.evictedThrough) {
      this.send(connection, refreshFrame(connection, runtime));
      connection.lastSequence = runtime.sequence;
      return;
    }
    for (const record of runtime.records) {
      if (record.sequence > connection.lastSequence) this.sendRecord(connection, runtime, record);
    }
  }

  private async broadcastRecord(runtime: TerminalRuntime, record: OutputRecord): Promise<void> {
    const dead: TerminalConnection[] = [];
    for (const connectionId of [...runtime.connections]) {
      const connection = this.connections.get(connectionId);
      if (!connection) continue;
      try {
        await this.enqueue(connection, async () => {
          const context = await this.options.authorize(connection.scopeId, connection.actorId);
          if (context.resourceKind !== "terminal" || context.authorityGeneration !== connection.authorityGeneration) {
            throw new Error("authority changed");
          }
          if (bufferedAmount(connection.socket) > MAX_BUFFERED_BYTES) {
            this.sendBestEffort(connection, refreshFrame(connection, runtime));
            throw new Error("slow recipient");
          }
          this.sendRecord(connection, runtime, record);
        });
      } catch (error: unknown) {
        console.warn("[collaboration-terminal-events] subscriber unavailable", error instanceof Error ? error.name : "UnknownError");
        this.sendBestEffort(connection, unavailableFrame(connection, runtime, "revoked"));
        dead.push(connection);
      }
    }
    for (const connection of dead) this.remove(connection, 1008, "Unavailable");
  }

  private async broadcast(runtime: TerminalRuntime, frame: CollaborationTerminalFrame): Promise<void> {
    for (const connectionId of [...runtime.connections]) {
      const connection = this.connections.get(connectionId);
      if (!connection) continue;
      try {
        const context = await this.options.authorize(connection.scopeId, connection.actorId);
        if (context.authorityGeneration !== connection.authorityGeneration) throw new Error("authority changed");
        this.send(connection, { ...frame, authorityGeneration: String(connection.authorityGeneration) });
      } catch (error: unknown) {
        console.warn("[collaboration-terminal-events] state subscriber unavailable", error instanceof Error ? error.name : "UnknownError");
        this.remove(connection, 1008, "Unavailable");
      }
    }
  }

  private async publishUnavailable(runtime: TerminalRuntime, code: "exited" | "unavailable"): Promise<void> {
    for (const connectionId of [...runtime.connections]) {
      const connection = this.connections.get(connectionId);
      if (!connection) continue;
      this.sendBestEffort(connection, unavailableFrame(connection, runtime, code));
    }
  }

  private sendRecord(connection: TerminalConnection, runtime: TerminalRuntime, record: OutputRecord): void {
    this.send(connection, {
      version: 1,
      type: "terminal.output",
      scopeId: connection.scopeId,
      resourceId: runtime.metadata.terminalId,
      authorityGeneration: String(connection.authorityGeneration),
      incarnation: runtime.metadata.incarnation,
      sequence: String(record.sequence),
      data: record.data,
    });
    connection.lastSequence = record.sequence;
  }

  private send(connection: TerminalConnection, frame: CollaborationTerminalFrame): void {
    connection.socket.send(JSON.stringify(CollaborationTerminalFrameSchema.parse(frame)));
    connection.lastTouchedAt = this.now().getTime();
  }

  private sendBestEffort(connection: TerminalConnection, frame: CollaborationTerminalFrame): void {
    try {
      this.send(connection, frame);
    } catch (error: unknown) {
      console.warn("[collaboration-terminal-events] socket send failed", error instanceof Error ? error.name : "UnknownError");
    }
  }

  private remove(connection: TerminalConnection, code: number, reason: string): void {
    if (!this.connections.delete(connection.connectionId)) return;
    const runtime = this.runtimes.get(connection.scopeId);
    runtime?.connections.delete(connection.connectionId);
    if (runtime) runtime.lastTouchedAt = this.now().getTime();
    try {
      connection.socket.close(code, reason);
    } catch (error: unknown) {
      console.warn("[collaboration-terminal-events] socket close failed", error instanceof Error ? error.name : "UnknownError");
    }
  }

  private enqueue(connection: TerminalConnection, operation: () => Promise<void>): Promise<void> {
    const active = connection.delivery.then(operation);
    connection.delivery = active.catch((error: unknown) => {
      console.warn("[collaboration-terminal-events] delivery failed", error instanceof Error ? error.name : "UnknownError");
    });
    return active;
  }

  private async heartbeat(): Promise<void> {
    for (const connection of [...this.connections.values()]) {
      try {
        await this.options.authorize(connection.scopeId, connection.actorId);
      } catch (error: unknown) {
        console.warn("[collaboration-terminal-events] heartbeat authorization failed", error instanceof Error ? error.name : "UnknownError");
        this.remove(connection, 1008, "Unavailable");
      }
    }
  }
}

function unavailableFrame(
  connection: TerminalConnection,
  runtime: TerminalRuntime | undefined,
  code: "revoked" | "exited" | "unavailable",
): CollaborationTerminalFrame {
  return {
    version: 1,
    type: "terminal.unavailable",
    scopeId: connection.scopeId,
    resourceId: runtime?.metadata.terminalId ?? "terminal_unavailable",
    authorityGeneration: String(connection.authorityGeneration),
    incarnation: runtime?.metadata.incarnation ?? "terminal-unavailable",
    code,
  };
}

function refreshFrame(connection: TerminalConnection, runtime: TerminalRuntime): CollaborationTerminalFrame {
  return {
    version: 1,
    type: "terminal.refresh_required",
    scopeId: connection.scopeId,
    resourceId: runtime.metadata.terminalId,
    authorityGeneration: String(connection.authorityGeneration),
    incarnation: runtime.metadata.incarnation,
    sequence: String(runtime.sequence),
  };
}

function bufferedAmount(socket: CollaborationTerminalEventSocket): number {
  return socket.bufferedAmount ?? socket.raw?.bufferedAmount ?? 0;
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new RangeError("Invalid terminal event limit");
  return value;
}

function byteChunks(value: string, maxBytes: number): string[] {
  if (value.length === 0) return [];
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes && current) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}
