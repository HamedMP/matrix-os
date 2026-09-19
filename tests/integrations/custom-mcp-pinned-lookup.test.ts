import { EventEmitter } from "node:events";
import type { LookupFunction } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";

const mocks = vi.hoisted(() => ({ request: vi.fn(), validate: vi.fn() }));
vi.mock("node:https", () => ({ request: mocks.request }));
vi.mock("../../packages/gateway/src/integrations/custom-mcp/security.js", () => ({
  validateCustomMcpUrl: mocks.validate,
}));
import { pinnedRemoteMcpRequester } from "../../packages/gateway/src/integrations/custom-mcp/client.js";
import { CustomMcpOAuthManager } from "../../packages/gateway/src/integrations/custom-mcp/oauth.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.request.mockImplementation(() => {
    const request = new EventEmitter();
    Object.assign(request, { end: () => queueMicrotask(() => request.emit("error", new Error("transport inspected"))) });
    return request;
  });
});

describe.each(["MCP", "OAuth"])("%s pinned DNS transport", (kind) => {
  it.each([
    { address: "93.184.216.34", family: 4 as const },
    { address: "2606:4700:4700::1111", family: 6 as const },
  ])("preserves the validated $family address for Node's single and all-address lookups", async (target) => {
    mocks.validate.mockImplementation(async (url: string) => ({ url: new URL(url), ...target }));
    const operation = kind === "MCP"
      ? pinnedRemoteMcpRequester({ url: "https://mcp.example.com/mcp", headers: {}, timeoutMs: 1000 })
      : new CustomMcpOAuthManager({
          db: { getCustomMcpServerForBroker: async () => ({ auth_mode: "oauth", url: "https://mcp.example.com/mcp" }) } as unknown as PlatformDb,
          encryptionKey: Buffer.alloc(32, 1),
          redirectUri: "https://matrix.example.com/api/mcp-servers/oauth/callback",
        }).start("owner", "server");
    await expect(operation).rejects.toThrow("transport inspected");
    const options = mocks.request.mock.calls[0][1] as { lookup: LookupFunction; servername: string };
    expect(options.servername).toBe("mcp.example.com");
    const single = vi.fn();
    options.lookup("mcp.example.com", {}, single);
    expect(single).toHaveBeenCalledWith(null, target.address, target.family);
    const all = vi.fn();
    options.lookup("mcp.example.com", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [target]);
    expect(mocks.validate).toHaveBeenCalledTimes(1);
  });
});
