import { describe, expect, it, vi } from "vitest";
import { NativeAppBridge, createNativeAppGatewayRequester } from "@desktop/main/embeds/native-app-bridge";

const url = "/api/system/activity?processLimit=25&includeSuggestions=true";
const sender = { id: 42, url: "https://gateway.test/apps/resource-manager/" };
function setup() {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({ generatedAt: "now" })));
  const gatewayRequest = createNativeAppGatewayRequester({
    getGatewayOrigin: () => "https://gateway.test", getToken: () => "desktop-token", fetchFn,
  });
  const bridge = new NativeAppBridge({
    request: vi.fn(), gatewayRequest, gatewayOrigin: () => "https://gateway.test",
  });
  bridge.register(42, "resource-manager");
  return { bridge, fetchFn, gatewayRequest };
}

describe("native Resource Manager gateway bridge", () => {
  it("uses main-process credentials for the registered app's activity GET", async () => {
    const { bridge, fetchFn } = setup();
    await expect(bridge.gatewayFetch(sender, { url, init: { method: "GET" } }))
      .resolves.toEqual({ generatedAt: "now" });
    expect(fetchFn).toHaveBeenCalledWith(`https://gateway.test${url}`, expect.objectContaining({
      method: "GET", redirect: "error", headers: { authorization: "Bearer desktop-token" },
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([
    { url: "/api/system/update" }, { url: "/api/system/activity/actions" },
    { url: "https://attacker.test/api/system/activity" }, { url: "//attacker.test" },
    { url: "/api/system/activity/../update" }, { url: "/api/system/activity#fragment" },
    { url: "/api/system/activity?processLimit=999" },
    { url: "/api/system/activity?unknown=true" },
    { url: "/api/system/activity?processLimit=1&processLimit=2" },
    { url, init: { method: "POST" } }, { url, init: { headers: { authorization: "spoof" } } },
    { url, init: { body: "payload" } }, { url, app: "resource-manager" },
  ])("rejects disallowed requests before fetching: %j", async (payload) => {
    const { bridge, fetchFn } = setup();
    await expect(bridge.gatewayFetch(sender, payload)).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects other apps, unregistered views and navigation away from the registered route", async () => {
    const { bridge, fetchFn } = setup();
    bridge.register(43, "notes");
    bridge.register(44, "custom/resource-manager", "resource-manager");
    for (const source of [
      { ...sender, id: 99 }, { id: 43, url: "https://gateway.test/apps/notes/" },
      { ...sender, id: 44 }, { ...sender, url: "https://attacker.test/apps/resource-manager/" },
      { ...sender, url: "https://gateway.test/apps/notes/" },
    ]) await expect(bridge.gatewayFetch(source, { url })).rejects.toThrow();
    bridge.unregister(42);
    await expect(bridge.gatewayFetch(sender, { url })).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("requires authentication and rejects failed or oversized gateway responses", async () => {
    const { gatewayRequest, fetchFn } = setup();
    fetchFn.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(gatewayRequest("resource-manager", { url })).rejects.toThrow();
    fetchFn.mockResolvedValueOnce(new Response("{}", { headers: { "content-length": "9000000" } }));
    await expect(gatewayRequest("resource-manager", { url })).rejects.toThrow();
    const unauthenticated = createNativeAppGatewayRequester({
      getGatewayOrigin: () => "https://gateway.test", getToken: () => null, fetchFn,
    });
    await expect(unauthenticated("resource-manager", { url })).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("native gateway IPC boundary", () => {
  it("rejects subframes and hides internal failure details", async () => {
    const { bridge, fetchFn } = setup();
    const handle = vi.fn();
    bridge.registerIpc({ handle });
    const handler = handle.mock.calls.find(([name]) => name === "native-app:gateway-fetch")![1];
    const mainFrame = {};
    const event = { senderFrame: mainFrame, sender: {
      id: sender.id, mainFrame, getURL: () => sender.url,
    } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(handler({ ...event, senderFrame: {} }, { url }))
        .rejects.toThrow(/^app gateway request failed$/);
      expect(fetchFn).not.toHaveBeenCalled();
      fetchFn.mockRejectedValueOnce(new Error("private upstream detail"));
      await expect(handler(event, { url })).rejects.toThrow(/^app gateway request failed$/);
    } finally {
      warn.mockRestore();
    }
  });
});
