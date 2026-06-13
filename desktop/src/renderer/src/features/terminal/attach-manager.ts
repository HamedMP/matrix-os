// Lesson L4: at most one live terminal socket app-wide; switching focus
// detaches the previous socket. Lesson L9: a generation counter drops events
// from sockets that are no longer the active attachment. Detached terminals
// restore instantly from a bounded LRU of serialized buffers.

import type { ShellSocketEvents, ShellSocketState } from "../../lib/shell-socket";

const DEFAULT_BUFFER_CACHE_CAP = 8;

export interface SocketControl {
  connect(): void;
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
  detach(): void;
  dispose(): void;
}

export interface AttachManagerOptions {
  createSocket: (sessionName: string, events: ShellSocketEvents) => SocketControl;
  bufferCacheCap?: number;
}

export interface ActiveAttachment {
  sessionName: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

interface ActiveSocket {
  sessionName: string;
  socket: SocketControl;
  generation: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AttachManager {
  private readonly createSocket: AttachManagerOptions["createSocket"];
  private readonly bufferCacheCap: number;
  private readonly buffers = new Map<string, string>();
  private active: ActiveSocket | null = null;
  private generation = 0;
  private disposed = false;

  constructor(options: AttachManagerOptions) {
    this.createSocket = options.createSocket;
    this.bufferCacheCap = Math.max(1, Math.floor(options.bufferCacheCap ?? DEFAULT_BUFFER_CACHE_CAP));
  }

  get activeSessionName(): string | null {
    return this.active?.sessionName ?? null;
  }

  attach(sessionName: string, events: ShellSocketEvents): ActiveAttachment {
    if (this.disposed) {
      throw new Error("AttachManager is disposed");
    }
    this.detachActive();
    this.generation += 1;
    const generation = this.generation;
    const guarded: ShellSocketEvents = {
      onState: (state: ShellSocketState, detail?: { code?: string }) => {
        if (this.isLive(generation)) events.onState(state, detail);
      },
      onOutput: (data: string, seq: number) => {
        if (this.isLive(generation)) events.onOutput(data, seq);
      },
      onGap: () => {
        if (this.isLive(generation)) events.onGap();
      },
      onExit: (code: number) => {
        if (this.isLive(generation)) events.onExit(code);
      },
    };
    const socket = this.createSocket(sessionName, guarded);
    this.active = { sessionName, socket, generation };
    socket.connect();
    return {
      sessionName,
      write: (data: string) => {
        if (this.isLive(generation)) socket.sendInput(data);
      },
      resize: (cols: number, rows: number) => {
        if (this.isLive(generation)) socket.resize(cols, rows);
      },
    };
  }

  cacheBuffer(sessionName: string, serialized: string): void {
    if (this.buffers.has(sessionName)) {
      this.buffers.delete(sessionName);
    } else if (this.buffers.size >= this.bufferCacheCap) {
      const oldest = this.buffers.keys().next().value;
      if (oldest !== undefined) {
        this.buffers.delete(oldest);
      }
    }
    this.buffers.set(sessionName, serialized);
  }

  getCachedBuffer(sessionName: string): string | null {
    const value = this.buffers.get(sessionName);
    if (value === undefined) return null;
    this.buffers.delete(sessionName);
    this.buffers.set(sessionName, value);
    return value;
  }

  detachActive(): void {
    const active = this.active;
    if (active === null) return;
    // Clear first so events emitted during detach/dispose fail the guard.
    this.active = null;
    try {
      active.socket.detach();
    } catch (err: unknown) {
      console.warn("[attach-manager] socket detach failed:", errorText(err));
    }
    try {
      active.socket.dispose();
    } catch (err: unknown) {
      console.warn("[attach-manager] socket dispose failed:", errorText(err));
    }
  }

  releaseSession(sessionName: string): void {
    this.buffers.delete(sessionName);
    if (this.active?.sessionName === sessionName) {
      this.detachActive();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.detachActive();
    this.buffers.clear();
    this.disposed = true;
  }

  private isLive(generation: number): boolean {
    return !this.disposed && this.active !== null && this.active.generation === generation;
  }
}
