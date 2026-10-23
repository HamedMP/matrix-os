import { describe, expect, it, vi } from "vitest";
import { installBrowserProductSessionCookie } from "@desktop/main/embeds/browser-product-session";
import { NativeAppBridge, createNativeAppGatewayRequester } from "@desktop/main/embeds/native-app-bridge";
import { buildSetCookie, signAppSession, verifyAppSession } from "../../packages/gateway/src/app-runtime/app-session";

const payload = Buffer.from(JSON.stringify({ slug: "browser-lab", principal: "gateway-owner", scope: "personal", exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
const cookie = `matrix_app_session__browser-lab=${payload}.synthetic; Path=/apps/browser-lab/; HttpOnly; Secure; SameSite=Strict; Max-Age=600`;
const renewal = { url: "/api/apps/browser-lab/session", init: { method: "POST" as const, body: "{}" } };
function canonicalFetch(header: string) {
  return vi.fn(async (url: string | URL | Request) => String(url).endsWith("/session-token")
    ? Response.json({ expiresAt: Date.now() + 60_000, launchUrl: "/apps/browser-lab/?session=" + "a".repeat(43) })
    : new Response(null, { status: 302, headers: { location: "/apps/browser-lab/", "set-cookie": header } }));
}

function expectRefreshedRoute(
  stored: { name: string; value: string; path: string; domain: string; expirationDate?: number } | undefined,
  startedAt: number,
) {
  expect(stored).toEqual({ name: "matrix_app_route", value: "pr-2526", path: "/apps/browser-lab/",
    domain: "app.matrix-os.com", url: "https://app.matrix-os.com/apps/browser-lab/", httpOnly: true,
    secure: true, sameSite: "lax", expirationDate: expect.any(Number) });
  expect(stored?.expirationDate).toBeGreaterThan(startedAt);
  expect(stored?.expirationDate).toBeLessThanOrEqual(startedAt + 600);
}


describe("native Browser product session renewal", () => {
  it("renews the expired app routing cookie together with the signed Browser cookie", async () => {
    const route = "matrix_app_route=pr-2526; Path=/apps/browser-lab/; HttpOnly; Secure; SameSite=Lax; Max-Age=600";
    const jar = { set: vi.fn(async () => {}), get: vi.fn(async () => []), remove: vi.fn(async () => {}) };
    await installBrowserProductSessionCookie([cookie, route], "https://app.matrix-os.com", () => true, jar);
    expect(jar.set).toHaveBeenCalledWith(expect.objectContaining({ name: "matrix_app_route", value: "pr-2526", path: "/apps/browser-lab/", httpOnly: true, secure: true, sameSite: "lax", expirationDate: expect.any(Number) }));
    expect(jar.set).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed routing scope before writing either cookie", async () => {
    const route = "matrix_app_route=pr-2526; Path=/apps/browser-lab/; HttpOnly; Secure; SameSite=Lax; Max-Age=600";
    const jar = { set: vi.fn(async () => {}), get: vi.fn(async () => []), remove: vi.fn(async () => {}) };
    for (const h of [route.replace("Path=/apps/browser-lab/", "Path=/"), route.replace("HttpOnly; ", ""), route.replace("SameSite=Lax", "SameSite=None"), route.replace("Max-Age=600", "Max-Age=1200"), route + "; Domain=foreign.test", route.replace("pr-2526", "../foreign")]) {
      await expect(installBrowserProductSessionCookie([cookie, h], "https://app.matrix-os.com", () => true, jar)).rejects.toThrow();
    }
    await expect(installBrowserProductSessionCookie([cookie, route, route], "https://app.matrix-os.com", () => true, jar)).rejects.toThrow();
    expect(jar.set).not.toHaveBeenCalled();
  });

  it.each(["before", "after"])("preserves a valid shared route and signed session when route set rejects %s its write", async rejection => {
    const route = "matrix_app_route=pr-2526; Path=/apps/browser-lab/; HttpOnly; Secure; SameSite=Lax; Max-Age=600";
    const previous = { name: "matrix_app_route", value: "pr-2526", path: "/apps/browser-lab/", domain: "app.matrix-os.com" };
    const priorSession = { ...previous, name: "matrix_app_session__browser-lab", value: "previous-signed-session" };
    const values = new Map([[previous.name, previous], [priorSession.name, priorSession]]);
    const jar = {
      set: vi.fn(async (c: { name: string; value: string; path?: string }) => {
        if (rejection === "after") values.set(c.name, { ...c, path: c.path!, domain: "app.matrix-os.com" });
        throw new Error("synthetic cookie store failure");
      }),
      get: vi.fn(async ({ name }: { name: string }) => values.has(name) ? [values.get(name)!] : []),
      remove: vi.fn(async (_url: string, name: string) => { values.delete(name); }),
    };
    const startedAt = Date.now() / 1000;
    await expect(installBrowserProductSessionCookie([cookie, route], "https://app.matrix-os.com", () => true, jar)).rejects.toThrow();
    expect(jar.set.mock.calls.map(([c]) => c.name)).toEqual(["matrix_app_route"]);
    expect(jar.remove).not.toHaveBeenCalled();
    if (rejection === "before") expect(values.get(previous.name)).toEqual(previous);
    else expectRefreshedRoute(values.get(previous.name), startedAt);
    expect(values.get(priorSession.name)).toEqual(priorSession);
  });

  it("preserves a successfully refreshed existing route when the later app-cookie set fails", async () => {
    const route = "matrix_app_route=pr-2526; Path=/apps/browser-lab/; HttpOnly; Secure; SameSite=Lax; Max-Age=600";
    const previous = { name: "matrix_app_route", value: "pr-2526", path: "/apps/browser-lab/", domain: "app.matrix-os.com" };
    const priorSession = { ...previous, name: "matrix_app_session__browser-lab", value: "previous-signed-session" };
    const values = new Map([[previous.name, previous], [priorSession.name, priorSession]]);
    const jar = {
      set: vi.fn(async (c: { name: string; value: string; path?: string }) => {
        if (c.name === priorSession.name) throw new Error("synthetic cookie store failure");
        values.set(c.name, { ...c, path: c.path!, domain: "app.matrix-os.com" });
      }),
      get: vi.fn(async ({ name }: { name: string }) => values.has(name) ? [values.get(name)!] : []),
      remove: vi.fn(async (_url: string, name: string) => { values.delete(name); }),
    };
    const startedAt = Date.now() / 1000;
    await expect(installBrowserProductSessionCookie([cookie, route], "https://app.matrix-os.com", () => true, jar)).rejects.toThrow();
    expect(jar.remove).not.toHaveBeenCalled();
    expectRefreshedRoute(values.get(previous.name), startedAt);
    expect(values.get(priorSession.name)).toEqual(priorSession);
  });

  it("rolls back only confirmed new writes and leaves a rejected write indeterminate", async () => {
    const route = "matrix_app_route=pr-2526; Path=/apps/browser-lab/; HttpOnly; Secure; SameSite=Lax; Max-Age=600";
    const values = new Map<string, { name: string; value: string; path: string; domain: string }>();
    const jar = {
      set: vi.fn(async (c: { name: string; value: string; path?: string }) => {
        values.set(c.name, { ...c, path: c.path!, domain: "app.matrix-os.com" });
        if (c.name === "matrix_app_session__browser-lab") throw new Error("synthetic cookie store failure");
      }),
      get: vi.fn(async ({ name }: { name: string }) => values.has(name) ? [values.get(name)!] : []),
      remove: vi.fn(async (_url: string, name: string) => { values.delete(name); }),
    };
    await expect(installBrowserProductSessionCookie([cookie, route], "https://app.matrix-os.com", () => true, jar)).rejects.toThrow();
    expect(jar.remove).toHaveBeenCalledTimes(1);
    expect(jar.remove).toHaveBeenCalledWith("https://app.matrix-os.com/apps/browser-lab/", "matrix_app_route");
    expect(values.has("matrix_app_route")).toBe(false);
    expect(values.has("matrix_app_session__browser-lab")).toBe(true);
  });

  it("does not delete a newer externally installed session when a late renewal loses its generation", async () => {
    let current = true; const newer = { name: "matrix_app_session__browser-lab", value: "newer", path: "/apps/browser-lab/", domain: "app.matrix-os.com" };
    const jar = { set: vi.fn(async () => { current = false; }), get: vi.fn(async () => [newer]), remove: vi.fn(async () => {}) };
    await expect(installBrowserProductSessionCookie([cookie], "https://app.matrix-os.com", () => current, jar)).rejects.toThrow();
    expect(jar.remove).not.toHaveBeenCalled();
  });

  it("never removes a different cookie value after a same-generation failed install", async () => {
    const jar = { set: vi.fn(async () => { throw new Error("synthetic failure"); }), get: vi.fn(async () => [{ name: "matrix_app_session__browser-lab", value: "newer", path: "/apps/browser-lab/", domain: "app.matrix-os.com" }]), remove: vi.fn(async () => {}) };
    await expect(installBrowserProductSessionCookie([cookie], "https://app.matrix-os.com", () => true, jar)).rejects.toThrow();
    expect(jar.remove).not.toHaveBeenCalled();
  });

  it("serializes a stale write before a newer login without deleting across generations", async () => {
    let finishOldSet!: () => void;
    const oldSet = new Promise<void>(resolve => { finishOldSet = resolve; });
    let storedValue: string | null = null;
    let setCount = 0;
    const jar = {
      set: vi.fn(async ({ value }: { value: string }) => {
        if (++setCount === 1) await oldSet;
        storedValue = value;
      }),
      get: vi.fn(async () => []),
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
    expect(jar.remove).not.toHaveBeenCalled();
    expect(storedValue).toBe(newCookie.split("=")[1]!.split(";")[0]);
  });

  it.each(["matrix-browser", "matrix-cloud-desktop"])("renews only %s on the lab route and installs cookie before returning", async identity => {
    const install = vi.fn(async () => {});
    const fetchFn = canonicalFetch(cookie);
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
    const jar = { set: vi.fn(async (_cookie: { value: string }) => {}), get: vi.fn(async () => []), remove: vi.fn(async () => {}) };
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
    const jar = { set: vi.fn(async (_cookie: { value: string }) => {}), get: vi.fn(async () => []), remove: vi.fn(async () => {}) };
    const gatewayRequest = createNativeAppGatewayRequester({ getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "synthetic", getAuthGeneration: () => 1,
      fetchFn: canonicalFetch(header),
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
