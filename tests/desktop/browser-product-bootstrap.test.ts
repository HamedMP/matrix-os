import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeAppGatewayRequester } from "@desktop/main/embeds/native-app-bridge";
import { installBrowserProductSessionCookie } from "@desktop/main/embeds/browser-product-session";
import { renewBrowserProductSession } from "@desktop/main/embeds/browser-product-bootstrap";
import { MobileAppSessionTokenStore } from "../../packages/gateway/src/app-runtime/mobile-session-token-store";
import { buildSetCookie, signAppSession } from "../../packages/gateway/src/app-runtime/app-session";
import { buildAppRouteCookie, readMobileAppRouteCookie } from "../../packages/platform/src/session-routing-identity";

const origin = "https://app.matrix-os.com";
const path = "/apps/browser-lab/";
const renewal = { url: "/api/apps/browser-lab/session", init: { method: "POST" as const, body: "{}" } };
const capability = "pr-2526." + "a".repeat(43);
function sessionCookie() {
  const now = Math.floor(Date.now() / 1000);
  return buildSetCookie("browser-lab", signAppSession(Buffer.alloc(32, 7), {
    v: 1, slug: "browser-lab", principal: "gateway-owner", scope: "personal", iat: now, exp: now + 600,
  }), { maxAge: 600, secure: false });
}
function headers(route = buildAppRouteCookie("pr-2526", path)!) {
  const h = new Headers({ location: path }); h.append("set-cookie", sessionCookie());
  if (route) h.append("set-cookie", route);
  return h;
}
function launch(url = path + "?session=" + capability) {
  return Response.json({ token: capability, expiresAt: Date.now() + 30_000, launchUrl: url });
}
function fakeJar() {
  const values = new Map<string, { name: string; value: string; path: string; domain: string; expirationDate: number }>();
  const jar = {
    set: vi.fn(async (c: { name: string; value: string; path?: string; expirationDate?: number }) => {
      values.set(c.name, { ...c, path: c.path ?? path, domain: "app.matrix-os.com", expirationDate: c.expirationDate! });
    }),
    get: vi.fn(async ({ name }: { name: string }) => {
      const c = values.get(name); return c && c.expirationDate * 1000 > Date.now() ? [c] : [];
    }),
    remove: vi.fn(async (_url: string, name: string) => { values.delete(name); }),
  };
  return { jar, values };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Browser canonical launch renewal", () => {
  it.each(["matrix-browser", "matrix-cloud-desktop"])("restores an expired preview route for %s without loading a document or changing runtime cookies", async identity => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { jar, values } = fakeJar();
    values.set("matrix_app_route", { name: "matrix_app_route", value: "pr-2526", path, domain: "app.matrix-os.com", expirationDate: Date.now() / 1000 - 1 });
    const tokens = new MobileAppSessionTokenStore({ ttlMs: 30_000, maxEntries: 1 });
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === origin + "/api/apps/browser-lab/session-token") {
        expect(init).toMatchObject({ method: "POST", body: "{}", redirect: "error", headers: { authorization: "Bearer synthetic", "content-type": "application/json" } });
        const minted = tokens.mint("browser-lab", Date.now(), { routingKey: "pr-2526" });
        return Response.json({ ...minted, launchUrl: path + "?session=" + minted.token });
      }
      const u = new URL(String(url));
      expect(u.origin).toBe(origin); expect(u.pathname).toBe(path);
      expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
      expect(init?.headers).toBeUndefined(); expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(tokens.consume("browser-lab", u.searchParams.get("session")!)).toBe(true);
      return new Response(null, { status: 302, headers: headers() });
    });
    const requester = createNativeAppGatewayRequester({ getGatewayOrigin: () => origin, getToken: () => "synthetic", getAuthGeneration: () => 7,
      fetchFn, installBrowserSessionCookie: (h, o, current) => installBrowserProductSessionCookie(h, o, current, jar) });
    expect(readMobileAppRouteCookie(path + "api/browser-status", "")).toBeNull();
    await expect(requester(identity, renewal, "browser-lab")).resolves.toHaveProperty("expiresAt");
    const routeCookie = await jar.get({ name: "matrix_app_route" });
    expect(readMobileAppRouteCookie(path + "api/browser-status", `matrix_app_route=${routeCookie[0]?.value}`)).toBe("pr-2526");
    expect(jar.set.mock.calls.map(([c]) => c.name)).toEqual(["matrix_app_route", "matrix_app_session__browser-lab"]);
    expect(values.get("matrix_app_route")!.expirationDate * 1000).toBeLessThanOrEqual(Date.now() + 600_000);
    expect(tokens.size()).toBe(0); expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    "//foreign.test/apps/browser-lab/?session=" + capability,
    "/apps/notes/?session=" + capability,
    path + "?session=" + capability + "&surface=browser",
    path + "?session=" + capability + "#fragment",
    path + "?session=not-a-capability",
  ])("rejects a noncanonical launch response before consuming any capability", async launchUrl => {
    const fetchFn = vi.fn(async () => launch(launchUrl)); const install = vi.fn();
    await expect(renewBrowserProductSession({ origin, token: "synthetic", isCurrent: () => true, fetchFn, install })).rejects.toThrow("Browser session unavailable");
    expect(fetchFn).toHaveBeenCalledOnce(); expect(install).not.toHaveBeenCalled();
  });

  it.each([301, 303, 307, 308, 200, 401])("never follows or installs from unexpected bootstrap status %s", async status => {
    const fetchFn = vi.fn().mockResolvedValueOnce(launch()).mockResolvedValueOnce(new Response(null, { status, headers: headers() }));
    const install = vi.fn(); await expect(renewBrowserProductSession({ origin, token: "synthetic", isCurrent: () => true, fetchFn, install })).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(2); expect(install).not.toHaveBeenCalled();
  });

  it.each(["https://foreign.test/apps/browser-lab/", "/apps/notes/", path + "?anything=1", path + "#fragment"])("rejects unexpected redirect Location without following it", async location => {
    const h = headers(); h.set("location", location);
    const fetchFn = vi.fn().mockResolvedValueOnce(launch()).mockResolvedValueOnce(new Response(null, { status: 302, headers: h }));
    const install = vi.fn(); await expect(renewBrowserProductSession({ origin, token: "synthetic", isCurrent: () => true, fetchFn, install })).rejects.toThrow(); expect(install).not.toHaveBeenCalled();
  });

  it.each(["", buildAppRouteCookie("foreign-vps", path)!])("refuses missing or foreign route hints on the platform origin", async route => {
    const fetchFn = vi.fn().mockResolvedValueOnce(launch()).mockResolvedValueOnce(new Response(null, { status: 302, headers: headers(route) }));
    const install = vi.fn(); await expect(renewBrowserProductSession({ origin, token: "synthetic", isCurrent: () => true, fetchFn, install })).rejects.toThrow(); expect(install).not.toHaveBeenCalled();
  });

  it("rejects an uncertain single-use response without replay", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(launch()).mockRejectedValueOnce(new TypeError("synthetic transport failure"));
    await expect(renewBrowserProductSession({ origin, token: "synthetic", isCurrent: () => true, fetchFn, install: vi.fn() })).rejects.toThrow("Browser session unavailable"); expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each(["after_launch", "after_bootstrap"])("does not install after a token/generation/runtime change %s", async when => {
    let current = true; const install = vi.fn(); const fetchFn = vi.fn(async () => {
      const first = fetchFn.mock.calls.length === 1; if ((first && when === "after_launch") || (!first && when === "after_bootstrap")) current = false;
      return first ? launch() : new Response(null, { status: 302, headers: headers() });
    });
    await expect(renewBrowserProductSession({ origin, token: "synthetic", isCurrent: () => current, fetchFn, install })).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(when === "after_launch" ? 1 : 2); expect(install).not.toHaveBeenCalled();
  });

  it("refuses a late launch response and drains its body after the shared deadline", async () => {
    const deadline = new AbortController(); vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const cancel = vi.fn(async () => {}), fetchFn = vi.fn(async () => {
      deadline.abort(); return { status: 200, headers: new Headers(), body: { cancel } } as unknown as Response;
    }), install = vi.fn();
    await expect(renewBrowserProductSession({ origin, token: "synthetic", isCurrent: () => true, fetchFn, install })).rejects.toThrow("Browser session unavailable");
    expect(cancel).toHaveBeenCalledOnce(); expect(fetchFn).toHaveBeenCalledOnce(); expect(install).not.toHaveBeenCalled();
  });

  it("does not admit cookie installation queued beyond the shared deadline", async () => {
    const deadline = new AbortController(); vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetchFn = vi.fn().mockResolvedValueOnce(launch()).mockResolvedValueOnce(new Response(null, { status: 302, headers: headers() }));
    const install = vi.fn(async (_h, _o, current) => { expect(current()).toBe(true); deadline.abort(); expect(current()).toBe(false); });
    await expect(renewBrowserProductSession({ origin, token: "synthetic", isCurrent: () => true, fetchFn, install })).rejects.toThrow("Browser session unavailable");
    expect(install).toHaveBeenCalledOnce(); expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("caps launch JSON and preserves a common ten-second signal over both requests", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(Response.json({ launchUrl: "x".repeat(8193) })); const install = vi.fn();
    await expect(renewBrowserProductSession({ origin, token: "synthetic", isCurrent: () => true, fetchFn, install })).rejects.toThrow(); expect(fetchFn).toHaveBeenCalledOnce();
    const ok = vi.fn().mockResolvedValueOnce(launch()).mockResolvedValueOnce(new Response(null, { status: 302, headers: headers() }));
    await renewBrowserProductSession({ origin, token: "synthetic", isCurrent: () => true, fetchFn: ok, install });
    expect(ok.mock.calls[0]![1].signal).toBe(ok.mock.calls[1]![1].signal); expect(ok.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it("supports direct loopback without routing hints and refuses arbitrary HTTP or credentialed origins", async () => {
    const randomToken = "a".repeat(43),fetchFn = vi.fn().mockResolvedValueOnce(launch(path + "?session=" + randomToken)).mockResolvedValueOnce(new Response(null, { status: 302, headers: headers("") })),install = vi.fn();
    await expect(renewBrowserProductSession({ origin: "http://127.0.0.1:4000", token: "synthetic", isCurrent: () => true, fetchFn, install })).resolves.toHaveProperty("expiresAt");
    for (const bad of ["http://foreign.test", "https://user:pass@app.matrix-os.com", origin + "/foreign", origin + "?x=1"]) await expect(renewBrowserProductSession({ origin: bad, token: "synthetic", isCurrent: () => true, fetchFn, install })).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
