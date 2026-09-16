import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, opendir, chmod, realpath, open, rm, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { constants } from "node:fs";
import { withBackgroundRuntimeLock } from "./background-runtime-lock.js";
import type { AgentLaunchSpec } from "./agent-launcher.js";

export const BackgroundAgentRefSchema = z.object({ id: z.string().regex(/^bg_[a-f0-9]{32}$/) }).strict();
export type BackgroundAgentRef = z.infer<typeof BackgroundAgentRefSchema>;
export class BackgroundSessionRunningError extends Error {
  constructor() { super("Background session is already running"); this.name = "BackgroundSessionRunningError"; }
}

export interface BackgroundAgentRuntime {
  start(input: { sessionId: string; launch: AgentLaunchSpec; onPrepared?: (ref: BackgroundAgentRef) => Promise<void> }): Promise<BackgroundAgentRef>;
  stop(ref: BackgroundAgentRef): Promise<void>;
  isRunning(ref: BackgroundAgentRef): Promise<boolean>;
  withLock?<T>(operation: (locked: BackgroundAgentRuntime) => Promise<T>): Promise<T>;
}
type RunCommand = (command: string, args: string[], options: {
  env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; encoding: "utf8";
}) => Promise<{ stdout: string; stderr: string }>;
const runDefault = promisify(execFile);
const RUNNER_PATH = fileURLToPath(new URL("./coding-agents/background-agent-runner.mjs", import.meta.url));
const MAX_RECORDS = 512;
const RETENTION_MS = 24 * 60 * 60_000;
const SessionIdSchema = z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/);

