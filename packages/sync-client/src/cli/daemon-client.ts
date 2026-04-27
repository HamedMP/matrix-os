import { createConnection } from "node:net";
import { join } from "node:path";
import { getConfigDir } from "../lib/config.js";
import { DAEMON_IPC_VERSION } from "../daemon/types.js";

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
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("IPC request timed out"));
    }, timeout);

    const socket = createConnection(sock);
    let buffer = "";

    socket.on("connect", () => {
      const id = crypto.randomUUID();
      socket.write(JSON.stringify({ id, v: DAEMON_IPC_VERSION, command, args }) + "\n");
    });

    socket.on("data", (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        clearTimeout(timer);
        const line = buffer.slice(0, idx);
        socket.end();
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
            reject(new Error(code));
          } else {
            resolve(msg.result ?? {});
          }
        } catch (err: unknown) {
          if (err instanceof SyntaxError) {
            reject(new Error("Invalid response from daemon"));
          } else {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Cannot connect to daemon. Is it running? (${err.message})`,
        ),
      );
    });
  });
}
