import { z } from "zod/v4";
import { randomUUID } from "node:crypto";
import { writeFileSync, renameSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { RingBuffer } from "./ring-buffer.js";
import { resolveWithinHome } from "./path-security.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const AttachNewSchema = z.object({
  type: z.literal("attach"),
  cwd: z.string().min(1).max(4096),
  shell: z.string().min(1).max(256).optional(),
});

const AttachExistingSchema = z.object({
  type: z.literal("attach"),
  sessionId: z.string().regex(UUID_REGEX),
  fromSeq: z.number().int().nonnegative().optional(),
});

const AttachSchema = z.union([AttachNewSchema, AttachExistingSchema]);

const InputSchema = z.object({
  type: z.literal("input"),
  data: z.string().max(65536),
});

const ResizeSchema = z.object({
  type: z.literal("resize"),
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(200),
});

const DetachSchema = z.object({
  type: z.literal("detach"),
});

export const ClientMessageSchema = z.union([AttachSchema, InputSchema, ResizeSchema, DetachSchema]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export { AttachSchema, AttachNewSchema, AttachExistingSchema, InputSchema, ResizeSchema, DetachSchema, UUID_REGEX };

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  shell: string;
  state: "running" | "exited";
  exitCode?: number;
  createdAt: number;
  lastAttachedAt: number;
  attachedClients: number;
}

export type PtyServerMessage =
  | { type: "attached"; sessionId: string; state: "running" | "exited"; exitCode?: number }
  | { type: "output"; data: string; seq: number }
  | { type: "replay-start"; fromSeq: number }
  | { type: "replay-end"; toSeq: number }
  | { type: "exit"; code: number }
  | { type: "error"; message: string };

export interface SessionHandle {
  readonly sessionId: string;
  subscribe(cb: (msg: PtyServerMessage) => void): void;
  send(msg: ClientMessage): void;
  replay(fromSeq: number): void;
  detach(): void;
}

export interface SessionRegistryOptions {
  maxSessions?: number;
  bufferSize?: number;
  persistPath?: string;
}

type SubscriberFn = (msg: PtyServerMessage) => void;

interface PtyLike {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  pid: number;
}

type SpawnFn = (shell: string, args: string[], opts: Record<string, unknown>) => PtyLike;

class PtySession {
  readonly sessionId: string;
  readonly buffer: RingBuffer;
  readonly cwd: string;
  readonly shell: string;
  readonly createdAt: number;
  lastAttachedAt: number;
  state: "running" | "exited" = "running";
  exitCode?: number;
  private ptyProcess: PtyLike;
  private subscribers = new Set<SubscriberFn>();
  private _attachedClients = 0;

  constructor(
    sessionId: string,
    ptyProcess: PtyLike,
    buffer: RingBuffer,
    cwd: string,
    shell: string,
  ) {
    this.sessionId = sessionId;
    this.ptyProcess = ptyProcess;
    this.buffer = buffer;
    this.cwd = cwd;
    this.shell = shell;
    this.createdAt = Date.now();
    this.lastAttachedAt = this.createdAt;

    this.ptyProcess.onData((data: string) => {
      const seq = this.buffer.write(data);
      const msg: PtyServerMessage = { type: "output", data, seq };
      for (const sub of this.subscribers) {
        sub(msg);
      }
    });

    this.ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      this.state = "exited";
      this.exitCode = exitCode;
      const msg: PtyServerMessage = { type: "exit", code: exitCode };
      for (const sub of this.subscribers) {
        sub(msg);
      }
    });
  }

  get attachedClients(): number {
    return this._attachedClients;
  }

  incrementClients(): void {
    this._attachedClients++;
    this.lastAttachedAt = Date.now();
  }

  decrementClients(): void {
    if (this._attachedClients > 0) {
      this._attachedClients--;
    }
  }

  addSubscriber(fn: SubscriberFn): void {
    this.subscribers.add(fn);
  }

  removeSubscriber(fn: SubscriberFn): void {
    this.subscribers.delete(fn);
  }

  write(data: string): void {
    if (this.state === "running") {
      this.ptyProcess.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    if (this.state === "running") {
      this.ptyProcess.resize(cols, rows);
    }
  }

  kill(): void {
    if (this.state === "running") {
      this.ptyProcess.kill();
    }
  }

  toInfo(): SessionInfo {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      shell: this.shell,
      state: this.state,
      exitCode: this.exitCode,
      createdAt: this.createdAt,
      lastAttachedAt: this.lastAttachedAt,
      attachedClients: this._attachedClients,
    };
  }
}

