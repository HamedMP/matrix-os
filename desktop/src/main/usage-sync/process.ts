import { spawn } from "node:child_process";
/** Fixed executable/argument arrays only. Child output can contain private paths; never return it to renderers. */
export function runSyncProcess(
  command: string,
  args: string[],
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      killTimer.unref();
    };
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else if (code !== 0) reject(new Error("Usage transfer failed"));
      else resolve();
    });
    if (signal.aborted) abort();
  });
}
