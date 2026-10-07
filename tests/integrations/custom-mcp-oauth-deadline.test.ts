import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";

const network = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: network.request }));
vi.mock("../../packages/gateway/src/integrations/custom-mcp/security.js", () => ({ validateCustomMcpUrl: vi.fn(async (url: string) => ({ url: new URL(url), address: "93.184.216.34", family: 4 })) }));
import { CustomMcpOAuthManager } from "../../packages/gateway/src/integrations/custom-mcp/oauth.js";
import { pinnedOAuthRequest } from "../../packages/gateway/src/integrations/custom-mcp/oauth-request.js";
import { validateCustomMcpUrl } from "../../packages/gateway/src/integrations/custom-mcp/security.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); network.request.mockReset(); });
describe("OAuth absolute network deadline", () => {
  it("aborts a continuously trickling response despite no idle timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
    });
    const body = new PassThrough() as PassThrough & { statusCode: number };
    body.statusCode = 200;
    const request = new EventEmitter() as EventEmitter & { end(): void; destroy(error: Error): void };
    request.end = () => {};
    request.destroy = error => { body.destroy(); request.emit("error", error); };
    network.request.mockImplementation((_url, options, receive) => {
      options.signal?.addEventListener("abort", () => request.destroy(new Error("deadline")), { once: true });
      queueMicrotask(() => receive(body)); return request;
    });
    const row = { id: "server", user_id: "owner", url: "https://public.example/mcp", auth_mode: "oauth", revision: 1 };
    const oauth = new CustomMcpOAuthManager({ db: { getCustomMcpServerForBroker: async () => row } as unknown as PlatformDb,
      encryptionKey: Buffer.alloc(32), clientId: "client", redirectUri: "https://matrix.example/callback" });
    const pending = oauth.start("owner", "server").then(() => "unexpected-success", error => error);
    await vi.advanceTimersByTimeAsync(0);
    const trickle = setInterval(() => body.write(" "), 500);
    try {
      expect(network.request.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toBeInstanceOf(Error);
      expect(body.destroyed).toBe(true);
    } finally { clearInterval(trickle); request.destroy(new Error("cleanup")); await pending; }
  });
  it("bounds stalled DNS preflight before opening a socket", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
    });
    vi.mocked(validateCustomMcpUrl).mockImplementationOnce(() => new Promise(() => {}));
    const pending = pinnedOAuthRequest({ method: "GET", url: "https://public.example/metadata" }).catch(error => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBeInstanceOf(Error);
    expect(network.request).not.toHaveBeenCalled();
  });
  it.each([
    { status: 302, content: Buffer.from("{}") },
    { status: 200, content: Buffer.alloc(65537) },
    { status: 200, content: Buffer.from([255]) },
  ])("closes redirect, oversized and malformed bodies %j", async ({ status, content }) => {
    const body = new PassThrough() as PassThrough & { statusCode: number };
    body.statusCode = status;
    const request = new EventEmitter() as EventEmitter & { end(): void; destroy(error: Error): void };
    request.destroy = error => { body.destroy(); request.emit("error", error); };
    network.request.mockImplementation((_url, _options, receive) => {
      request.end = () => queueMicrotask(() => { receive(body); if (!body.destroyed) body.end(content); });
      return request;
    });
    await expect(pinnedOAuthRequest({ method: "GET", url: "https://public.example/metadata" })).rejects.toThrow();
    expect(body.destroyed).toBe(true);
  });
});
