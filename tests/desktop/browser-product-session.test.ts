import { describe, expect, it, vi } from "vitest";
import { installBrowserProductSessionCookie } from "@desktop/main/embeds/browser-product-session";
import { NativeAppBridge, createNativeAppGatewayRequester } from "@desktop/main/embeds/native-app-bridge";
import { buildSetCookie, signAppSession, verifyAppSession } from "../../packages/gateway/src/app-runtime/app-session";

const payload = Buffer.from(JSON.stringify({ slug: "browser-lab", principal: "gateway-owner", scope: "personal", exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
const cookie = `matrix_app_session__browser-lab=${payload}.synthetic; Path=/apps/browser-lab/; HttpOnly; Secure; SameSite=Strict; Max-Age=600`;
const renewal = { url: "/api/apps/browser-lab/session", init: { method: "POST" as const, body: "{}" } };

describe("native Browser product session renewal", () => {
  it("finishes stale cookie cleanup before a newer login installs its cookie", async () => {
    let finishOldSet!: () => void;
    const oldSet = new Promise<void>(resolve => { finishOldSet = resolve; });
    let storedValue: string | null = null;
    let setCount = 0;
    const jar = {
      set: vi.fn(async ({ value }: { value: string }) => {
        if (++setCount === 1) await oldSet;
        storedValue = value;
      }),
      remove: vi.fn(async () => { storedValue = null; }),
    };
    let oldIsCurrent = true;
    const oldInstall = installBrowserProductSessionCookie([cookie], "https://gateway.test", () => oldIsCurrent, jar);
    await vi.waitFor(() => expect(jar.set).toHaveBeenCalledTimes(1));
    oldIsCurrent = false;
    const newCookie = cookie.replace(".synthetic", ".renewed");
    const newInstall = installBrowserProductSessionCookie([newCookie], "https://gateway.test", () => true, jar);
    await Promise.resolve();
    expect(jar.set).toHaveBeenCalledTimes(1);
    finishOldSet();
    await expect(oldInstall).rejects.toThrow("browser session changed");
    await expect(newInstall).resolves.toBeUndefined();
    expect(jar.remove).toHaveBeenCalledTimes(1);
    expect(storedValue).toBe(newCookie.split("=")[1]!.split(";")[0]);
  });

  it.each(["matrix-browser", "matrix-cloud-desktop"])("renews only %s on the lab route and installs cookie before returning", async identity => {
    const install = vi.fn(async () => {});
    const fetchFn = vi.fn(async () => Response.json({ expiresAt: Date.now() + 600_000 }, { headers: { "set-cookie": cookie } }));
    const gatewayRequest = createNativeAppGatewayRequester({ getGatewayOrigin: () => "https://gateway.test", getToken: () => "synthetic", fetchFn, installBrowserSessionCookie: install });
    const bridge = new NativeAppBridge({ authGeneration: () => 1, generate: vi.fn(), aiRequest: vi.fn(), request: vi.fn(), gatewayRequest, gatewayOrigin: () => "https://gateway.test" });
    bridge.register(42, identity, "browser-lab");
    await expect(bridge.gatewayFetch({ id: 42, url: "https://gateway.test/apps/browser-lab/?surface=browser" }, renewal)).resolves.toHaveProperty("expiresAt");
    expect(install).toHaveBeenCalledWith([cookie], "https://gateway.test", expect.any(Function));
    for (const bad of [{ ...renewal, url: "/api/apps/notes/session" }, { url: "/api/apps/browser-lab/session" }]) {
      await expect(bridge.gatewayFetch({ id: 42, url: "https://gateway.test/apps/browser-lab/" }, bad)).rejects.toThrow();
    }
    bridge.register(43, identity, "notes");
    await expect(bridge.gatewayFetch({ id: 43, url: "https://gateway.test/apps/notes/" }, renewal)).rejects.toThrow();
  });
  it("installs only the bounded secure HttpOnly lab cookie and rejects other cookie scopes", async () => {
    const jar = { set: vi.fn(async (_cookie: { value: string }) => {}), remove: vi.fn(async () => {}) };
    await installBrowserProductSessionCookie([cookie], "https://gateway.test", () => true, jar);
    expect(jar.set).toHaveBeenCalledWith(expect.objectContaining({ name: "matrix_app_session__browser-lab", url: "https://gateway.test/apps/browser-lab/", path: "/apps/browser-lab/", httpOnly: true, secure: true, sameSite: "strict", expirationDate: expect.any(Number) }));
    for (const value of [cookie.replace("Path=/apps/browser-lab/", "Path=/"), cookie.replace("HttpOnly; ", ""), cookie.replace("Max-Age=600", "Max-Age=-1"), cookie.replace("matrix_app_session__browser-lab", "matrix_app_session")]) {
      await expect(installBrowserProductSessionCookie([value], "https://gateway.test", () => true, jar)).rejects.toThrow();
    }
    expect(jar.set).toHaveBeenCalledOnce();
  });
  it.each(["matrix-browser", "matrix-cloud-desktop"])("renews %s from the real internal-HTTP gateway cookie over trusted HTTPS", async identity => {
    const key = Buffer.alloc(32, 7);
    const signed = signAppSession(key, { v: 1, slug: "browser-lab", principal: "gateway-owner",
      scope: "personal", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 });
    const header = buildSetCookie("browser-lab", signed, { maxAge: 600, secure: false });
    const jar = { set: vi.fn(async (_cookie: { value: string }) => {}), remove: vi.fn(async () => {}) };
    const gatewayRequest = createNativeAppGatewayRequester({ getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "synthetic", getAuthGeneration: () => 1,
      fetchFn: vi.fn(async () => Response.json({ expiresAt: Date.now() + 600_000 }, { headers: { "set-cookie": header } })),
      installBrowserSessionCookie: (headers, origin, isCurrent) => installBrowserProductSessionCookie(headers, origin, isCurrent, jar) });
    const bridge = new NativeAppBridge({ authGeneration: () => 1, generate: vi.fn(), aiRequest: vi.fn(),
      request: vi.fn(), gatewayRequest, gatewayOrigin: () => "https://gateway.test" });
    bridge.register(42, identity, "browser-lab");
    await expect(bridge.gatewayFetch({ id: 42, url: "https://gateway.test/apps/browser-lab/" }, renewal))
      .resolves.toHaveProperty("expiresAt");
    expect(jar.set).toHaveBeenCalledWith(expect.objectContaining({ value: signed, secure: true,
      httpOnly: true, sameSite: "strict", path: "/apps/browser-lab/", url: "https://gateway.test/apps/browser-lab/" }));
    expect(verifyAppSession(key, jar.set.mock.calls[0]![0].value, Math.floor(Date.now() / 1000))).not.toBeNull();
    bridge.unregister(42);
  });
  it("ignores a late renewal after native identity changes", async () => {
    const install = vi.fn(); let token = "old";
    const requester = createNativeAppGatewayRequester({ getGatewayOrigin: () => "https://gateway.test", getToken: () => token,
      fetchFn: vi.fn(async () => { token = "new"; return Response.json({ expiresAt: Date.now() + 600_000 }, { headers: { "set-cookie": cookie } }); }), installBrowserSessionCookie: install });
    await expect(requester("matrix-browser", renewal, "browser-lab")).rejects.toThrow();
    expect(install).not.toHaveBeenCalled();
  });
});
