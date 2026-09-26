import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { boundedOperation } from "../bounded-operation.js";
import { hermesDependencyArguments } from "./jev-hermes-python.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    // Tracked cleanliness does not cover importable additions or ignored caches.
    // Installed venv packages remain an explicit dependency trust boundary;
    // the isolated launcher separately bypasses all site/.pth startup hooks.
    for (const ignored of [false, true]) {
      const files = await runCommand([...common, "ls-files", "--others", ...(ignored ? ["--ignored"] : []),
        "--exclude-standard", "-z", "--", "*.py", "*.pyc", "*.pyo", "*.pth", "*.so", "*.zip",
        ":(exclude)venv/**", ":(exclude,glob)**/__pycache__/*.cpython-*.pyc"], deadline);
      deadline.throwIfAborted();
      // Source caches are never loaded: both Python paths use a fresh private
      // cache prefix. Reject raw/sourceless bytecode and all added import code.
      if (files.split("\0").some(path => /\.(?:py|pyc|pyo|pth|so|zip)$/i.test(path)
        && !/(?:^|\/)__pycache__\/[^/]+\.cpython-\d+(?:\.opt-\d+)?\.pyc$/.test(path))) {
        throw new Error("Restricted runtime setup required");
      }
    }
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
    const cachePrefix = await mkdtemp(join(tmpdir(), "matrix-jev-dependency-cache-"));
    try {
      deadline.throwIfAborted();
      const version = await runPython(join(root, "venv", "bin", "python"), hermesDependencyArguments(root, cachePrefix), deadline);
      deadline.throwIfAborted();
      if (version !== "0.87.0\n") throw new Error("Restricted runtime setup required");
    } finally { await rm(cachePrefix, { recursive: true, force: true }); }
  }, 10_000, signal);
}
