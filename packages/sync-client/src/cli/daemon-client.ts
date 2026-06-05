import { createConnection } from "node:net";
import { join } from "node:path";
import { getConfigDir } from "../lib/config.js";
import { DAEMON_IPC_VERSION } from "../daemon/types.js";

export const IPC_MAX_RESPONSE_BYTES = 256 * 1024;
export const DAEMON_UNAVAILABLE_CODE = "daemon_unavailable";
export const DAEMON_UNAVAILABLE_MESSAGE = "Sync daemon is not running.";

export class DaemonClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DaemonClientError";
  }
}

export function isDaemonClientError(err: unknown): err is DaemonClientError {
  return err instanceof DaemonClientError;
}

function socketPath(): string {
  return join(getConfigDir(), "daemon.sock");
}

export async function probeDaemonSocket(
  sock: string,
  timeout = 500,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(sock);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeout);

    socket.on("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });

    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function isDaemonRunning(): Promise<boolean> {
  return probeDaemonSocket(socketPath());
}

export async function sendCommand(
  command: string,
  args: Record<string, unknown> = {},
  timeout = 5000,
): Promise<Record<string, unknown>> {
  const sock = socketPath();

  return new Promise((resolve, reject) => {
    const socket = createConnection(sock);
    let settled = false;
    let buffer = "";

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };

    const finish = (result: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      resolve(result);
    };

    const timer = setTimeout(() => {
      fail(new Error("IPC request timed out"));
    }, timeout);

    socket.on("connect", () => {
      const id = crypto.randomUUID();
      socket.write(JSON.stringify({ id, v: DAEMON_IPC_VERSION, command, args }) + "\n");
    });

    socket.on("data", (data) => {
      buffer += data.toString();
      if (Buffer.byteLength(buffer, "utf8") > IPC_MAX_RESPONSE_BYTES) {
        fail(new Error("IPC response too large"));
        return;
      }
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        try {
          const msg = JSON.parse(line) as {
            v?: number;
            result?: Record<string, unknown>;
            error?: string | { code?: string; message?: string };
          };
          if (msg.error) {
            const code = typeof msg.error === "object" && typeof msg.error.code === "string"
              ? msg.error.code
              : String(msg.error);
            fail(new Error(code));
          } else {
            finish(msg.result ?? {});
          }
        } catch (err: unknown) {
          if (err instanceof SyntaxError) {
            fail(new Error("Invalid response from daemon"));
          } else {
            fail(err instanceof Error ? err : new Error(String(err)));
          }
        }
      }
    });

    socket.on("error", (err) => {
      if (
        "code" in err &&
        ["ENOENT", "ECONNREFUSED", "EPERM", "EACCES"].includes(
          String((err as NodeJS.ErrnoException).code),
        )
      ) {
        fail(new DaemonClientError(DAEMON_UNAVAILABLE_CODE, DAEMON_UNAVAILABLE_MESSAGE));
        return;
      }
      fail(new DaemonClientError("daemon_ipc_failed", "Sync daemon request failed."));
    });
  });
}
