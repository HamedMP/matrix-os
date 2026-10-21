import { execFile } from "node:child_process";

const NOTIFY_SOCKET = "/run/systemd/notify";
const NOTIFY_INTERVAL_MS = 15_000;

/** Only the system service's inherited watchdog environment enables notification. */
export function startScopeRuntimeWatchdog(options: { env?: NodeJS.ProcessEnv } = {}): { close(): Promise<void> } {
  const env = options.env ?? process.env;
  const watchdogUsec = Number(env.WATCHDOG_USEC);
  if (env.NOTIFY_SOCKET !== NOTIFY_SOCKET || !/^\d+$/.test(env.WATCHDOG_USEC ?? "")
    || !Number.isSafeInteger(watchdogUsec) || watchdogUsec < 4_000
    || (env.WATCHDOG_PID !== undefined && env.WATCHDOG_PID !== String(process.pid))) {
    return { close: async () => undefined };
  }

  const abort = new AbortController();
  let closed = false;
  let pending: Promise<void> | undefined;
  const ping = () => {
    if (closed || pending) return;
    pending = new Promise<void>((resolve, reject) => {
      // No shell, caller-provided socket, inherited secrets, PID override, or
      // --no-block: systemd-notify waits for attribution before its child exits.
      execFile("/usr/bin/systemd-notify", ["WATCHDOG=1"], {
        env: { NOTIFY_SOCKET }, timeout: 5_000, killSignal: "SIGKILL",
        maxBuffer: 16_384, signal: abort.signal,
      }, error => { if (error) reject(error); else resolve(); });
    }).catch((error: unknown) => {
      if (!closed) console.error("scope_runtime_watchdog_notify_failed:", error instanceof Error ? error.name : "UnknownError");
    }).finally(() => { pending = undefined; });
  };
  ping();
  const timer = setInterval(ping, Math.min(NOTIFY_INTERVAL_MS, Math.floor(watchdogUsec / 4_000)));
  timer.unref();
  return {
    async close() {
      closed = true;
      clearInterval(timer);
      abort.abort();
      await pending;
    },
  };
}
