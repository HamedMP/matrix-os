import { createServer, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";

export type IpcHandler = (
  command: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface IpcServerOptions {
  socketPath: string;
  handler: IpcHandler;
}

export class IpcServer {
  private server: Server | null = null;
  private connections = new Set<Socket>();
  private readonly maxConnections = 10;
  private readonly maxBufferBytes = 65_536;

  constructor(private readonly options: IpcServerOptions) {}

  async start(): Promise<void> {
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

    return new Promise((resolve, reject) => {
      this.server!.listen(this.options.socketPath, () => resolve());
      this.server!.on("error", reject);
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
        this.processMessage(socket, line).catch(() => {
          // Error already sent as response
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
    let msg: { id?: string; command?: string; args?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      socket.write(
        JSON.stringify({ error: "Invalid JSON" }) + "\n",
      );
      return;
    }

    try {
      const result = await this.options.handler(
        msg.command ?? "",
        msg.args ?? {},
      );
      socket.write(
        JSON.stringify({ id: msg.id, result }) + "\n",
      );
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown error";
      socket.write(
        JSON.stringify({ id: msg.id, error: message }) + "\n",
      );
    }
  }
}
