import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import {
  handleInternalGeminiLiveProxyUpgrade,
  parseInternalGeminiLivePath,
} from "../../packages/platform/src/gemini-live-proxy.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

function closeServer(server: { close: (callback?: (err?: Error) => void) => void }): () => Promise<void> {
  return () =>
    new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
}

describe("platform Gemini Live proxy", () => {
  it("accepts the internal per-container proxy path", () => {
    expect(parseInternalGeminiLivePath("/internal/containers/alice/gemini-live")).toEqual({ handle: "alice" });
  });

  it("rejects unsafe or public proxy paths", () => {
    expect(parseInternalGeminiLivePath("/api/gemini-live")).toBeNull();
    expect(parseInternalGeminiLivePath("/internal/containers/../../gemini-live")).toBeNull();
    expect(parseInternalGeminiLivePath("/internal/containers/a/gemini-live")).toBeNull();
  });

  it("preserves text frames in both proxy directions", async () => {
    const providerHttp = createServer();
    const providerServer = new WebSocketServer({ server: providerHttp });
    cleanup.push(closeServer(providerServer), closeServer(providerHttp));

    const providerReceived = new Promise<{ text: string; isBinary: boolean }>((resolve) => {
      providerServer.on("connection", (socket) => {
        socket.on("message", (data, isBinary) => {
          resolve({ text: data.toString(), isBinary });
          socket.send(JSON.stringify({ ok: true }), { binary: false });
        });
      });
    });
    await new Promise<void>((resolve) => providerHttp.listen(0, "127.0.0.1", resolve));
    const providerPort = (providerHttp.address() as AddressInfo).port;

    const platformSecret = "platform-secret";
    const proxyHttp = createServer();
    proxyHttp.on("upgrade", (req, socket, head) => {
      void handleInternalGeminiLiveProxyUpgrade({
        req,
        socket,
        head,
        db: {
          ready: Promise.resolve(),
          executor: {
            selectFrom: () => ({
              selectAll: () => ({
                where: () => ({
                  executeTakeFirst: async () => ({
                    handle: "alice",
                    clerk_user_id: "user_alice",
                    container_id: "matrixos-alice",
                    port: 3001,
                    shell_port: 3101,
                    status: "running",
                    created_at: new Date().toISOString(),
                    last_active: new Date().toISOString(),
                  }),
                }),
              }),
            }),
          },
        } as unknown as PlatformDB,
        platformSecret,
        geminiApiKey: "gemini-key",
        geminiWsUrl: `ws://127.0.0.1:${providerPort}`,
      });
    });
    cleanup.push(closeServer(proxyHttp));
    await new Promise<void>((resolve) => proxyHttp.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxyHttp.address() as AddressInfo).port;

    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/internal/containers/alice/gemini-live`, {
      headers: { authorization: `Bearer ${buildPlatformVerificationToken("alice", platformSecret)}` },
    });
    cleanup.push(async () => {
      client.close();
    });

    const clientReceived = new Promise<{ text: string; isBinary: boolean }>((resolve) => {
      client.on("message", (data, isBinary) => resolve({ text: data.toString(), isBinary }));
    });
    await new Promise<void>((resolve) => client.on("open", resolve));
    client.send(JSON.stringify({ setup: true }), { binary: false });

    await expect(providerReceived).resolves.toEqual({ text: JSON.stringify({ setup: true }), isBinary: false });
    await expect(clientReceived).resolves.toEqual({ text: JSON.stringify({ ok: true }), isBinary: false });
  });
});