export class SessionRegistry {
  private sessions = new Map<string, PtySession>();
  private readonly homePath: string;
  private readonly maxSessions: number;
  private readonly bufferSize: number;
  private readonly persistPath: string;
  private readonly spawnFn: SpawnFn;

  constructor(
    homePath: string,
    options?: SessionRegistryOptions,
    spawnFn?: SpawnFn,
  ) {
    this.homePath = homePath;
    this.maxSessions = options?.maxSessions ?? 20;
    this.bufferSize = options?.bufferSize ?? 5 * 1024 * 1024;
    this.persistPath = options?.persistPath ?? join(homePath, "system", "terminal-sessions.json");

    if (spawnFn) {
      this.spawnFn = spawnFn;
    } else {
      // Lazy-load node-pty to avoid import issues in tests
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const nodePty = require("node-pty");
        this.spawnFn = nodePty.spawn as SpawnFn;
      } catch {
        this.spawnFn = () => { throw new Error("node-pty not available"); };
      }
    }

    this.loadPersistedSessions();
  }

  create(cwd: string, shell?: string): string {
    this.evictIfNeeded();

    const sessionId = randomUUID();
    const resolvedShell = shell ?? process.env.SHELL ?? "/bin/bash";
    const validatedCwd = resolveWithinHome(this.homePath, cwd);
    const targetCwd = validatedCwd && existsSync(validatedCwd) ? validatedCwd : this.homePath;

    const buffer = new RingBuffer(this.bufferSize);
    const ptyProcess = this.spawnFn(resolvedShell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: targetCwd,
      env: { ...process.env },
    });

    const session = new PtySession(sessionId, ptyProcess, buffer, targetCwd, resolvedShell);
    this.sessions.set(sessionId, session);
    this.persist();

    return sessionId;
  }

  attach(sessionId: string): SessionHandle | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.incrementClients();

    let subscriberFn: SubscriberFn | null = null;
    let detached = false;

    const handle: SessionHandle = {
      sessionId,

      subscribe(cb: (msg: PtyServerMessage) => void) {
        subscriberFn = cb;
        session.addSubscriber(cb);
      },

      send(msg: ClientMessage) {
        switch (msg.type) {
          case "input":
            session.write(msg.data);
            break;
          case "resize":
            session.resize(msg.cols, msg.rows);
            break;
        }
      },

      replay(fromSeq: number) {
        if (!subscriberFn) return;
        const chunks = session.buffer.getSince(fromSeq);
        subscriberFn({ type: "replay-start", fromSeq });
        for (const chunk of chunks) {
          subscriberFn({ type: "output", data: chunk.data, seq: chunk.seq });
        }
        subscriberFn({ type: "replay-end", toSeq: session.buffer.nextSeq });
      },

      detach() {
        if (detached) return;
        detached = true;
        session.decrementClients();
        if (subscriberFn) {
          session.removeSubscriber(subscriberFn);
          subscriberFn = null;
        }
      },
    };

    return handle;
  }

  destroy(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.kill();
    session.buffer.clear();
    this.sessions.delete(sessionId);
    this.persist();
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.toInfo());
  }

  getSession(sessionId: string): SessionInfo | null {
    const session = this.sessions.get(sessionId);
    return session ? session.toInfo() : null;
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      session.kill();
    }
    this.sessions.clear();
  }

  private evictIfNeeded(): void {
    if (this.sessions.size < this.maxSessions) return;

    // Find oldest orphaned session (no attached clients)
    let oldestOrphan: PtySession | null = null;
    for (const session of this.sessions.values()) {
      if (session.attachedClients > 0) continue;
      if (!oldestOrphan || session.createdAt < oldestOrphan.createdAt) {
        oldestOrphan = session;
      }
    }

    if (oldestOrphan) {
      this.destroy(oldestOrphan.sessionId);
    }
  }

  private persist(): void {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = JSON.stringify(this.list(), null, 2);
      const tmpPath = this.persistPath + ".tmp";
      writeFileSync(tmpPath, data);
      renameSync(tmpPath, this.persistPath);
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error("Failed to persist terminal sessions:", err.message);
      }
    }
  }

  private loadPersistedSessions(): void {
    try {
      const data = readFileSync(this.persistPath, "utf-8");
      const sessions = JSON.parse(data) as SessionInfo[];
      // Only log info about stale sessions; don't re-create PTY processes
      if (sessions.length > 0) {
        console.log(`Found ${sessions.length} stale terminal session(s) from previous run (cleaned up)`);
      }
      // Clean up the stale persist file
      try {
        writeFileSync(this.persistPath, "[]");
      } catch {
        // Ignore cleanup errors
      }
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("Failed to load persisted terminal sessions:", err.message);
      }
    }
  }
}
