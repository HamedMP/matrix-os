import { createConnection } from "node:net";
import { join } from "node:path";
import { access } from "node:fs/promises";
import { getConfigDir } from "../lib/config.js";

function socketPath(): string {
  return join(getConfigDir(), "daemon.sock");
}

export async function isDaemonRunning(): Promise<boolean> {
  try {
    await access(socketPath());
    return true;
  } catch {
    return false;
  }
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
      socket.write(JSON.stringify({ id, command, args }) + "\n");
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
            result?: Record<string, unknown>;
            error?: string;
          };
          if (msg.error) {
            reject(new Error(msg.error));
          } else {
            resolve(msg.result ?? {});
          }
        } catch {
          reject(new Error("Invalid response from daemon"));
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
