import { execFile } from "node:child_process";
import type { ExecutionAdmissionFence } from "./execution-admission-fence.js";

function restartGatewayNow(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/sudo", ["-n", "/usr/bin/systemctl", "--no-block", "restart", "matrix-gateway.service"], {
      timeout: 10_000,
      maxBuffer: 1024,
    }, error => { if (error) reject(error); else resolve(); });
  });
}

/** Delay stays in the gateway so new work can defer it until the next reconciliation. */
export function createManagedFeatureRestartCoordinator(options: {
  fence: ExecutionAdmissionFence;
  isIdle: () => boolean;
  restart?: () => Promise<void>;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let operation: Promise<void> | null = null;
  let releaseFence: (() => void) | null = null;
  let closed = false;

  function schedule(): void {
    if (closed) throw new Error("Computer maintenance is unavailable");
    if (timer || operation || releaseFence) return;
    timer = setTimeout(() => {
      timer = null;
      if (closed) return;
      try {
        // No await between observing idle, fencing both admission paths, and
        // submitting the immediate restart command. Later admissions fail closed.
        if (!options.isIdle()) return;
        releaseFence = options.fence.tryAcquire();
        if (!releaseFence) return;
        operation = (options.restart ?? restartGatewayNow)().catch((error: unknown) => {
          if (!closed) {
            releaseFence?.();
            releaseFence = null;
          }
          console.warn("[managed-features] restart failed", error instanceof Error ? error.name : "UnknownError");
        }).finally(() => { operation = null; });
      } catch (error: unknown) {
        if (!closed) {
          releaseFence?.();
          releaseFence = null;
        }
        console.warn("[managed-features] restart unavailable", error instanceof Error ? error.name : "UnknownError");
      }
    }, 2_000);
    timer.unref();
  }

  async function close(): Promise<void> {
    closed = true;
    // HTTP/WS teardown still has awaits ahead. No prior holder or failed
    // restart may reopen admission after SIGTERM starts shutting the gateway down.
    options.fence.close();
    if (timer) clearTimeout(timer);
    timer = null;
    await operation;
  }

  return { schedule, close };
}
