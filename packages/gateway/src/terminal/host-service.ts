import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Dir } from "node:fs";
import { mkdir, lstat, opendir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { validateTerminalClosure } from "@matrix-os/terminal-runtime/generation-closure";
import { withTerminalGenerationLock } from "@matrix-os/terminal-runtime/generation-lock";
import { openTerminalLaunchChannel, type PrivateLaunchSpawn } from "../background-launch-channel.js";
import { TerminalHostDescriptorSchema, TerminalHostLaunchSchema, readTerminalHostDescriptor, terminalHostUnit, type TerminalHostDescriptor } from "./host-descriptor.js";
import { createRetainedTerminalBinding } from "./retained-binding.js";
import { inspectTerminalHostUnit, inspectTerminalHostUnits, verifyTerminalHostBinding, type TerminalManagerCommand } from "./host-supervision.js";
import { terminalIoLocation, type TerminalIoReference } from "./io-attach.js";
import type { readLinuxProcess } from "./process-identity.js";
const exec = promisify(execFile), RETENTION_MS = 24 * 60 * 60000;
// Host-unit state only. Native exit code is NOT transported here: it is unknown,
// never inferred as zero from a successful service/attach process. 7c must derive
// native root liveness/exit state independently of this coarse supervisor state.
type Status = "running" | "stopped" | "unknown";
/** Trusted server-only service. No route/UDS createTab may provide onBound/principal.
 * Restored descriptors recover I/O and explicit stop ONLY; they cannot recover source authority. */
export function createTerminalHostService(options: {
  homePath: string; generation: string; runtimeRoot?: string; namespaceRoot?: string; generationLockHelperPath?: string;
  runCommand?: TerminalManagerCommand; spawnPrivate?: PrivateLaunchSpawn; readProcess?: typeof readLinuxProcess;
}) {
  const home = resolve(options.homePath), runtimeRoot = resolve(options.runtimeRoot ?? "/opt/matrix/terminal-runtime"), uid = process.getuid?.();
  if (uid === undefined || !/^gen_[a-f0-9]{64}$/.test(options.generation)) throw new Error("Terminal host unavailable");
  const namespaceRoot = resolve(options.namespaceRoot ?? `/run/user/${uid}`), descriptors = join(home, "system", "terminal-runtimes");
  const helperPath = resolve(options.generationLockHelperPath ?? "/opt/matrix/bin/matrix-terminal-generation-gc.py");
  const env = { PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` };
  const run: TerminalManagerCommand = options.runCommand ?? ((command, args) => exec(command, args, { env, timeout: 15000, maxBuffer: 512 * 1024, encoding: "utf8" }));
  const bindings = new Map<string, ReturnType<typeof createRetainedTerminalBinding>>(); // <=32 retained proof channels; excess launches keep I/O without new proof.
  let sweepDirectory: Dir | undefined;
  let closed = false, queued = 0, tail: Promise<unknown> = Promise.resolve();
  async function storage() {
    if ((await lstat(home)).isSymbolicLink() || !((await lstat(home)).isDirectory())) throw new Error("Terminal storage unavailable");
    let path = await realpath(home);
    for (const part of ["system", "terminal-runtimes"]) {
      path = join(path, part);
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || part === "terminal-runtimes" && info.mode & 0o077) throw new Error("Terminal storage unavailable");
    }
    const namespace = await lstat(namespaceRoot);
    if (!namespace.isDirectory() || namespace.isSymbolicLink() || namespace.uid !== uid || namespace.mode & 0o077) throw new Error("Terminal namespace unavailable");
  }
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    if (closed || queued >= 64) return Promise.reject(new Error("Terminal host unavailable"));
    queued++;
    const work = tail.then(async () => { if (closed) throw new Error("Terminal host closed"); await storage(); return withTerminalGenerationLock({ helperPath, descriptorRoot: descriptors, cwd: home, env }, operation); }).finally(() => { queued--; });
    tail = work.catch(error => console.warn("[terminal-host] Service operation unavailable", error instanceof Error ? error.name : "UnknownError"));
    return work;
  }
  const descriptorPath = (id: string) => join(descriptors, `native-${id}.json`);
  function validateNamespace(descriptor: TerminalHostDescriptor) {
    if (dirname(descriptor.directory) !== namespaceRoot) throw new Error("Terminal namespace mismatch");
    return descriptor;
  }
  async function descriptorFor(reference: TerminalIoReference) {
    const path = terminalIoLocation(reference.path), directory = dirname(path), id = basename(directory).slice("matrix-terminal-".length);
    if (dirname(directory) !== namespaceRoot) throw new Error("Terminal namespace mismatch");
    const { descriptor } = await readTerminalHostDescriptor(descriptorPath(id));
    if (descriptor.directory !== directory || descriptor.launchId !== id) throw new Error("Terminal descriptor mismatch");
    return validateNamespace(descriptor);
  }
  async function status(descriptor: TerminalHostDescriptor): Promise<Status> {
    try { return (await inspectTerminalHostUnit(terminalHostUnit(descriptor.launchId), run)).running ? "running" : "stopped"; }
    catch (error) { console.warn("[terminal-host] Workload state unknown", error instanceof Error ? error.name : "UnknownError"); return "unknown"; }
  }
  async function removeStopped(descriptor: TerminalHostDescriptor) {
    try {
      const info = await lstat(descriptor.directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || info.mode & 0o077) throw new Error("Terminal namespace unavailable");
      await rm(descriptor.directory, { recursive: true });
    } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    await rm(descriptorPath(descriptor.launchId));
  }
  async function sweepBatch() {
    sweepDirectory ??= await opendir(descriptors);
    const inventory: TerminalHostDescriptor[] = []; // <=64 per pass; persistent owner records have no live-session count ceiling.
    for (let scanned = 0; scanned < 512 && inventory.length < 64; scanned++) {
      const entry = await sweepDirectory.read();
      if (!entry) { await sweepDirectory.close(); sweepDirectory = undefined; break; }
      if (!/^native-[a-f0-9]{32}\.json$/.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue;
      try {
        const { descriptor } = await readTerminalHostDescriptor(join(descriptors, entry.name));
        if (entry.name !== `native-${descriptor.launchId}.json`) throw new Error("Terminal descriptor mismatch");
        inventory.push(validateNamespace(descriptor));
      } catch (error) { console.warn("[terminal-host] Retention record unavailable", error instanceof Error ? error.name : "UnknownError"); }
    }
    const states = await inspectTerminalHostUnits(inventory.map(record => terminalHostUnit(record.launchId)), run);
    for (const record of inventory) {
      if (!states.get(terminalHostUnit(record.launchId))!.running && Date.now() - Date.parse(record.createdAt) > RETENTION_MS && !bindings.has(record.launchId)) await removeStopped(record);
    }
  }
  const sweep = () => serial(sweepBatch);
  const timer = setInterval(() => { void sweep().catch(error => console.warn("[terminal-host] Retention deferred", error instanceof Error ? error.name : "UnknownError")); }, 60000); timer.unref();
  return {
    start(input: { launch: TerminalHostDescriptor["launch"]; cols: number; rows: number; onBound?: Parameters<typeof createRetainedTerminalBinding>[0]["onBound"] }) {
      return serial(async () => {
        // Canonical route creation rate-limits remain in their owner. Never impose a live workload ceiling here.
        const generationDirectory = join(runtimeRoot, "generations", options.generation);
        for (const path of [runtimeRoot, join(runtimeRoot, "generations"), generationDirectory]) {
          const info = await lstat(path);
          if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o022) throw new Error("Terminal generation unavailable");
        }
        await validateTerminalClosure(generationDirectory, options.generation);
        const launchId = randomUUID().replaceAll("-", ""), directory = join(namespaceRoot, "matrix-terminal-" + launchId);
        const descriptor = TerminalHostDescriptorSchema.parse({ version: 1, kind: "terminal-native", launchId, generation: options.generation, createdAt: new Date().toISOString(),
          directory, launch: TerminalHostLaunchSchema.parse(input.launch), cols: input.cols, rows: input.rows });
        const payload = JSON.stringify(descriptor);
        if (Buffer.byteLength(payload) > 65536) throw new Error("Terminal launch too large");
        await mkdir(directory, { mode: 0o700 });
        try { await writeFile(descriptorPath(launchId), payload, { mode: 0o600, flag: "wx" }); }
        catch (error) { await rm(directory, { recursive: true }); throw error; } // No workload dispatched yet.
        const digest = createHash("sha256").update(payload).digest("hex"), unit = terminalHostUnit(launchId);
        const args = ["--user", "--quiet", "--collect", `--unit=${unit}`, "--slice=matrix-terminal.slice", "--service-type=exec", "--property=KillMode=control-group",
          "--property=TimeoutStopSec=10s", "--property=MemoryHigh=1G", "--property=MemoryMax=1536M", "--property=TasksMax=1024", "--property=Restart=no",
          "--property=UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH", "--pipe", "--", join(generationDirectory, "node"), join(generationDirectory, "terminal-service.mjs"), descriptorPath(launchId), digest];
        try {
          const channel = await openTerminalLaunchChannel({ args, digest, env, spawn: options.spawnPrivate });
          if (closed || bindings.size >= 32) channel.close();
          else {
            const binding = createRetainedTerminalBinding({ channel, onBound: input.onBound,
              verify: bound => verifyTerminalHostBinding({ unit, generation: options.generation, bound, uid, run, read: options.readProcess }) });
            bindings.set(launchId, binding);
            const retire = () => { queueMicrotask(() => { void binding.close().finally(() => bindings.delete(launchId)); }); };
            binding.signal.addEventListener("abort", retire, { once: true }); if (binding.signal.aborted) retire();
            await binding.ready;
          }
        } catch (error) { console.warn("[terminal-host] Private launch unavailable", error instanceof Error ? error.name : "UnknownError"); }
        // Uncertain private startup never kills a possibly live workload. Keep ownership for recovery.
        return { reference: Object.freeze({ path: join(directory, "io.sock") }), status: await status(descriptor) };
      });
    },
    inspect(reference: TerminalIoReference) { return serial(async () => { const descriptor = await descriptorFor(reference); return { reference: { path: join(descriptor.directory, "io.sock") }, status: await status(descriptor) }; }); },
    stop(reference: TerminalIoReference) {
      return serial(async () => {
        const descriptor = await descriptorFor(reference), binding = bindings.get(descriptor.launchId);
        if (binding) void binding.close(); // Synchronous authority fence happens before any manager await.
        try {
          if (await status(descriptor) === "stopped") return { status: "stopped" as const };
          await run("/usr/bin/systemctl", ["--user", "stop", terminalHostUnit(descriptor.launchId)]);
          return { status: await status(descriptor) === "stopped" ? "stopped" as const : "unknown" as const };
        } catch (error) { console.warn("[terminal-host] Stop unconfirmed", error instanceof Error ? error.name : "UnknownError"); return { status: "unknown" as const }; }
      });
    },
    sweep,
    async close() {
      if (closed) return; closed = true; clearInterval(timer);
      const draining = [...bindings.values()].map(binding => binding.close());
      await tail; if (sweepDirectory) { await sweepDirectory.close(); sweepDirectory = undefined; } await Promise.allSettled(draining); for (const binding of bindings.values()) await binding.close(); bindings.clear();
    },
  };
}
