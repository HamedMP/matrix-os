import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startTestGateway } from "../e2e/fixtures/gateway.js";

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("production main websocket file-directory lifecycle", () => {
  it("keeps ownerless sockets usable while rejecting file and sync scopes", async () => {
    vi.stubEnv("MATRIX_AUTH_TOKEN", "legacy-static-token");
    vi.stubEnv("MATRIX_USER_ID", "");
    const gateway = await startTestGateway({ authToken: "legacy-static-token" });
    const socket = new WebSocket(`${gateway.url.replace("http", "ws")}/ws?token=legacy-static-token`);
    const messages: Array<Record<string, unknown>> = [];
    const closed = waitForClose(socket);
    socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));

    try {
      await waitForOpen(socket);
      socket.send(JSON.stringify({ type: "ping" }));
      socket.send(JSON.stringify({ type: "files:subscribe", directory: "projects" }));
      socket.send(JSON.stringify({ type: "files:subscribe", directory: "../outside" }));
      socket.send(JSON.stringify({
        type: "sync:subscribe",
        peerId: "peer",
        hostname: "host",
        platform: "linux",
        clientVersion: "1",
      }));

      await vi.waitFor(() => {
        expect(messages).toEqual(expect.arrayContaining([
          { type: "pong" },
          { type: "kernel:error", message: "File directory subscription failed" },
          { type: "kernel:error", message: "Sync subscription failed" },
        ]));
        expect(messages.filter((message) => message.message === "File directory subscription failed")).toHaveLength(2);
      });
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      if (socket.readyState !== WebSocket.CLOSED) socket.close();
      await closed;
      await gateway.close();
    }
  }, 30_000);

  it("releases configured-owner subscriptions on every production websocket close", async () => {
    vi.stubEnv("MATRIX_AUTH_TOKEN", "legacy-static-token");
    vi.stubEnv("MATRIX_USER_ID", "configured-owner");
    const gateway = await startTestGateway({ authToken: "legacy-static-token" });

    try {
      for (let index = 0; index < 33; index += 1) {
        const socket = new WebSocket(`${gateway.url.replace("http", "ws")}/ws?token=legacy-static-token`);
        const messages: Array<Record<string, unknown>> = [];
        const closed = waitForClose(socket);
        socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
        await waitForOpen(socket);
        socket.send(JSON.stringify({ type: "files:subscribe", directory: "projects" }));
        await vi.waitFor(() => {
          expect(messages).toContainEqual(expect.objectContaining({
            type: "files:subscribed",
            directory: "projects",
          }));
        });
        socket.close();
        await closed;
      }
    } finally {
      await gateway.close();
    }
  }, 30_000);
});
