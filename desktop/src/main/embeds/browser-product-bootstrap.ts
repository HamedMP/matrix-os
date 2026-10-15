import { parseSetCookieHeaders } from "./app-session";
import { requestAppLaunchToken } from "./app-launch";
import { resolveLaunchUrl } from "./origin-policy";

const APP_PATH = "/apps/browser-lab/";
const ROUTE_HANDLE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const CAPABILITY = /^(?:([a-z0-9][a-z0-9-]{1,62})\.)?[A-Za-z0-9_-]{43}$/;
const unavailable = () => new Error("Browser session unavailable");

export function browserProductOrigin(raw: string): URL {
  const url = new URL(raw);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !(url.protocol === "https:" || (url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw unavailable();
  return url;
}

async function boundedLaunchBody(response: Response): Promise<string> {
  if (!response.body || Number(response.headers.get("content-length")) > 8192) {
    await response.body?.cancel(); throw unavailable();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8192 || chunks.length >= 64) { await reader.cancel(); throw unavailable(); }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally { reader.releaseLock(); }
}

/** Reuse the canonical one-use launch handshake without loading a page or following its redirect. */
export async function renewBrowserProductSession(options: {
  origin: string;
  token: string;
  isCurrent(): boolean;
  fetchFn: typeof fetch;
  install(headers: string[], origin: string, isCurrent: () => boolean): Promise<void>;
}): Promise<{ expiresAt: number }> {
  const signal = AbortSignal.timeout(10_000);
  const admitted = () => !signal.aborted && options.isCurrent();
  const current = () => { if (!admitted()) throw unavailable(); };
  try {
    const base = browserProductOrigin(options.origin);
    current();
    const launch = await requestAppLaunchToken(async () => {
      current();
      const response = await options.fetchFn(new URL("/api/apps/browser-lab/session-token", base).toString(), {
        method: "POST", body: "{}", redirect: "error", signal,
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      });
      if (!admitted()) { await response.body?.cancel(); current(); }
      const body = await boundedLaunchBody(response);
      current(); return { status: response.status, body };
    });
    current();
    const resolved = resolveLaunchUrl(launch.launchUrl, base.origin);
    if (!resolved || launch.expiresAt > Date.now() + 60_000) throw unavailable();
    const url = new URL(resolved), token = url.searchParams.get("session"), capability = token?.match(CAPABILITY);
    if (url.pathname !== APP_PATH || url.hash || url.searchParams.size !== 1 || !capability) throw unavailable();
    const response = await options.fetchFn(url.toString(), { method: "GET", redirect: "manual", credentials: "omit", signal });
    await response.body?.cancel();
    current();
    if (response.status !== 302 || response.headers.get("location") !== APP_PATH) throw unavailable();
    const headers = response.headers.getSetCookie();
    if (headers.length > 8 || headers.some(value => value.length > 8192)) throw unavailable();
    const parsed = parseSetCookieHeaders(headers), routing = parsed.filter(cookie => cookie.name === "matrix_app_route");
    // The handle comes only from the authenticated launch response, never a page argument or an old cookie.
    if (routing.length > 1 || (routing[0] && (!ROUTE_HANDLE.test(routing[0].value) || routing[0].value !== capability[1]))
      || (base.hostname === "app.matrix-os.com" && routing.length !== 1)) throw unavailable();
    const session = parsed.filter(cookie => cookie.name === "matrix_app_session__browser-lab");
    if (session.length !== 1 || !session[0]?.expires) throw unavailable();
    current(); await options.install(headers, base.origin, admitted); current();
    return { expiresAt: session[0].expires };
  } catch (error) {
    if (!(error instanceof Error)) console.warn("[browser] Session renewal unavailable", "non-error");
    throw unavailable();
  }
}
