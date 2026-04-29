import { z } from "zod/v4";
import { randomUUID } from "node:crypto";
import { writeFile, rename, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { RingBuffer } from "./ring-buffer.js";
import { resolveWithinHome } from "./path-security.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_DEBUG_ENABLED = process.env.TERMINAL_DEBUG === "1";
export const MIN_TERMINAL_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function logTerminalDebug(event: string, details: Record<string, unknown> = {}): void {
  if (!TERMINAL_DEBUG_ENABLED) {
    return;
  }
  console.info("[terminal-debug][registry]", event, details);
}

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

const DestroySchema = z.object({
  type: z.literal("destroy"),
});

const PingSchema = z.object({
  type: z.literal("ping"),
});

export const ClientMessageSchema = z.union([AttachSchema, InputSchema, ResizeSchema, DetachSchema, DestroySchema, PingSchema]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export { AttachSchema, AttachNewSchema, AttachExistingSchema, InputSchema, ResizeSchema, DetachSchema, DestroySchema, PingSchema, UUID_REGEX };

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

const ExternalSessionRegistrationSchema = z.object({
  sessionId: z.string().regex(UUID_REGEX).optional(),
  cwd: z.string().min(1).max(4096),
  command: z.enum(["zellij", "tmux"]),
  args: z.array(z.string().max(4096)).max(64),
});

export interface ExternalSessionRegistration {
  sessionId?: string;
  cwd: string;
  command: "zellij" | "tmux";
  args: string[];
}

const PersistedSessionInfoSchema = z.object({
  sessionId: z.string().regex(UUID_REGEX),
  cwd: z.string().min(1).max(4096),
  shell: z.string().min(1).max(256),
  state: z.enum(["running", "exited"]),
  exitCode: z.number().int().optional(),
  createdAt: z.number().finite(),
  lastAttachedAt: z.number().finite(),
  attachedClients: z.number().int().nonnegative(),
});

export type PtyServerMessage =
  | { type: "attached"; sessionId: string; state: "running" | "exited"; exitCode?: number }
  | { type: "output"; data: string; seq?: number }
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
  allowedShells?: string[];
  sessionTtlMs?: number;
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

function splitByUtf8Bytes(data: string, maxBytes: number): string[] {
  if (Buffer.byteLength(data) <= maxBytes) {
    return [data];
  }

  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const char of data) {
    const charBytes = Buffer.byteLength(char);
    if (currentBytes > 0 && currentBytes + charBytes > maxBytes) {
      chunks.push(current);
      current = char;
      currentBytes = charBytes;
      continue;
    }
    current += char;
    currentBytes += charBytes;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

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
  private static readonly MAX_SUBSCRIBERS = 10;
  private subscribers = new Set<SubscriberFn>();
  private _attachedClients = 0;

  constructor(
    sessionId: string,
    ptyProcess: PtyLike,
    buffer: RingBuffer,
    cwd: string,
    shell: string,
    metadata?: Pick<SessionInfo, "createdAt" | "lastAttachedAt">,
  ) {
    this.sessionId = sessionId;
    this.ptyProcess = ptyProcess;
    this.buffer = buffer;
    this.cwd = cwd;
    this.shell = shell;
    this.createdAt = metadata?.createdAt ?? Date.now();
    this.lastAttachedAt = metadata?.lastAttachedAt ?? this.createdAt;

    this.ptyProcess.onData((data: string) => {
      for (const chunk of splitByUtf8Bytes(data, this.buffer.capacityBytes)) {
        const seq = this.buffer.write(chunk);
        if (seq === null) {
          console.warn("Dropped oversized terminal output chunk");
          continue;
        }
        const msg: PtyServerMessage = { type: "output", data: chunk, seq };
        for (const sub of this.subscribers) {
          sub(msg);
        }
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
    if (this.subscribers.size >= PtySession.MAX_SUBSCRIBERS) {
      throw new Error("Too many subscribers");
    }
    this.subscribers.add(fn);
  }

  removeSubscriber(fn: SubscriberFn): void {
    this.subscribers.delete(fn);
  }

  clearSubscribers(): void {
    this.subscribers.clear();
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

const DEFAULT_ALLOWED_SHELLS = new Set([
  "/bin/bash", "/bin/sh", "/bin/zsh",
  "/usr/bin/bash", "/usr/bin/zsh", "/usr/bin/fish",
  "/usr/local/bin/bash", "/usr/local/bin/zsh", "/usr/local/bin/fish",
]);

export class SessionRegistry {
  private sessions = new Map<string, PtySession>();
  private readonly homePath: string;
  private readonly maxSessions: number;
  private readonly bufferSize: number;
  private readonly persistPath: string;
  private readonly spawnFn: SpawnFn;
  private readonly allowedShells: Set<string>;
  private readonly sessionTtlMs: number;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    homePath: string,
    options?: SessionRegistryOptions,
    spawnFn?: SpawnFn,
  ) {
    this.homePath = homePath;
    this.maxSessions = options?.maxSessions ?? 20;
    this.bufferSize = options?.bufferSize ?? 5 * 1024 * 1024;
    this.persistPath = options?.persistPath ?? join(homePath, "system", "terminal-sessions.json");
    this.sessionTtlMs = normalizeSessionTtl(options?.sessionTtlMs);
    this.allowedShells = options?.allowedShells
      ? new Set(options.allowedShells)
      : DEFAULT_ALLOWED_SHELLS;

    if (spawnFn) {
      this.spawnFn = spawnFn;
    } else {
      try {
        const esmRequire = createRequire(import.meta.url);
        const nodePty = esmRequire("node-pty");
        this.spawnFn = nodePty.spawn as SpawnFn;
      } catch (err: unknown) {
        console.warn("node-pty unavailable, terminal sessions disabled:", err instanceof Error ? err.message : err);
        this.spawnFn = () => { throw new Error("node-pty not available"); };
      }
    }

    this.loadPersistedSessions();
  }

  create(cwd: string, shell?: string): string {
    this.evictExpiredSessions();
    this.evictIfNeeded();

    if (this.sessions.size >= this.maxSessions) {
      throw new Error("Session limit reached");
    }

    const sessionId = randomUUID();
    const envShell = process.env.SHELL ?? "/bin/bash";
    const defaultShell = this.allowedShells.has(envShell) ? envShell : "/bin/bash";
    const resolvedShell = shell && this.allowedShells.has(shell) ? shell : defaultShell;
    const buffer = new RingBuffer(this.bufferSize);
    const validatedCwd = resolveWithinHome(this.homePath, cwd);
    const initialCwd = validatedCwd && existsSync(validatedCwd) ? validatedCwd : this.homePath;
    let ptyProcess: PtyLike;
    let targetCwd = initialCwd;
    try {
      ptyProcess = this.spawnFn(resolvedShell, [], this.spawnOptions(targetCwd, resolvedShell));
    } catch (error) {
      if (targetCwd !== this.homePath) {
        targetCwd = this.homePath;
        ptyProcess = this.spawnFn(resolvedShell, [], this.spawnOptions(targetCwd, resolvedShell));
      } else {
        throw error;
      }
    }

    const session = new PtySession(sessionId, ptyProcess, buffer, targetCwd, resolvedShell);
    this.sessions.set(sessionId, session);
    this.schedulePersist();
    logTerminalDebug("create", {
      sessionId,
      cwd: targetCwd,
      shell: resolvedShell,
      totalSessions: this.sessions.size,
    });

    return sessionId;
  }

  registerExternal(input: ExternalSessionRegistration): string {
    this.evictExpiredSessions();
    this.evictIfNeeded();

    if (this.sessions.size >= this.maxSessions) {
      throw new Error("Session limit reached");
    }

    const parsed = ExternalSessionRegistrationSchema.parse(input);
    const sessionId = parsed.sessionId ?? randomUUID();
    const validatedCwd = resolveWithinHome(this.homePath, parsed.cwd);
    const targetCwd = validatedCwd && existsSync(validatedCwd) ? validatedCwd : this.homePath;
    const buffer = new RingBuffer(this.bufferSize);
    const ptyProcess = this.spawnFn(
      parsed.command,
      parsed.args,
      this.spawnOptions(targetCwd, "/bin/bash"),
    );

    const session = new PtySession(sessionId, ptyProcess, buffer, targetCwd, parsed.command);
    this.sessions.set(sessionId, session);
    this.schedulePersist();
    logTerminalDebug("register-external", {
      sessionId,
      cwd: targetCwd,
      command: parsed.command,
      totalSessions: this.sessions.size,
    });

    return sessionId;
  }

  attach(sessionId: string): SessionHandle | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      logTerminalDebug("attach-miss", { sessionId, totalSessions: this.sessions.size });
      return null;
    }

    logTerminalDebug("attach", {
      sessionId,
      attachedClients: session.attachedClients,
      state: session.state,
    });

    let subscriberFn: SubscriberFn | null = null;
    let detached = false;

    const handle: SessionHandle = {
      sessionId,

      subscribe(cb: (msg: PtyServerMessage) => void) {
        if (detached) return;

        const previousSubscriber = subscriberFn;
        if (previousSubscriber) {
          session.removeSubscriber(previousSubscriber);
        }

        try {
          session.addSubscriber(cb);
        } catch (error) {
          if (previousSubscriber) {
            session.addSubscriber(previousSubscriber);
          }
          throw error;
        }

        subscriberFn = cb;
        if (!previousSubscriber) {
          session.incrementClients();
        }
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
        logTerminalDebug("detach", {
          sessionId,
          hadSubscriber: !!subscriberFn,
          attachedClientsBefore: session.attachedClients,
        });
        if (subscriberFn) {
          session.removeSubscriber(subscriberFn);
          session.decrementClients();
          subscriberFn = null;
        }
      },
    };

    return handle;
  }

  destroy(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    logTerminalDebug("destroy", {
      sessionId,
      attachedClients: session.attachedClients,
      state: session.state,
      totalSessionsBefore: this.sessions.size,
    });

    try {
      session.kill();
    } catch (error: unknown) {
      console.warn(
        "Failed to kill terminal session:",
        error instanceof Error ? error.message : String(error),
      );
    }
    session.clearSubscribers();
    session.buffer.clear();
    this.sessions.delete(sessionId);
    this.schedulePersist();
  }

  list(): SessionInfo[] {
    this.evictExpiredSessions();
    return Array.from(this.sessions.values()).map((s) => s.toInfo());
  }

  getSession(sessionId: string): SessionInfo | null {
    this.evictExpiredSessions();
    const session = this.sessions.get(sessionId);
    return session ? session.toInfo() : null;
  }

  async shutdown(): Promise<void> {
    clearTimeout(this.persistTimer);
    for (const session of this.sessions.values()) {
      session.kill();
    }
    this.sessions.clear();
    await this.persistNow();
  }

  private evictIfNeeded(): void {
    if (this.sessions.size < this.maxSessions) return;

    let candidate: PtySession | null = null;
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.attachedClients > 0) continue;
      if (!this.isExpired(session, now)) continue;
      if (!candidate) { candidate = session; continue; }
      // Prefer exited over running, then oldest
      if (session.state === "exited" && candidate.state !== "exited") {
        candidate = session;
      } else if (session.state === candidate.state && session.createdAt < candidate.createdAt) {
        candidate = session;
      }
    }

    if (candidate) {
      logTerminalDebug("evict", {
        sessionId: candidate.sessionId,
        state: candidate.state,
        attachedClients: candidate.attachedClients,
      });
      this.destroy(candidate.sessionId);
    }
  }

  private evictExpiredSessions(now = Date.now()): void {
    for (const session of this.sessions.values()) {
      if (session.attachedClients > 0) continue;
      if (!this.isExpired(session, now)) continue;
      logTerminalDebug("evict-expired", {
        sessionId: session.sessionId,
        state: session.state,
        lastAttachedAt: session.lastAttachedAt,
        sessionTtlMs: this.sessionTtlMs,
      });
      this.destroy(session.sessionId);
    }
  }

  private isExpired(session: Pick<PtySession, "lastAttachedAt">, now: number): boolean {
    return now - session.lastAttachedAt >= this.sessionTtlMs;
  }

  private schedulePersist(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      void this.persistNow();
    }, 100);
  }

  private spawnOptions(targetCwd: string, resolvedShell: string): Record<string, unknown> {
    const userLocalBin = join(this.homePath, ".local", "bin");
    return {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: targetCwd,
      env: {
        PATH: `${userLocalBin}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
        HOME: this.homePath,
        TERM: "xterm-256color",
        LANG: process.env.LANG ?? "en_US.UTF-8",
        SHELL: resolvedShell,
        ZDOTDIR: this.homePath,
        USER: process.env.MATRIX_HANDLE || process.env.USER || "matrixos",
        LOGNAME: process.env.MATRIX_HANDLE || process.env.LOGNAME || "matrixos",
        ...(process.env.MATRIX_HANDLE ? { MATRIX_HANDLE: process.env.MATRIX_HANDLE } : {}),
        ...(process.env.MATRIX_DISPLAY_NAME ? { MATRIX_DISPLAY_NAME: process.env.MATRIX_DISPLAY_NAME } : {}),
        ...(process.env.MATRIX_HOME ? { MATRIX_HOME: process.env.MATRIX_HOME } : {}),
      },
    };
  }

  private persistNow(): Promise<void> {
    const runPersist = () => {
      const data = JSON.stringify(this.list(), null, 2);
      const dir = dirname(this.persistPath);
      const tmpPath = this.persistPath + ".tmp";
      return mkdir(dir, { recursive: true })
        .then(() => writeFile(tmpPath, data))
        .then(() => rename(tmpPath, this.persistPath))
        .catch((err: unknown) => {
          if (err instanceof Error) {
            console.error("Failed to persist terminal sessions:", err.message);
          }
        });
    };

    this.persistQueue = this.persistQueue.then(runPersist, runPersist);
    return this.persistQueue;
  }

  private loadPersistedSessions(): void {
    try {
      const data = readFileSync(this.persistPath, "utf-8");
      const raw: unknown = JSON.parse(data);
      let sessions: SessionInfo[] = [];
      if (!Array.isArray(raw)) {
        console.warn("Stale terminal sessions file is corrupt, ignoring");
      } else {
        const parsed = z.array(PersistedSessionInfoSchema).safeParse(raw);
        if (!parsed.success) {
          console.warn("Stale terminal sessions file has invalid entries, ignoring");
        } else {
          sessions = parsed.data;
        }
      }

      const now = Date.now();
      let restored = 0;
      let expired = 0;
      for (const session of sessions) {
        if (session.state !== "running" || this.isExpired(session, now)) {
          expired += 1;
          continue;
        }
        if (this.sessions.size >= this.maxSessions) {
          break;
        }
        if (this.restorePersistedSession(session)) {
          restored += 1;
        }
      }

      if (restored > 0 || expired > 0) {
        console.log(`Restored ${restored} terminal session(s); cleaned up ${expired} expired/stale session(s)`);
      }
      this.schedulePersist();
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("Failed to load persisted terminal sessions:", err.message);
      }
    }
  }

  private restorePersistedSession(info: SessionInfo): boolean {
    try {
      const shell = this.allowedShells.has(info.shell) ? info.shell : "/bin/bash";
      const validatedCwd = resolveWithinHome(this.homePath, info.cwd);
      const targetCwd = validatedCwd && existsSync(validatedCwd) ? validatedCwd : this.homePath;
      const ptyProcess = this.spawnFn(shell, [], this.spawnOptions(targetCwd, shell));
      const session = new PtySession(
        info.sessionId,
        ptyProcess,
        new RingBuffer(this.bufferSize),
        targetCwd,
        shell,
        {
          createdAt: info.createdAt,
          lastAttachedAt: info.lastAttachedAt,
        },
      );
      this.sessions.set(info.sessionId, session);
      return true;
    } catch (err: unknown) {
      console.warn(
        "Failed to restore terminal session:",
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }
}

function normalizeSessionTtl(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return MIN_TERMINAL_SESSION_TTL_MS;
  }
  return Math.max(value, MIN_TERMINAL_SESSION_TTL_MS);
}
