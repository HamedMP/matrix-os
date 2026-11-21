// Lesson L4: by default at most one live terminal socket app-wide; switching
// focus detaches the previous socket. A renderer that keeps several terminals
// mounted (the Terminal window, spec 2701 layer 6) raises `maxLive`: up to that
// many sessions stay attached, least recently attached evicted first.
// Lesson L9: a generation counter drops events from sockets that are no longer
// live. Detached terminals restore instantly from a bounded LRU of serialized
// buffers.

import type { ShellSocketEvents, ShellSocketState } from "../../lib/shell-socket";

const DEFAULT_BUFFER_CACHE_CAP = 8;
/** The most live attachments any renderer may keep. */
export const MAX_LIVE_ATTACHMENTS = 8;

export interface SocketControl {
  connect(): void;
  sendInput(data: string): void;
  sendBinary(data: string): void;
  resize(cols: number, rows: number): void;
  scroll?(frame: { type: "scroll-query" } | { type: "scroll-to"; line: number }): void;
  detach(): void;
  dispose(): void;
}

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export interface AttachManagerOptions {
  createSocket: (sessionName: string, events: ShellSocketEvents, chatId?: string) => SocketControl;
  bufferCacheCap?: number;
  /** How many sessions may be attached at once (1 by default). */
  maxLive?: number;
  /**
   * Sessions whose source repaints the whole terminal on attach. A snapshot
   * of theirs is never kept: shown before the repaint, it would only be
   * painted over, and its scrollback would stay below the source's own.
   */
  repaintsOnAttach?: (sessionName: string) => boolean;
}

export interface ActiveAttachment {
  sessionName: string;
  write(data: string): void;
  writeBinary(data: string): void;
  resize(cols: number, rows: number): void;
  scroll?(frame: { type: "scroll-query" } | { type: "scroll-to"; line: number }): void;
  /** Detaches this attachment, if it is still the live one for its session. */
  release(): void;
  /** Whether this is still the live attachment of its session. */
  live(): boolean;
}

interface ActiveSocket {
  sessionName: string;
  socket: SocketControl;
  generation: number;
  events: ShellSocketEvents;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AttachManager {
  private readonly createSocket: AttachManagerOptions["createSocket"];
  private readonly bufferCacheCap: number;
  private readonly repaintsOnAttach: (sessionName: string) => boolean;
  private readonly buffers = new Map<string, string>();
  /** How many sessions may be attached at once. */
  readonly maxLive: number;
  // Insertion-ordered: the first entry is the least recently attached.
  // Bounded by maxLive.
  private readonly live = new Map<string, ActiveSocket>();
  private generation = 0;
  private disposed = false;

  constructor(options: AttachManagerOptions) {
    this.createSocket = options.createSocket;
    this.bufferCacheCap = Math.max(1, Math.floor(options.bufferCacheCap ?? DEFAULT_BUFFER_CACHE_CAP));
    this.repaintsOnAttach = options.repaintsOnAttach ?? (() => false);
    this.maxLive = Math.min(MAX_LIVE_ATTACHMENTS, Math.max(1, Math.floor(options.maxLive ?? 1)));
  }

  /** The most recently attached session that is still live. */
  get activeSessionName(): string | null {
    let last: string | null = null;
    for (const sessionName of this.live.keys()) last = sessionName;
    return last;
  }

  /** Every session that is attached right now, least recently attached first. */
  get liveSessionNames(): string[] {
    return [...this.live.keys()];
  }

  attach(
    sessionName: string,
    events: ShellSocketEvents,
    initialSize?: TerminalDimensions,
    chatId?: string,
  ): ActiveAttachment {
    if (this.disposed) {
      throw new Error("AttachManager is disposed");
    }
    if (this.maxLive === 1) this.detachActive();
    else {
      this.detachSession(sessionName);
      while (this.live.size >= this.maxLive) {
        const oldest = this.live.values().next().value;
        if (!oldest) break;
        this.detachSession(oldest.sessionName);
        // The view stays mounted: it must not keep showing a live terminal it no longer follows.
        oldest.events.onState("connection-lost");
      }
    }
    this.generation += 1;
    const generation = this.generation;
    const isLive = () => this.isLive(sessionName, generation);
    const guarded: ShellSocketEvents = {
      onState: (state: ShellSocketState, detail?: { code?: string }) => {
        if (isLive()) events.onState(state, detail);
      },
      onOutput: (data: string | Uint8Array, seq: number, written?: () => void) => {
        if (isLive()) events.onOutput(data, seq, written);
        // Output for a view that is gone is dropped; that still counts as taken.
        else written?.();
      },
      onRepaint: () => { if (isLive()) events.onRepaint?.(); },
      onNativeScroll: (state) => { if (isLive()) events.onNativeScroll?.(state); },
      onNativeScrollSupported: (supported) => { if (isLive()) events.onNativeScrollSupported?.(supported); },
      onCanonicalSize: (size) => {
        if (isLive()) events.onCanonicalSize?.(size);
      },
      onOwnershipChange: (role) => {
        if (isLive()) events.onOwnershipChange?.(role);
      },
      onGap: () => {
        if (isLive()) events.onGap();
      },
      onExit: (code: number) => {
        if (isLive()) events.onExit(code);
      },
    };
    const socket = this.createSocket(sessionName, guarded, chatId);
    this.live.set(sessionName, { sessionName, socket, generation, events });
    if (initialSize) socket.resize(initialSize.cols, initialSize.rows);
    socket.connect();
    return {
      sessionName,
      write: (data: string) => {
        if (isLive()) socket.sendInput(data);
      },
      writeBinary: (data: string) => {
        if (isLive()) socket.sendBinary(data);
      },
      scroll: (frame) => { if (isLive()) socket.scroll?.(frame); },
      resize: (cols: number, rows: number) => {
        if (isLive()) socket.resize(cols, rows);
      },
      release: () => {
        if (isLive()) this.detachSession(sessionName);
      },
      live: isLive,
    };
  }

  cacheBuffer(sessionName: string, serialized: string): void {
    if (this.repaintsOnAttach(sessionName)) {
      this.buffers.delete(sessionName);
      return;
    }
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
    if (this.repaintsOnAttach(sessionName)) return null;
    const value = this.buffers.get(sessionName);
    if (value === undefined) return null;
    this.buffers.delete(sessionName);
    this.buffers.set(sessionName, value);
    return value;
  }

  /** Detaches every live attachment. */
  detachActive(): void {
    for (const sessionName of [...this.live.keys()]) this.detachSession(sessionName);
  }

  private detachSession(sessionName: string): void {
    const active = this.live.get(sessionName);
    if (!active) return;
    // Remove first so events emitted during detach/dispose fail the guard.
    this.live.delete(sessionName);
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
    this.detachSession(sessionName);
  }

  dispose(): void {
    if (this.disposed) return;
    this.detachActive();
    this.buffers.clear();
    this.disposed = true;
  }

  private isLive(sessionName: string, generation: number): boolean {
    return !this.disposed && this.live.get(sessionName)?.generation === generation;
  }
}
