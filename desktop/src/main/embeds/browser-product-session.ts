import type { Cookie, Cookies, CookiesSetDetails } from "electron";
import { parseSetCookieHeaders } from "./app-session";
import { BROWSER_CLOCK_SKEW_MS, browserProductOrigin } from "./browser-product-bootstrap";

type CookieJar = Pick<Cookies, "set" | "remove"> & {
  get(filter: { url: string; name: string }): Promise<Array<Pick<Cookie, "name" | "value" | "path" | "domain">>>;
};
type SessionWrite = CookiesSetDetails & Required<Pick<CookiesSetDetails, "name" | "value" | "path">>;
// Browser and Cloud desktop share a partition. Serialize renewal writes and cleanup.
let cookieInstall = Promise.resolve<void>(undefined);

export async function installBrowserProductSessionCookie(
  headers: string[], origin: string, isCurrent: () => boolean, jar: CookieJar,
): Promise<void> {
  if (headers.length > 8 || headers.some(value => value.length > 8192)) throw new Error("invalid browser session");
  const parsed = parseSetCookieHeaders(headers);
  const cookies = parsed.filter(cookie => cookie.name === "matrix_app_session__browser-lab");
  const cookie = cookies.length === 1 ? cookies[0] : undefined;
  const routing = parsed.filter(cookie => cookie.name === "matrix_app_route");
  const route = routing[0];
  const base = browserProductOrigin(origin);
  if (!cookie || cookie.path !== "/apps/browser-lab/" || cookie.domain || !cookie.httpOnly
    || cookie.sameSite !== "strict"
    || !cookie.expires || cookie.expires <= Date.now() || cookie.expires > Date.now() + 601_000
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cookie.value)) throw new Error("invalid browser session");
  if (routing.length > 1 || (route && (route.path !== cookie.path || route.domain || !route.httpOnly || !route.secure
    || route.sameSite !== "lax" || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(route.value)
    || !route.expires || route.expires <= Date.now() || route.expires > Date.now() + 600_000))) throw new Error("invalid browser session");
  let payload: { slug?: unknown; principal?: unknown; scope?: unknown; exp?: unknown };
  try { payload = JSON.parse(Buffer.from(cookie.value.split(".")[0]!, "base64url").toString("utf8")); }
  catch (error) { if (!(error instanceof SyntaxError)) console.warn("[browser] Invalid session", error instanceof Error ? error.name : "unknown"); throw new Error("invalid browser session"); }
  if (!payload || payload.slug !== "browser-lab" || payload.principal !== "gateway-owner" || payload.scope !== "personal"
    || typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now() || payload.exp * 1000 > Date.now() + 600_000 + BROWSER_CLOCK_SKEW_MS
    || !isCurrent()) throw new Error("invalid browser session");
  const url = `${base.origin}/apps/browser-lab/`;
  const expirationDate = Math.min(cookie.expires, payload.exp * 1000) / 1000;
  const writes: SessionWrite[] = [];
  // Renew routing first so a rejected hint write cannot overwrite a working signed session.
  if (route) writes.push({ url, name: route.name, value: route.value, path: route.path!, httpOnly: true,
    secure: true, sameSite: "lax", expirationDate: Math.min(route.expires!, expirationDate * 1000) / 1000 });
  writes.push({ url, name: cookie.name, value: cookie.value, path: cookie.path, httpOnly: true,
    secure: base.protocol === "https:" || cookie.secure === true, sameSite: "strict", expirationDate });
  const matches = (stored: Pick<Cookie, "name" | "value" | "path" | "domain">, next: SessionWrite) =>
    stored.name === next.name && stored.value === next.value && stored.path === next.path && stored.domain === base.hostname;
  const install = async () => {
    if (!isCurrent()) throw new Error("browser session changed");
    const installed: { cookie: SessionWrite; existedWithSameValue: boolean }[] = [];
    try {
      for (const next of writes) {
        if (!isCurrent()) throw new Error("browser session changed");
        const before = await jar.get({ url, name: next.name });
        if (!isCurrent()) throw new Error("browser session changed");
        const existedWithSameValue = before.some(stored => matches(stored, next));
        await jar.set(next);
        installed.push({ cookie: next, existedWithSameValue });
        if (!isCurrent()) throw new Error("browser session changed");
      }
    } catch (error) {
      // No cookie CAS exists. Never delete after the native login changes, or
      // when a fresh canonical launch has replaced a confirmed installed value.
      // Rejected writes are indeterminate; identical preexisting hints are shared.
      for (const { cookie: next, existedWithSameValue } of installed.reverse()) {
        if (!isCurrent()) break;
        if (existedWithSameValue) continue;
        try {
          const stored = await jar.get({ url, name: next.name });
          if (isCurrent() && stored.length === 1 && matches(stored[0]!, next)) await jar.remove(url, next.name);
        } catch (cleanupError) { console.warn("[browser] Session cleanup unavailable", cleanupError instanceof Error ? cleanupError.name : "unknown"); }
      }
      if (!(error instanceof Error)) console.warn("[browser] Session unavailable", "non-error");
      throw new Error(isCurrent() ? "browser session unavailable" : "browser session changed");
    }
  };
  const queuedInstall = cookieInstall.then(install, install);
  cookieInstall = queuedInstall;
  await queuedInstall;
}
