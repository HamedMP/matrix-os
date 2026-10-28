import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { createConnection, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { startPortForward, type PortForwardHandle, type PortForwardEventData } from "../../packages/sync-client/src/cli/port-forward.js";

const servers: Server[] = [];
const sockets: Socket[] = [];
const forwards: PortForwardHandle[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function forwardTo(port: number, onEvent?: (type: string, data: PortForwardEventData) => void, idleTimeoutMs = 30_000) {
  const forward = await startPortForward({
    gatewayUrl: `http://127.0.0.1:${port}`,
    token: "secret-bearer-token",
    localHost: "127.0.0.1",
    localPort: 0,
    remoteHost: "127.0.0.1",
    remotePort: 3000,
    idleTimeoutMs,
    onEvent,
  });
  forwards.push(forward);
  return forward;
}

async function connect(forward: PortForwardHandle): Promise<Socket> {
  const socket = createConnection(forward.localPort, "127.0.0.1");
  sockets.push(socket);
  await once(socket, "connect");
  return socket;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(forwards.splice(0).map((forward) => forward.close()));
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("port forward with real ws", () => {
  it.each(["local TCP close", "view disposal", "idle timeout"])(
    "handles a delayed WebSocket handshake after %s without an uncaught error",
    async (reason) => {
      const gateway = createServer();
      const upgraded = new Promise<Socket>((resolve) => {
        gateway.once("upgrade", (_request, socket) => {
          sockets.push(socket);
          resolve(socket);
          // Deliberately withhold the upgrade response: ws stays CONNECTING.
        });
      });
      const port = await listen(gateway);
      const events: Array<{ type: string; data: PortForwardEventData }> = [];
      const forward = await forwardTo(port, (type, data) => events.push({ type, data }), reason === "idle timeout" ? 250 : 30_000);
      const client = await connect(forward);
      await upgraded;

      if (reason === "local TCP close") client.destroy();
      if (reason === "view disposal") await forward.close();
      if (reason === "idle timeout") {
        await vi.waitFor(() => expect(events.some((event) => event.type === "connection_idle_timeout")).toBe(true));
      }

      await vi.waitFor(() => expect(events.filter((event) => event.type === "connection_close")).toHaveLength(1));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events.filter((event) => event.type === "connection_error")).toEqual([]);
      expect(JSON.stringify(events)).not.toContain("secret-bearer-token");
    },
  );

  it("reports a failed WebSocket handshake once and closes the connection once", async () => {
    const gateway = createServer();
    gateway.on("upgrade", (_request, socket) => socket.destroy());
    const port = await listen(gateway);
    const events: Array<{ type: string; data: PortForwardEventData }> = [];
    const forward = await forwardTo(port, (type, data) => events.push({ type, data }));
    await connect(forward);

    await vi.waitFor(() => expect(events.filter((event) => event.type === "connection_close")).toHaveLength(1));
    expect(events.filter((event) => event.type === "connection_error").map((event) => event.data.code)).toEqual([
      "websocket_failed",
    ]);
    expect(JSON.stringify(events)).not.toContain("secret-bearer-token");
  });

  it("carries normal binary tunnel traffic through a real WebSocket", async () => {
    const gateway = createServer();
    const websocketServer = new WebSocketServer({ noServer: true });
    gateway.on("upgrade", (request, socket, head) => {
      websocketServer.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", (data, isBinary) => {
          if (!isBinary) {
            expect(JSON.parse(String(data))).toEqual({ type: "open", host: "127.0.0.1", port: 3000 });
            ws.send(JSON.stringify({ type: "ready" }));
          } else {
            ws.send(data, { binary: true });
          }
        });
      });
    });
    const port = await listen(gateway);
    const forward = await forwardTo(port);
    const client = await connect(forward);
    const received = new Promise<Buffer>((resolve) => client.once("data", (chunk) => resolve(Buffer.from(chunk))));
    client.write(Buffer.from("normal tunnel bytes"));
    await expect(received).resolves.toEqual(Buffer.from("normal tunnel bytes"));
    client.destroy();
    await forward.close();
    await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
  });
});
