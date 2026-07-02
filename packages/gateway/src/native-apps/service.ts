import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { PortPool } from "../app-runtime/port-pool.js";
import {
  SAFE_NATIVE_APP_ID,
  SAFE_NATIVE_SESSION_ID,
  listEnabledNativeApps,
  type NativeAppDefinition,
} from "./registry.js";

export type NativeAppSessionStatus = "starting" | "running" | "exited" | "terminated" | "failed";

export interface NativeAppSession {
  id: string;
  ownerId: string;
  appId: string;
  status: NativeAppSessionStatus;
  streamUrl: string;
  display: number;
  port: number;
  pid: number | null;
  width: number;
  height: number;
  createdAt: number;
  lastTouched: number;
  expiresAt: number;
}

interface NativeAppSessionRecord extends NativeAppSession {
  app: NativeAppDefinition;
  child: NativeAppChildProcess | null;
  streamToken: string;
}

export interface NativeAppChildProcess {
  pid?: number;
  stderr?: Pick<EventEmitter, "on"> | null;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once?(event: "exit", listener: () => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface NativeAppLaunchInput {
  ownerId: string;
  appId: string;
  width?: number;
  height?: number;
}

export type NativeAppErrorCode =
  | "app_unavailable"
  | "invalid_request"
  | "misconfigured"
  | "native_unavailable"
  | "not_found"
  | "session_limit"
  | "spawn_failed";

export class NativeAppError extends Error {
  constructor(
    readonly code: NativeAppErrorCode,
    readonly status: 400 | 404 | 409 | 500 | 503,
    readonly clientMessage: string,
    message = clientMessage,
  ) {
    super(message);
    this.name = "NativeAppError";
  }
}

export interface NativeAppSessionServiceOptions {
  registry: NativeAppDefinition[];
  commandExists?: (command: string) => Promise<boolean>;
  displayPool?: PortPool;
  getuid?: () => number | undefined;
  maxSessionsTotal?: number;
  maxSessionsPerOwner?: number;
  now?: () => number;
  portPool?: PortPool;
  randomId?: (prefix: "session" | "stream") => string;
  readinessProbe?: (port: number) => Promise<boolean>;
  readinessRetryMs?: number;
  readinessTimeoutMs?: number;
  reaperIntervalMs?: number;
  sessionTtlMs?: number;
  stopGraceMs?: number;
  spawn?: (command: string, args: string[], options: Parameters<typeof nodeSpawn>[2]) => NativeAppChildProcess;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const COMMAND_CHECK_TIMEOUT_MS = 3000;
const READINESS_RETRY_MS = 100;
const READINESS_TIMEOUT_MS = 5000;
const SIGTERM_GRACE_MS = 5000;
const SAFE_XPRA_CHILD_ARG = /^[A-Za-z0-9_./:@%+=,-]+$/;

function defaultRandomId(prefix: "session" | "stream"): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function sessionView(record: NativeAppSessionRecord): NativeAppSession {
  const {
    app: _app,
    child: _child,
    streamToken: _streamToken,
    ...session
  } = record;
  return { ...session };
}

async function defaultCommandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = nodeSpawn(command, ["--version"], {
      stdio: "ignore",
      detached: false,
    });
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(available);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
          console.warn("[native-apps] command check kill failed:", err instanceof Error ? err.message : String(err));
        }
      }
      finish(false);
    }, COMMAND_CHECK_TIMEOUT_MS);
    timer.unref?.();
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

