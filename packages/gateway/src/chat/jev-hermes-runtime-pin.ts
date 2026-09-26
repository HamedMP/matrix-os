import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { boundedOperation } from "../bounded-operation.js";
const PIN = "d337b736aa1e8ebecfab043842d13e4a2d2f48a3";
const run = promisify(execFile);
const command = async (args: string[], signal: AbortSignal) => {
  const result = await run("/usr/bin/git", args, { timeout: 10_000, maxBuffer: 4096, signal,
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } });
  return result.stdout;
};
/** Exact spike-verified upstream source. Git builtins only, no shell, external diff, textconv, fsmonitor or hooks. */
export async function verifyJevHermesRuntimePin(root: string, signal: AbortSignal,
  runCommand: (args: string[], signal: AbortSignal) => Promise<string> = command): Promise<void> {
  signal.throwIfAborted();
  const common = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root];
  await boundedOperation(async (deadline) => {
    const revision = await runCommand([...common, "rev-parse", "HEAD"], deadline);
    deadline.throwIfAborted();
    if (revision.trim() !== PIN) throw new Error("Restricted runtime setup required");
    await runCommand([...common, "diff-index", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--"], deadline);
    deadline.throwIfAborted();
  }, 15_000, signal);
}

/** Import only the locked provider SDK in isolated Python; never load owner configuration or infer readiness from Git alone. */
export async function verifyJevHermesDependencies(root: string, signal: AbortSignal,
  runPython: (executable: string, args: string[], signal: AbortSignal) => Promise<string> = async (executable, args, deadline) => {
    const result = await run(executable, args, { timeout: 10_000, maxBuffer: 4096, signal: deadline,
      env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" } });
    return result.stdout;
  }): Promise<void> {
  signal.throwIfAborted();
  await boundedOperation(async (deadline) => {
    const version = await runPython(join(root, "venv", "bin", "python"), ["-I", "-B", "-c",
      'import anthropic; import importlib.metadata; print(importlib.metadata.version("anthropic"))'], deadline);
    deadline.throwIfAborted();
    if (version !== "0.87.0\n") throw new Error("Restricted runtime setup required");
  }, 10_000, signal);
}
