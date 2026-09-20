import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveStatus } from "../../src/daemon/live-status.js";

afterEach(() => vi.unstubAllGlobals());
describe("live daemon status", () => {
  it("loads validated live peers with authentication and a deadline", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ connectedPeers: [{ peerId: "p", hostname: "Mac", platform: "darwin", connectedAt: 10 }] })));
    vi.stubGlobal("fetch", fetcher);
    const live = createLiveStatus({ gatewayUrl: "https://gateway.test", token: "t" }, () => {});
    expect(await live.peers()).toEqual([{ peerId: "p", hostname: "Mac", platform: "darwin", connectedAt: 10 }]);
    expect(fetcher).toHaveBeenCalledWith("https://gateway.test/api/sync/status", expect.objectContaining({ signal: expect.any(AbortSignal), headers: { authorization: "Bearer t" } }));
  });
  it("marks unavailable data explicitly instead of reporting an empty live collection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const warn = vi.fn();
    const live = createLiveStatus({ gatewayUrl: "https://gateway.test", token: "t" }, warn);
    expect(await live.peers()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});
