import type { Cookies } from "electron";
import { parseSetCookieHeaders } from "./app-session";

// Browser and Cloud desktop share one persistent cookie partition. Finish each
// write and any stale-session cleanup before installing the next login.
let cookieInstall = Promise.resolve<void>(undefined);

export async function installBrowserProductSessionCookie(
  headers: string[], origin: string, isCurrent: () => boolean, jar: Pick<Cookies, "set" | "remove">,
): Promise<void> {
  if (headers.length > 8 || headers.some(value => value.length > 8192)) throw new Error("invalid browser session");
  const cookies = parseSetCookieHeaders(headers).filter(cookie => cookie.name === "matrix_app_session__browser-lab");
  const cookie = cookies.length === 1 ? cookies[0] : undefined;
  const base = new URL(origin);
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("invalid browser session");
  if (!cookie || cookie.path !== "/apps/browser-lab/" || cookie.domain || !cookie.httpOnly
    || cookie.sameSite !== "strict"
    || !cookie.expires || cookie.expires <= Date.now() || cookie.expires > Date.now() + 601_000
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cookie.value)) throw new Error("invalid browser session");
  let payload: { slug?: unknown; principal?: unknown; scope?: unknown; exp?: unknown };
  try { payload = JSON.parse(Buffer.from(cookie.value.split(".")[0]!, "base64url").toString("utf8")); }
  catch (error) { if (!(error instanceof SyntaxError)) console.warn("[browser] Invalid session", error instanceof Error ? error.name : "unknown"); throw new Error("invalid browser session"); }
  if (!payload || payload.slug !== "browser-lab" || payload.principal !== "gateway-owner" || payload.scope !== "personal"
    || typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now() || payload.exp * 1000 > Date.now() + 601_000
    || !isCurrent()) throw new Error("invalid browser session");
  const url = `${base.origin}/apps/browser-lab/`;
  const expirationDate = Math.min(cookie.expires, payload.exp * 1000) / 1000;
  // The authenticated gateway may see internal HTTP behind the TLS proxy.
  // Derive Secure from the trusted transport, never from forwarded headers.
  const install = async () => {
    if (!isCurrent()) throw new Error("browser session changed");
    await jar.set({ url, name: cookie.name, value: cookie.value, path: cookie.path, httpOnly: true,
      secure: base.protocol === "https:" || cookie.secure === true, sameSite: "strict",
      expirationDate });
    if (!isCurrent()) { await jar.remove(url, cookie.name); throw new Error("browser session changed"); }
  };
  const queuedInstall = cookieInstall.then(install, install);
  cookieInstall = queuedInstall;
  await queuedInstall;
}
