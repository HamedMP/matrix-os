import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const SHUTDOWN_TIMEOUT_MS = 5_000;

export function spawnServices(definitions, env = process.env) {
  const children = definitions.map((service) => ({
    name: service.name,
    finished: false,
    groupGone: false,
    child: spawn(process.execPath, service.args, {
      cwd: service.cwd,
      detached: process.platform !== "win32",
      env,
      stdio: "inherit",
    }),
  }));
  const completions = children.map((service) => new Promise((resolve) => {
    const { name, child } = service;
    const finish = (status) => { service.finished = true; resolve(status); };
    child.once("error", (error) => finish({ name, pid: child.pid, error }));
    child.once("exit", (code, signal) => finish({ name, pid: child.pid, code, signal }));
  }));
  const groupAlive = (service) => {
    if (service.child.pid === undefined || service.groupGone) return false;
    try { process.kill(-service.child.pid, 0); return true; }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      // Never signal a PGID again after its owned group has disappeared.
      service.groupGone = true;
      return false;
    }
  };
  const signalChildren = (signal) => {
    for (const service of children) {
      const { child } = service;
      if (child.pid === undefined) continue;
      if (process.platform === "win32") {
        if (child.exitCode === null && !child.killed) child.kill(signal);
        continue;
      }
      try {
        if (!groupAlive(service)) continue;
        process.kill(-child.pid, signal);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
          console.warn(`[local-dev] failed to stop process group ${child.pid}:`, error);
        }
      }
    }
  };
  const waitForStop = async (timeoutMs) => {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      // A watcher can exit before its runtime descendant. Reap the whole
      // detached group, rather than accepting only the direct child's exit.
      if (children.every(service => service.finished
        && (process.platform === "win32" || !groupAlive(service)))) return true;
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      await delay(Math.min(25, remaining));
    }
  };
  const exited = Promise.race(completions).then((status) => {
    if ("error" in status) {
      throw new Error(`${status.name} failed to start${status.pid ? ` (pid ${status.pid})` : ""}: ${status.error.message}`);
    }
    if (status.code === 0 || status.signal === "SIGINT" || status.signal === "SIGTERM") return status;
    throw new Error(
      `${status.name} (pid ${status.pid ?? "unknown"}) exited with ${status.code ?? status.signal ?? "unknown status"}`,
    );
  });
  let stopPromise;
  const stop = (signal) => {
    stopPromise ??= (async () => {
      signalChildren(signal);
      const stopped = await waitForStop(SHUTDOWN_TIMEOUT_MS);
      if (stopped) return;

      signalChildren("SIGKILL");
      const killed = await waitForStop(1_000);
      if (!killed) throw new Error("local services did not stop after SIGKILL");
    })();
    return stopPromise;
  };
  return { exited, stop };
}
