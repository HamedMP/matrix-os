import { finishCloses } from "./socket-shutdown.js";

interface ShutdownOwner { close(): Promise<void> }

export function installSupervisorShutdownHandlers(watchdog: ShutdownOwner, server: ShutdownOwner): void {
  let shutdown: Promise<void> | undefined;
  let keepAlive: NodeJS.Timeout | undefined;
  const stop = () => {
    if (shutdown) return;
    // Signal listeners alone cannot keep the process reachable after native socket close.
    // Hold one reference until cleanup succeeds or the service manager enforces its stop deadline.
    keepAlive ??= setInterval(() => {}, 24 * 60 * 60 * 1000);
    shutdown = finishCloses(watchdog.close(), server.close()).then(() => {
      clearInterval(keepAlive);
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      process.exitCode = 0;
    }).catch((error: unknown) => {
      shutdown = undefined;
      console.error("scope_runtime_supervisor_shutdown_failed:",
        error instanceof Error ? error.name : "UnknownError");
      process.exitCode = 1;
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
