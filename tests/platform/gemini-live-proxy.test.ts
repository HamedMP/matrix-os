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

function mockPlatformDb(rows: { container?: unknown; machine?: unknown }): PlatformDB {
  return {
    ready: Promise.resolve(),
    executor: {
      selectFrom: (table: string) => {
        const builder = {
          selectAll: () => builder,
          where: () => builder,
          orderBy: () => builder,
          executeTakeFirst: async () => (table === "containers" ? rows.container : rows.machine),
        };
        return builder;
      },
    },
  } as unknown as PlatformDB;
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
        db: mockPlatformDb({
          machine: {
            machine_id: "machine-alice",
            clerk_user_id: "user_alice",
            handle: "alice",
            runtime_slot: "primary",
            provisioning_class: "customer",
            developer_tools: '["codex","claude-code","opencode","pi"]',
            hetzner_server_id: 123,
            public_ipv4: "203.0.113.10",
            public_ipv6: null,
            status: "running",
            image_version: "v1",
            server_type: "cpx22",
            registration_token_hash: null,
            registration_token_expires_at: null,
            provisioned_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString(),
            deleted_at: null,
            failure_code: null,
            failure_at: null,
            resize_started_at: null,
            resize_target_server_type: null,
            attempt: 1,
          },
        }),
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
