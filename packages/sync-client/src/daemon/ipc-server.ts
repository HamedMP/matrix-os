import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import type { IpcHandler } from "./ipc-handler.js";
import {
  formatDaemonError,
  formatDaemonSuccess,
  parseDaemonRequest,
} from "./types.js";
export type { IpcHandler };

export const IPC_SOCKET_MODE = 0o600;
export const IPC_SOCKET_DIR_MODE = 0o700;
export const IPC_MAX_CONNECTIONS = 10;
export const IPC_MAX_BUFFER_BYTES = 65_536;
export const IPC_HANDLER_TIMEOUT_MS = 10_000;

export interface IpcServerOptions {
  socketPath: string;
  handler: IpcHandler;
  handlerTimeoutMs?: number;
}

export class IpcServer {
  private server: Server | null = null;
  private connections = new Set<Socket>();
  private readonly maxConnections = IPC_MAX_CONNECTIONS;
  private readonly maxBufferBytes = IPC_MAX_BUFFER_BYTES;
  private readonly handlerTimeoutMs: number;

  constructor(private readonly options: IpcServerOptions) {
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? IPC_HANDLER_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.options.socketPath), { recursive: true, mode: IPC_SOCKET_DIR_MODE });
    await chmod(dirname(this.options.socketPath), IPC_SOCKET_DIR_MODE).catch((err: unknown) => {
      console.warn(
        "[sync/ipc] Failed to chmod socket directory:",
        err instanceof Error ? err.message : String(err),
      );
    });
    try {
      await unlink(this.options.socketPath);
    } catch (err: unknown) {
      if (
        !(
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        )
      ) {
        throw err;
      }
    }

    this.server = createServer((socket) => this.handleConnection(socket));
    this.server.maxConnections = this.maxConnections;
    const previousUmask = process.umask(0o077);

    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        process.umask(previousUmask);
        reject(err);
      };
      this.server!.once("error", onError);
      this.server!.listen(this.options.socketPath, async () => {
        try {
          process.umask(previousUmask);
          this.server?.off("error", onError);
          await chmod(this.options.socketPath, IPC_SOCKET_MODE);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  async stop(): Promise<void> {
    for (const conn of this.connections) {
      conn.destroy();
    }
    this.connections.clear();

    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
        this.server = null;
      });
    }
  }

  private handleConnection(socket: Socket): void {
    this.connections.add(socket);
    let buffer = "";

    socket.on("data", (data) => {
      buffer += data.toString();
      if (buffer.length > this.maxBufferBytes) {
        socket.destroy();
        return;
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        this.processMessage(socket, line).catch((err: unknown) => {
          console.warn(
            "[sync/ipc] processMessage failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
      }
    });

    socket.on("close", () => {
      this.connections.delete(socket);
    });

    socket.on("error", () => {
      this.connections.delete(socket);
    });
  }

  private async processMessage(
    socket: Socket,
    raw: string,
  ): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw) as unknown;
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        socket.write(
          JSON.stringify(formatDaemonError("unknown", "invalid_request")) + "\n",
        );
        return;
      }
      throw err;
    }

    const parsed = parseDaemonRequest(msg);
    if (!parsed.ok) {
      socket.write(JSON.stringify(parsed.response) + "\n");
      return;
    }

    try {
      const result = await this.callHandlerWithTimeout(
        parsed.request.command,
        parsed.request.args,
      );
      socket.write(
        JSON.stringify(formatDaemonSuccess(parsed.request.id, result)) + "\n",
      );
    } catch (err: unknown) {
      const code =
        err instanceof Error && /^[a-z_]+$/.test(err.message)
          ? err.message
          : "request_failed";
      socket.write(
        JSON.stringify(formatDaemonError(parsed.request.id, code)) + "\n",
      );
    }
  }

  private async callHandlerWithTimeout(
    command: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.options.handler(command, args),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("request_timeout")), this.handlerTimeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}
