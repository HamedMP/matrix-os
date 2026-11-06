import { spawn, spawnSync } from "node:child_process";

function commandTimeout(options) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error("Command timeout must be a positive bounded integer");
  }
  return timeoutMs;
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const timeoutMs = commandTimeout(options);
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
      detached: grouped,
    });
    let failure;
    let stopped = false;
    let killTimer;
    const kill = (signal) => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error?.code !== "ESRCH") console.warn(`Failed to stop ${command}:`, error);
      }
    };
    const stop = (error) => {
      if (stopped) return;
      stopped = true;
      failure = error;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 1_000);
    };
    const onAbort = () => stop(options.signal.reason);
    const timer = setTimeout(() => stop(new Error(`${command} timed out after ${timeoutMs} ms`)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (stopped) kill("SIGKILL");
      cleanup();
      if (stopped) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}

export function runCommandSync(command, args, options = {}) {
  options.signal?.throwIfAborted();
  const timeoutMs = commandTimeout(options);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.stdio ?? (options.capture ? "pipe" : "inherit"),
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  if (result.error?.code === "ETIMEDOUT") throw new Error(`${command} timed out after ${timeoutMs} ms`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
  return options.capture ? result.stdout.trim() : "";
}
