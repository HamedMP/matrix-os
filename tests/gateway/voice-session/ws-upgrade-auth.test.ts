import { describe, expect, it } from "vitest";
import { authMiddleware } from "../../../packages/gateway/src/auth.js";

/**
 * Auth-middleware contract for the ticket-authenticated voice WebSocket
 * transport (`/ws/chats/:chatId/voice/:sessionId`):
 *
 * - The path is exempt from bearer auth (the upgrade handler verifies a
 *   one-time ticket instead) but is still IP rate-limited on the
 *   trusted-proxy-gated source key.
 * - It is NOT part of the generic `?token=` allowlist, and near-miss paths
 *   must not inherit the exemption.
 * - Forwarded headers are ignored unless the socket peer is a configured
 *   MATRIX_TRUSTED_PROXIES entry — a caller cannot rotate spoofed
 *   X-Forwarded-For / CF-Connecting-IP values to dodge the limiter.
 */

function mockContext(
  path: string,
  options: {
    authHeader?: string;
    url?: string;
    peer?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const url = options.url ?? `http://localhost:4000${path}`;
  const headers = options.headers ?? {};
  return {
    env: options.peer === undefined
      ? {}
      : { incoming: { socket: { remoteAddress: options.peer, remotePort: 45_000, remoteFamily: "IPv4" } } },
    req: {
      path,
      url,
      raw: new Request(url),
      header: (name: string) => {
        if (name === "Authorization") return options.authHeader;
        return headers[name] ?? headers[name.toLowerCase()];
      },
    },
    json: (body: unknown, status?: number) => ({ body, status: status ?? 200 }),
  } as never;
}

const UPGRADE_PATH = "/ws/chats/chat_main/voice/vs_abc123";
const PROXIES_ENV = "MATRIX_TRUSTED_PROXIES";

function withTrustedProxies(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const original = process.env[PROXIES_ENV];
  if (value === undefined) delete process.env[PROXIES_ENV];
  else process.env[PROXIES_ENV] = value;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (original === undefined) delete process.env[PROXIES_ENV];
      else process.env[PROXIES_ENV] = original;
    });
}

describe("voice transport WS upgrade — auth middleware", () => {
  it("exempts the exact upgrade path from bearer auth (ticket verifier owns it)", async () => {
    const mw = authMiddleware("secret-token");
    let nextCalled = false;
    const result = await mw(
      mockContext(UPGRADE_PATH, { url: `http://localhost:4000${UPGRADE_PATH}?ticket=vt_x`, peer: "198.51.100.7" }),
      async () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(true);
    expect(result).toBeUndefined();
  });

  it.each([
    "/ws/chats/chat_main/voice", // missing session segment
    "/ws/chats/chat_main/voice/vs_abc123/extra", // extra segment
    "/ws/chats/chat_main/voice/vs_abc123/", // trailing slash
    "/ws/chats/chat_main/voicee/vs_abc123", // segment prefix lookalike
    "/api/ws/chats/chat_main/voice/vs_abc123", // wrong prefix
    "/ws/chats/chat_main/voice/vs_abc!23", // unsafe session id
  ])("does NOT exempt near-miss path %s", async (path) => {
    const mw = authMiddleware("secret-token");
    let nextCalled = false;
    const result = await mw(
      mockContext(path, { peer: `198.51.100.${path.length}` }),
      async () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(false);
    expect(result?.status).toBe(401);
  });

  it("does not treat a ?token= query param as auth — the path is not in the WS query-token allowlist", async () => {
    // A non-exempt lookalike path carrying the real bearer in ?token= must
    // still fail: the voice transport path pattern never joins
    // WS_QUERY_TOKEN_PATHS, so query tokens are only honored on the exact
    // allowlist entries.
    const mw = authMiddleware("secret-token");
    let nextCalled = false;
    const result = await mw(
      mockContext("/ws/chats/chat_main/voice/vs_abc123/preview", {
        url: `http://localhost:4000/ws/chats/chat_main/voice/vs_abc123/preview?token=secret-token`,
        peer: "198.51.100.8",
      }),
      async () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(false);
    expect(result?.status).toBe(401);
  });

  it("rate-limits the upgrade path on the socket peer when headers are spoofed", async () => {
    await withTrustedProxies(undefined, async () => {
      const mw = authMiddleware("secret-token");
      const peer = "198.51.100.60";
      // Rotating spoofed headers cannot mint fresh limiter buckets.
      for (let i = 0; i < 10; i++) {
        let nextCalled = false;
        const result = await mw(
          mockContext(UPGRADE_PATH, {
            peer,
            headers: {
              "x-forwarded-for": `203.0.113.${i + 1}`,
              "cf-connecting-ip": `192.0.2.${i + 1}`,
            },
          }),
          async () => { nextCalled = true; },
        );
        expect(nextCalled).toBe(true);
        expect(result).toBeUndefined();
      }
      let nextCalled = false;
      const blocked = await mw(
        mockContext(UPGRADE_PATH, { peer, headers: { "x-forwarded-for": "203.0.113.250" } }),
        async () => { nextCalled = true; },
      );
      expect(nextCalled).toBe(false);
      expect(blocked?.status).toBe(429);
    });
  });

  it("honors the forwarded client IP when the peer is a configured trusted proxy", async () => {
    await withTrustedProxies("127.0.0.1,::1", async () => {
      const mw = authMiddleware("secret-token");
      for (let i = 0; i < 10; i++) {
        await mw(
          mockContext(UPGRADE_PATH, {
            peer: "127.0.0.1",
            headers: { "x-real-ip": "203.0.113.77" },
          }),
          async () => {},
        );
      }
      const blocked = await mw(
        mockContext(UPGRADE_PATH, {
          peer: "127.0.0.1",
          headers: { "x-real-ip": "203.0.113.77" },
        }),
        async () => {},
      );
      expect(blocked?.status).toBe(429);
      // A different claimed client behind the same proxy keeps a fresh bucket.
      let nextCalled = false;
      await mw(
        mockContext(UPGRADE_PATH, {
          peer: "127.0.0.1",
          headers: { "x-real-ip": "203.0.113.78" },
        }),
        async () => { nextCalled = true; },
      );
      expect(nextCalled).toBe(true);
    });
  });
});