/** A background service is independent of Terminal tab inventory and gateway process lifetime. */
export function createBackgroundAgentRuntime(options: {
  homePath: string;
  runCommand?: RunCommand;
  maxJobs?: number;
  withLock?: typeof withBackgroundRuntimeLock;
}): BackgroundAgentRuntime & { sweep(): Promise<void>; close(): Promise<void> } {
  const home = resolve(options.homePath);
  const root = join(home, "system", "background-agents");
  const maxJobs = z.number().int().min(1).max(128).parse(options.maxJobs ?? 32);
  const runCommand = options.runCommand ?? runDefault;
  const uid = process.getuid?.();
  const env = { ...process.env, XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` };
  let tail: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  let closed = false;
  let sweepTimer: NodeJS.Timeout | undefined;
  const withLock = options.withLock ?? withBackgroundRuntimeLock;

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error("Background runtime closed"));
    if (waiting >= 64) return Promise.reject(new Error("Background runtime capacity reached"));
    waiting++;
    const operation = tail.then(async () => {
      await privateDirectory(root);
      return withLock(join(root, ".admission.lock"), fn);
    }).finally(() => { waiting--; });
    tail = operation.catch((error: unknown) => {
      console.warn("[background-agent] operation failed", error instanceof Error ? error.name : "UnknownError");
    });
    return operation;
  }
  function unit(ref: BackgroundAgentRef): string {
    return `matrix-chat-job-${BackgroundAgentRefSchema.parse(ref).id.slice(3)}.service`;
  }
  function run(command: string, args: string[]) {
    return runCommand(command, args, { env, timeout: 15_000, maxBuffer: 128 * 1024, encoding: "utf8" });
  }
  async function privateDirectory(path: string) {
    const rel = relative(home, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Background runtime storage unavailable");
    let current = await realpath(home);
    for (const part of rel.split("/")) {
      current = join(current, part);
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Background runtime storage unavailable");
    }
    await chmod(current, 0o700);
  }
  async function descriptorSession(dir: string): Promise<unknown> {
    const handle = await open(join(dir, "launch.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Background launch invalid");
      return (JSON.parse(await handle.readFile("utf8")) as { sessionId?: unknown }).sessionId;
    } finally { await handle.close(); }
  }
  async function records(): Promise<BackgroundAgentRef[]> {
    await privateDirectory(root);
    const entries = await opendir(root);
    let scanned = 0;
    const refs: BackgroundAgentRef[] = [];
    for await (const entry of entries) {
      if (++scanned > MAX_RECORDS * 2) throw new Error("Background runtime record capacity reached");
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const parsed = BackgroundAgentRefSchema.safeParse({ id: entry.name });
      if (parsed.success) refs.push(parsed.data);
      if (refs.length > MAX_RECORDS) throw new Error("Background runtime record capacity reached");
    }
    return refs;
  }
  async function states(refs: BackgroundAgentRef[]): Promise<Map<string, boolean>> {
    // Bounded by MAX_RECORDS. Query all known services at once, including explicit not-found states.
    const state = new Map<string, boolean>();
    if (refs.length === 0) return state;
    if (refs.length > MAX_RECORDS) throw new Error("Background runtime record capacity reached");
    const names = refs.map(unit);
    const result = await run("/usr/bin/systemctl", ["--user", "show", "--property=Id,LoadState,ActiveState,SubState", ...names]);
    for (const block of result.stdout.trim().split(/\n\s*\n/)) {
      const fields = Object.fromEntries(block.split("\n").map(line => line.split("=", 2)));
      if (!fields.Id || !names.includes(fields.Id)) throw new Error("Background runtime state unavailable");
      if (fields.LoadState === "not-found") state.set(fields.Id, false);
      else if (fields.LoadState === "loaded" && ["inactive", "failed"].includes(fields.ActiveState ?? "")) state.set(fields.Id, false);
      else if (fields.LoadState === "loaded" && ["active", "activating", "deactivating", "reloading"].includes(fields.ActiveState ?? "")) state.set(fields.Id, true);
      else throw new Error("Background runtime state unavailable");
    }
    if (names.some(name => !state.has(name))) throw new Error("Background runtime state unavailable");
    return state;
  }
  async function isRunning(ref: BackgroundAgentRef): Promise<boolean> {
    return (await states([ref])).get(unit(ref))!;
  }
  async function stop(ref: BackgroundAgentRef): Promise<void> {
    const name = unit(ref);
    if (!await isRunning(ref)) return;
    await run("/usr/bin/systemctl", ["--user", "stop", name]);
    if (await isRunning(ref)) throw new Error("Background runtime stop unconfirmed");
  }

  const sweep = () => serial(async () => {
    const refs = await records();
    const live = await states(refs);
    for (const ref of refs) {
      const dir = join(root, ref.id);
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink() || Date.now() - info.mtimeMs <= RETENTION_MS) continue;
      if (!live.get(unit(ref))) await rm(dir, { recursive: true });
    }
  });
  function scheduleSweep() {
    if (sweepTimer || closed) return;
    sweepTimer = setInterval(() => { void sweep().catch((error: unknown) => {
      console.warn("[background-agent] retention sweep deferred", error instanceof Error ? error.name : "UnknownError");
    }); }, 60 * 60_000);
    sweepTimer.unref();
  }
  scheduleSweep();
  const locked: BackgroundAgentRuntime = {
    isRunning,
    stop,
    start: async (input) => {
      SessionIdSchema.parse(input.sessionId);
      let active = 0;
      let retained = 0;
      const refs = await records();
      const inventory = await states(refs);
      for (const ref of refs) {
        const live = inventory.get(unit(ref));
        const dir = join(root, ref.id);
        const info = await lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        if (!live && Date.now() - info.mtimeMs > RETENTION_MS) {
          await rm(dir, { recursive: true });
          continue;
        }
        retained++;
        if (live) {
          active++;
          if (await descriptorSession(dir) === input.sessionId) throw new BackgroundSessionRunningError();
        }
      }
      if (active >= maxJobs || retained >= MAX_RECORDS) throw new Error("Background runtime capacity reached");
      const ref = { id: `bg_${randomUUID().replaceAll("-", "")}` };
      const dir = join(root, ref.id);
      const launchPath = join(dir, "launch.json");
      const payload = JSON.stringify({ sessionId: input.sessionId, launch: input.launch });
      if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error("Background launch is too large");
      await privateDirectory(dir);
      await writeFile(launchPath, payload, { flag: "wx", mode: 0o600 });
      try {
        await input.onPrepared?.(ref);
        await run("/usr/bin/systemd-run", [
          "--user", "--quiet", "--collect", `--unit=${unit(ref)}`,
          "--slice=matrix-terminal.slice", "--service-type=exec",
          "--property=KillMode=control-group", "--property=TimeoutStopSec=10s",
          "--property=MemoryHigh=1G", "--property=MemoryMax=1536M", "--property=TasksMax=1024",
          "--property=Restart=no", "--property=StandardOutput=null", "--property=StandardError=null",
          "--", process.execPath, RUNNER_PATH, launchPath,
        ]);
        if (!await isRunning(ref)) throw new Error("Background runtime exited during startup");
      } catch (error: unknown) {
        // Keep the private descriptor if stop cannot be confirmed, for recovery/admission.
        await stop(ref);
        await rm(dir, { recursive: true });
        throw error;
      }
      return ref;

    },
  };
  return {
    sweep,
    async close() { closed = true; if (sweepTimer) clearInterval(sweepTimer); await tail; },
    withLock: (operation) => serial(() => operation(locked)),
    isRunning: (ref) => serial(() => isRunning(ref)),
    stop: (ref) => serial(() => stop(ref)),
    start: (input) => serial(() => locked.start(input)),
  };
}