async function defaultReadinessProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (ready: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class NativeAppSessionService {
  private readonly commandExists: (command: string) => Promise<boolean>;
  private readonly displayPool: PortPool;
  private readonly getuid: () => number | undefined;
  private readonly maxSessionsPerOwner: number;
  private readonly maxSessionsTotal: number;
  private readonly now: () => number;
  private readonly portPool: PortPool;
  private readonly randomId: (prefix: "session" | "stream") => string;
  private readonly readinessProbe: (port: number) => Promise<boolean>;
  private readonly readinessRetryMs: number;
  private readonly readinessTimeoutMs: number;
  private readonly registry: NativeAppDefinition[];
  private readonly sessionTtlMs: number;
  private readonly stopGraceMs: number;
  private readonly sessions = new Map<string, NativeAppSessionRecord>();
  private readonly spawnProcess: (command: string, args: string[], options: Parameters<typeof nodeSpawn>[2]) => NativeAppChildProcess;
  private readonly reaper: ReturnType<typeof setInterval> | null;

  constructor(options: NativeAppSessionServiceOptions) {
    this.registry = options.registry;
    this.commandExists = options.commandExists ?? defaultCommandExists;
    this.displayPool = options.displayPool ?? new PortPool({ min: 100, max: 199, cap: 32 });
    this.getuid = options.getuid ?? (() => process.getuid?.());
    this.maxSessionsPerOwner = options.maxSessionsPerOwner ?? 3;
    this.maxSessionsTotal = options.maxSessionsTotal ?? 32;
    this.now = options.now ?? Date.now;
    this.portPool = options.portPool ?? new PortPool({ min: 46000, max: 46063, cap: 32 });
    this.randomId = options.randomId ?? defaultRandomId;
    this.readinessProbe = options.readinessProbe ?? defaultReadinessProbe;
    this.readinessRetryMs = options.readinessRetryMs ?? READINESS_RETRY_MS;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_TTL_MS;
    this.stopGraceMs = options.stopGraceMs ?? SIGTERM_GRACE_MS;
    this.spawnProcess = options.spawn ?? ((command, args, spawnOptions) =>
      nodeSpawn(command, args, spawnOptions) as ChildProcess as NativeAppChildProcess);

    const reaperIntervalMs = options.reaperIntervalMs ?? 60_000;
    if (reaperIntervalMs > 0) {
      this.reaper = setInterval(() => {
        this.cleanupExpiredSessions().catch((err: unknown) => {
          console.warn("[native-apps] cleanup pass failed:", err instanceof Error ? err.message : String(err));
        });
      }, reaperIntervalMs);
      this.reaper.unref?.();
    } else {
      this.reaper = null;
    }
  }

  listApps(): NativeAppDefinition[] {
    return listEnabledNativeApps(this.registry).map((app) => ({
      ...app,
      command: [...app.command],
      permissions: { ...app.permissions },
    }));
  }

  async launchSession(input: NativeAppLaunchInput): Promise<NativeAppSession> {
    await this.cleanupExpiredSessions();
    if (!SAFE_NATIVE_APP_ID.test(input.appId)) {
      throw new NativeAppError("invalid_request", 400, "Invalid request");
    }
    const app = this.listApps().find((candidate) => candidate.id === input.appId);
    if (!app) {
      throw new NativeAppError("app_unavailable", 404, "Native app is not available");
    }
    if (this.getuid() === 0) {
      throw new NativeAppError("misconfigured", 500, "Native apps are not available on this runtime", "root launch refused");
    }
    if (this.activeSessionCountForOwner(input.ownerId) >= this.maxSessionsPerOwner) {
      throw new NativeAppError("session_limit", 409, "Native app session limit reached");
    }
    if (this.sessions.size >= this.maxSessionsTotal) {
      await this.evictLeastRecentlyTouched();
    }
    if (this.sessions.size >= this.maxSessionsTotal) {
      throw new NativeAppError("session_limit", 409, "Native app session limit reached");
    }
    if (!await this.commandExists("xpra")) {
      throw new NativeAppError("native_unavailable", 503, "Native apps are not available on this runtime", "xpra missing");
    }

    const id = this.randomId("session");
    if (!SAFE_NATIVE_SESSION_ID.test(id) || this.sessions.has(id)) {
      throw new NativeAppError("misconfigured", 500, "Native apps are not available on this runtime", "invalid generated session id");
    }
    const streamToken = this.randomId("stream");
    const port = this.portPool.allocate();
    const display = this.displayPool.allocate();
    const now = this.now();
    const width = input.width ?? app.defaultWidth;
    const height = input.height ?? app.defaultHeight;

    const record: NativeAppSessionRecord = {
      id,
      ownerId: input.ownerId,
      appId: app.id,
      app,
      status: "starting",
      streamUrl: `/api/native-apps/sessions/${id}/stream/`,
      display,
      port,
      pid: null,
      width,
      height,
      createdAt: now,
      lastTouched: now,
      expiresAt: now + this.sessionTtlMs,
      child: null,
      streamToken,
    };
    this.sessions.set(id, record);

    try {
      const args = this.buildXpraArgs(app, display, port);
      const child = this.spawnProcess("xpra", args, {
        cwd: "/tmp",
        env: this.buildEnvironment(width, height),
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
      });
      record.child = child;
      record.pid = child.pid ?? null;
      this.attachChildHandlers(record, child);
      await this.waitForReadiness(record.port);
      if (record.status !== "starting") {
        throw new Error("native app exited before stream became ready");
      }
      record.status = "running";
      return sessionView(record);
    } catch (err: unknown) {
      await this.stopRecord(record, "failed");
      this.sessions.delete(id);
      console.warn("[native-apps] launch failed:", err instanceof Error ? err.message : String(err));
      throw new NativeAppError("spawn_failed", 503, "Native apps are not available on this runtime");
    }
  }

  inspectSession(ownerId: string, sessionId: string): NativeAppSession | null {
    const record = this.getOwnedRecord(ownerId, sessionId);
    if (!record) return null;
    record.lastTouched = this.now();
    return sessionView(record);
  }

  async terminateSession(ownerId: string, sessionId: string): Promise<NativeAppSession> {
    const record = this.getOwnedRecord(ownerId, sessionId);
    if (!record) {
      throw new NativeAppError("not_found", 404, "Native app session not found");
    }
    await this.stopRecord(record, "terminated");
    this.sessions.delete(sessionId);
    return sessionView(record);
  }

  getStreamTarget(sessionId: string, streamToken: string): { port: number } | null {
    const record = this.sessions.get(sessionId);
    if (!record || record.streamToken !== streamToken || record.status !== "running") return null;
    record.lastTouched = this.now();
    return { port: record.port };
  }

  streamCookieName(sessionId: string): string {
    return `matrix_native_session__${sessionId}`;
  }

  streamCookieValue(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.streamToken ?? null;
  }

  async cleanupExpiredSessions(): Promise<void> {
    const now = this.now();
    const stops: Array<Promise<void>> = [];
    for (const record of this.sessions.values()) {
      if (record.expiresAt <= now || record.lastTouched + this.sessionTtlMs <= now) {
        stops.push(this.stopRecord(record, "terminated"));
      }
    }
    await Promise.allSettled(stops);
    for (const [id, record] of this.sessions) {
      if (record.status === "terminated" || record.status === "exited" || record.status === "failed") {
        this.sessions.delete(id);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    await Promise.allSettled([...this.sessions.values()].map((record) => this.stopRecord(record, "terminated")));
    this.sessions.clear();
  }

  private buildXpraArgs(app: NativeAppDefinition, display: number, port: number): string[] {
    if (app.command.length === 0 || app.command.some((arg) => !SAFE_XPRA_CHILD_ARG.test(arg))) {
      throw new NativeAppError("misconfigured", 500, "Native apps are not available on this runtime", "unsafe native app command");
    }
    return [
      "start",
      `:${display}`,
      `--start-child=${app.command.join(" ")}`,
      "--exit-with-children",
      `--bind-tcp=127.0.0.1:${port}`,
      "--html=on",
      "--daemon=no",
      app.permissions.clipboard ? "--clipboard=yes" : "--clipboard=no",
    ];
  }

  private buildEnvironment(width: number, height: number): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG ?? "C.UTF-8",
      MATRIX_NATIVE_APP_WIDTH: String(width),
      MATRIX_NATIVE_APP_HEIGHT: String(height),
    };
  }

  private attachChildHandlers(record: NativeAppSessionRecord, child: NativeAppChildProcess): void {
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail += chunk.toString();
      if (stderrTail.length > 4096) stderrTail = stderrTail.slice(-2048);
    });
    child.on("error", (err) => {
      console.warn("[native-apps] child error:", err.message);
      record.status = "failed";
      this.releaseRecord(record);
    });
    child.on("exit", () => {
      if (record.status !== "terminated") record.status = "exited";
      this.releaseRecord(record);
      this.sessions.delete(record.id);
    });
  }

  private activeSessionCountForOwner(ownerId: string): number {
    let count = 0;
    for (const record of this.sessions.values()) {
      if (record.ownerId === ownerId && (record.status === "starting" || record.status === "running")) {
        count++;
      }
    }
    return count;
  }

  private async waitForReadiness(port: number): Promise<void> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    do {
      if (await this.readinessProbe(port)) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(this.readinessRetryMs, remaining));
    } while (Date.now() <= deadline);
    throw new Error("native app stream did not become ready");
  }

  private getOwnedRecord(ownerId: string, sessionId: string): NativeAppSessionRecord | null {
    if (!SAFE_NATIVE_SESSION_ID.test(sessionId)) return null;
    const record = this.sessions.get(sessionId);
    if (!record || record.ownerId !== ownerId) return null;
    return record;
  }

  private async evictLeastRecentlyTouched(): Promise<void> {
    let candidate: NativeAppSessionRecord | null = null;
    for (const record of this.sessions.values()) {
      if (!candidate || record.lastTouched < candidate.lastTouched) {
        candidate = record;
      }
    }
    if (candidate) {
      await this.stopRecord(candidate, "terminated");
      this.sessions.delete(candidate.id);
    }
  }

  private async stopRecord(record: NativeAppSessionRecord, finalStatus: "terminated" | "failed"): Promise<void> {
    const child = record.child;
    record.status = finalStatus;
    if (!child) {
      this.releaseRecord(record);
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
            console.warn("[native-apps] SIGKILL failed:", err instanceof Error ? err.message : String(err));
          }
        }
        resolve();
      }, this.stopGraceMs);
      timer.unref?.();
      child.once?.("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch (err: unknown) {
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
          console.warn("[native-apps] SIGTERM failed:", err instanceof Error ? err.message : String(err));
        }
        resolve();
      }
    });
    this.releaseRecord(record);
  }

  private releaseRecord(record: NativeAppSessionRecord): void {
    record.child = null;
    record.pid = null;
    this.portPool.release(record.port);
    this.displayPool.release(record.display);
  }
}
