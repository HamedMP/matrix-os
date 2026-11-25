// The core on added machines (spec 2706 layer 8). herdr-core's own CLI
// already installs and upgrades itself on a machine over the same ssh line:
// `machine add --install` copies its own pinned version when the machine has
// none or an older one, and `machine update` replaces it there and restarts
// it while its terminals keep running. The app reuses that, running its own
// bundled core's CLI against its private core, so the version on every
// machine is the one the app ships. One install or update runs per machine.
import { execFile } from "node:child_process";
import { z } from "zod/v4";
import { describeError } from "./describe-error";

/** An install downloads (on the core's side) and copies the binary over ssh. */
const INSTALL_TIMEOUT_MS = 3 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_RUNNING = 64;

/** `changed`: the name now belongs to a different machine than the one picked. */
/** `unsupported`: a target the app cannot update the core of (a Windows machine). */
export type MachineCoreResult = { ok: true } | { ok: false; reason: "failed" | "busy" | "unavailable" | "changed" | "unsupported" };

export interface MachineCoreRunner {
  (binary: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<void>;
}

export const runCoreCli: MachineCoreRunner = (binary, args, env, timeoutMs) => new Promise((resolve, reject) => {
  execFile(binary, args, { env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }, (error) => {
    if (error) reject(error);
    else resolve();
  });
});

export function createMachineCore(options: {
  /** The bundled core binary and its private environment, or null when this build has none. */
  cli(): Promise<{ binary: string; env: Record<string, string> } | null>;
  run?: MachineCoreRunner;
}) {
  const run = options.run ?? runCoreCli;
  // One install or update per machine; bounded by the machines a core keeps.
  const running = new Map<string, { args: string; job: Promise<MachineCoreResult> }>();

  const once = async (name: string, args: string[]): Promise<MachineCoreResult> => {
    const existing = running.get(name);
    // Only the same request shares a running job; a different one for that machine waits its turn.
    if (existing) return existing.args === JSON.stringify(args) ? existing.job : { ok: false, reason: "busy" };
    if (running.size >= MAX_RUNNING) return { ok: false, reason: "busy" };
    const job = (async (): Promise<MachineCoreResult> => {
      const cli = await options.cli();
      if (!cli) return { ok: false, reason: "unavailable" };
      try {
        await run(cli.binary, args, cli.env, INSTALL_TIMEOUT_MS);
        return { ok: true };
      } catch (error: unknown) {
        // The reason stays in the main-process log; the window sees a fixed outcome.
        console.warn("[local-terminals] machine core install failed:", describeError(error));
        return { ok: false, reason: "failed" };
      }
    })().finally(() => running.delete(name));
    running.set(name, { args: JSON.stringify(args), job });
    return job;
  };

  return {
    /** Adds a machine that has no core (or an old one), installing the app's version there. */
    install(input: { name: string; target: string; via?: string }): Promise<MachineCoreResult> {
      return once(input.name, ["machine", "add", "--install", "--name", input.name,
        ...(input.via ? ["--via", input.via] : ["--", input.target])]);
    },
    /** Replaces an added machine's core with the app's version; its terminals keep running. */
    update(name: string): Promise<MachineCoreResult> {
      return once(name, ["machine", "update", "--", name]);
    },
    running: (name: string) => running.has(name),
  };
}

const PROBE_TIMEOUT_MS = 20_000;
const ProbeStatusSchema = z.object({ core: z.object({ id: z.string().regex(/^[0-9a-f]{8,64}$/) }) });

/** The machine is not one the probe can read (a Windows target): its core is not updated from here. */
export class MachineCoreUnsupportedError extends Error {
  constructor() { super("machine core update unsupported on this target"); this.name = "MachineCoreUnsupportedError"; }
}

// What a Windows OpenSSH server's shell (cmd or PowerShell) says when asked to run `sh`.
const WINDOWS_SHELL = /is not recognized as (?:an internal or external command|the name of a cmdlet)|CommandNotFoundException/i;

/** Runs the probe argv and returns the live core's id; throws when it cannot tell. */
export const probeLiveCoreId = (argv: readonly string[]): Promise<string> => new Promise((resolve, reject) => {
  const [binary, ...args] = argv;
  if (!binary) { reject(new Error("empty probe")); return; }
  execFile(binary, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    if (error) { reject(WINDOWS_SHELL.test(`${stderr}\n${stdout}`) ? new MachineCoreUnsupportedError() : error); return; }
    try {
      resolve(ProbeStatusSchema.parse(JSON.parse(stdout)).core.id);
    } catch (parseError: unknown) {
      reject(parseError);
    }
  });
});
