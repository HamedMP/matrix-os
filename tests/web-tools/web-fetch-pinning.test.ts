import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createWebFetchTool } from "../../packages/kernel/src/tools/web-fetch.js";
import { WebCache } from "../../packages/kernel/src/tools/web-cache.js";

vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  resolve4: vi.fn().mockResolvedValue(["93.184.216.34"]),
  resolve6: vi.fn().mockResolvedValue([]),
}));

describe("web_fetch default transport", () => {
  let server: Server;
  let port: number;
  let hits: number;

  beforeEach(async () => {
    hits = 0;
    server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end("# internal");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("does not connect to a private address returned after the public preflight", async () => {
    const resolveHost = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    const tool = createWebFetchTool({ cache: new WebCache({ defaultTtlMs: 60_000 }), resolveHost });

    await expect(tool.execute({ url: `http://rebind.example:${port}/doc` })).rejects.toThrow();

    expect(resolveHost).toHaveBeenCalledWith("rebind.example");
    expect(hits).toBe(0);
  });
});
