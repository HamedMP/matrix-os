import { createHash } from "node:crypto";
import type { Cookies, Session, WebContents } from "electron";
import { isPrivatePreviewHandle } from "@matrix-os/contracts";
import { parseSetCookieHeaders } from "./app-session";

export const HOSTED_BOTS_ORIGIN = "https://matrix-bots.invalid";
const proxyPath = "/api/hosted-bots/runtime";
const brokerCookieHeader = "x-matrix-hosted-bots-set-session";
const cookieName = /^omb_session_[0-9]{1,5}_[a-zA-Z0-9]{0,12}$/;
const cookieValue = /^omb_sess_[a-zA-Z0-9_-]{43}$/;
const forwardedHeaders = [
  "accept", "accept-language", "content-type", "range", "last-event-id", "if-none-match", "if-modified-since",
  "user-agent", "x-omb-background", "x-omb-sha256",
] as const;
const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const streamRoute = /^(?:\/api\/bots\/[a-zA-Z0-9_-]{1,128}\/browser\/stream|\/api\/desktop-viewer\/(?:local\/(?:shared|bot-[a-f0-9]{64}|pool-[0-9]+)|vps\/[a-zA-Z0-9_-]{1,128})\/websockify)$/;
const MAX_DOCUMENT_BYTES = 256 * 1024;

interface HostedBotsIdentity {
  partition: string;
  gateway: string;
  runtimeSlot: string;
}

export interface HostedBotsAuth {
  signedIn: boolean;
  platformHost: string;
  runtimeSlot: string;
  userId?: string | null;
}

interface HostedBotsCredentials {
  getIdentity(): HostedBotsIdentity | null;
  getToken(): string | null;
}

interface HostedBotsProtocolDeps extends HostedBotsCredentials {
  cookies: Pick<Cookies, "get" | "set" | "remove" | "flushStore">;
  disposeSignal?: AbortSignal;
  fetcher?: typeof fetch;
}

export function hostedBotsIdentity(auth: HostedBotsAuth): HostedBotsIdentity | null {
  if (!auth.signedIn || !auth.userId || !isPrivatePreviewHandle(auth.runtimeSlot) || !URL.canParse(auth.platformHost)) return null;
  const gateway = new URL(auth.platformHost);
  const local = gateway.protocol === "http:" && gateway.hostname === "127.0.0.1";
  if ((!local && gateway.protocol !== "https:") || gateway.username || gateway.password || gateway.pathname !== "/" || gateway.search || gateway.hash) return null;
  const scope = JSON.stringify([gateway.origin, auth.userId, auth.runtimeSlot]);
  const digest = createHash("sha256").update(scope).digest("hex").slice(0, 32);
  return { partition: "hosted-bots-" + digest, gateway: gateway.origin, runtimeSlot: auth.runtimeSlot };
}

function gatewayProxyBase(identity: HostedBotsIdentity): URL {
  return new URL("/vm/" + identity.runtimeSlot + proxyPath, identity.gateway);
}

function gatewaySocketBase(identity: HostedBotsIdentity): URL {
  const target = gatewayProxyBase(identity);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  return target;
}

export function hostedBotsSocketAllowed(identity: HostedBotsIdentity, url: string): boolean {
  if (!URL.canParse(url)) return false;
  const target = new URL(url);
  const base = gatewaySocketBase(identity);
  return target.origin === base.origin && !target.username && !target.password && !target.hash
    && target.pathname.startsWith(base.pathname + "/")
    && target.search.length <= 8192 && streamRoute.test(target.pathname.slice(base.pathname.length));
}

export function hostedBotsProviderLoginAllowed(value: string): boolean {
  if (value.length > 16_384 || /\s/.test(value) || !URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
  const hostname = url.hostname;
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) return false;
  if (hostname === "auth.openai.com") {
    return (url.pathname === "/codex/device" || url.pathname === "/codex/device/") && keys.length === 0;
  }
  if (["claude.com", "claude.ai", "console.anthropic.com", "platform.claude.com"].includes(hostname)) {
    const redirect = url.searchParams.get("redirect_uri");
    return url.pathname === "/oauth/authorize"
      && (!redirect || /^https:\/\/(?:claude\.ai|console\.anthropic\.com|platform\.claude\.com)\/oauth\/[a-z/-]+$/u.test(redirect));
  }
  if (hostname === "accounts.google.com") {
    return url.pathname === "/o/oauth2/v2/auth" && url.searchParams.get("response_type") === "code"
      && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/u.test(url.searchParams.get("redirect_uri") ?? "");
  }
  if (/(^|\.)(x\.ai|grok\.com|kimi\.com|kimi\.ai)$/.test(hostname)) {
    return keys.every((key) => key === "user_code") && /^[A-Z0-9-]{0,48}$/u.test(url.searchParams.get("user_code") ?? "");
  }
  if (hostname === "cursor.com" || hostname === "www.cursor.com") {
    return url.pathname === "/loginDeepControl"
      && keys.every((key) => ["challenge", "uuid", "mode", "redirectTarget", "supportsSelectedTeamLogin"].includes(key))
      && /^[\w-]{16,128}$/u.test(url.searchParams.get("challenge") ?? "")
      && /^[\w-]{8,64}$/u.test(url.searchParams.get("uuid") ?? "")
      && /^[\w-]{0,80}$/u.test(url.searchParams.get("redirectTarget") ?? "");
  }
  return false;
}

async function readCookieHeader(cookies: HostedBotsProtocolDeps["cookies"]): Promise<string> {
  const saved = await cookies.get({ url: HOSTED_BOTS_ORIGIN });
  const newest = saved.filter(({ name, value, httpOnly, secure }) => cookieName.test(name) && cookieValue.test(value) && httpOnly && secure)
    .sort((left, right) => (right.expirationDate ?? 0) - (left.expirationDate ?? 0))[0];
  return newest ? newest.name + "=" + newest.value : "";
}

async function installCookies(
  headers: Headers,
  jar: HostedBotsProtocolDeps["cookies"],
  isCurrent: () => boolean,
): Promise<void> {
  let changed = false;
  const sessionHeader = headers.get(brokerCookieHeader);
  if (!sessionHeader) return;
  for (const cookie of parseSetCookieHeaders([sessionHeader])) {
    if (!isCurrent()) break;
    if (!cookieName.test(cookie.name) || cookie.domain || cookie.path !== "/" || !cookie.httpOnly || cookie.sameSite !== "lax") continue;
    if (cookie.value === "" && cookie.expires !== undefined && cookie.expires <= Date.now()) {
      await jar.remove(HOSTED_BOTS_ORIGIN, cookie.name);
      changed = true;
    } else if (cookieValue.test(cookie.value) && cookie.secure && cookie.expires && cookie.expires > Date.now()) {
      await jar.set({
        url: HOSTED_BOTS_ORIGIN, name: cookie.name, value: cookie.value, path: "/", secure: true, httpOnly: true,
        sameSite: "lax", expirationDate: Math.floor(cookie.expires / 1000),
      });
      changed = true;
    }
  }
  if (changed) await jar.flushStore();
}

async function readDocument(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let html = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return html + decoder.decode();
      total += next.value.byteLength;
      if (total > MAX_DOCUMENT_BYTES) {
        await reader.cancel();
        throw new Error("Bots document exceeds size limit");
      }
      html += decoder.decode(next.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function safeHostedBotsResponse(upstream: Response, identity: HostedBotsIdentity, url: URL): Promise<Response> {
  const headers = new Headers(upstream.headers);
  for (const name of ["set-cookie", "set-cookie2", brokerCookieHeader, "content-encoding", "content-length", "clear-site-data"]) headers.delete(name);
  const redirect = headers.get("location");
  if (redirect) {
    if (!redirect.startsWith("/") || redirect.startsWith("//")) {
      void upstream.body?.cancel().catch(() => undefined);
      return new Response(null, { status: 502 });
    }
    const next = new URL(redirect, HOSTED_BOTS_ORIGIN);
    if (next.origin !== HOSTED_BOTS_ORIGIN) {
      void upstream.body?.cancel().catch(() => undefined);
      return new Response(null, { status: 502 });
    }
    headers.set("location", next.href);
  }
  const isDocument = ["/", "/pair", "/pair/", "/rail", "/rail/", "/desktop-viewer", "/desktop-viewer/"].includes(url.pathname);
  const responseInit = { status: upstream.status, statusText: upstream.statusText, headers };
  if (upstream.ok && isDocument && upstream.body && /^text\/html(?:;|$)/i.test(headers.get("content-type") ?? "")) {
    const html = await readDocument(upstream.body);
    const base = gatewaySocketBase(identity).href;
    const meta = '<meta name="matrix-bots-websocket-base" content="' + base + '">';
    return new Response(html.replace(/<\/head>/i, meta + "</head>"), responseInit);
  }
  return new Response(upstream.body, responseInit);
}

export function createHostedBotsProtocolHandler(identity: HostedBotsIdentity, deps: HostedBotsProtocolDeps) {
  const isCurrent = () => !deps.disposeSignal?.aborted && deps.getIdentity()?.partition === identity.partition;
  const fetcher = deps.fetcher ?? fetch;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== HOSTED_BOTS_ORIGIN || !isCurrent() || !methods.includes(request.method)) {
      return new Response(null, { status: 403 });
    }
    try {
      const cookie = await readCookieHeader(deps.cookies);
      const token = deps.getToken();
      if (!token || !isCurrent()) return new Response(null, { status: 403 });
      const headers = new Headers();
      for (const name of forwardedHeaders) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      headers.set("Authorization", "Bearer " + token);
      headers.set("Origin", HOSTED_BOTS_ORIGIN);
      headers.set("x-matrix-hosted-bots-proxy", "1");
      if (cookie) headers.set("x-matrix-hosted-bots-session", cookie);

      const target = new URL(gatewayProxyBase(identity).href + url.pathname + url.search);
      const timeout = AbortSignal.timeout(headers.get("accept")?.includes("text/event-stream") ? 120_000 : 30_000);
      const signal = AbortSignal.any(deps.disposeSignal ? [request.signal, timeout, deps.disposeSignal] : [request.signal, timeout]);
      const init: RequestInit & { duplex?: "half" } = {
        method: request.method, headers, redirect: "manual", signal,
        ...(request.body ? { body: request.body, duplex: "half" } : {}),
      };
      const response = await fetcher(target, init);
      if (!isCurrent()) {
        await response.body?.cancel();
        return new Response(null, { status: 403 });
      }
      await installCookies(response.headers, deps.cookies, isCurrent);
      if (!isCurrent()) {
        await response.body?.cancel();
        return new Response(null, { status: 403 });
      }
      return await safeHostedBotsResponse(response, identity, url);
    } catch (error: unknown) {
      console.warn("[hosted-bots-embed] Request failed", error instanceof Error ? error.name : "UnknownError");
      return new Response(null, { status: 502 });
    }
  };
}

export function createHostedBotsTransport(credentials: HostedBotsCredentials) {
  const attached = new WeakMap<Session, { partition: string; refs: number; dispose: () => void }>();
  return {
    register(contents: WebContents, partition: string): () => void {
      const identity = credentials.getIdentity();
      if (!identity || "persist:app-" + identity.partition !== partition) throw new Error("Bots workspace is unavailable");
      const session = contents.session;
      let active = attached.get(session);
      if (!active) {
        const lifetime = new AbortController();
        if (session.protocol.isProtocolHandled("https") || session.protocol.isProtocolHandled("http")) {
          throw new Error("Bots workspace transport is unavailable");
        }
        session.protocol.handle("https", createHostedBotsProtocolHandler(identity, {
          ...credentials, cookies: session.cookies, disposeSignal: lifetime.signal,
        }));
        session.protocol.handle("http", () => new Response(null, { status: 403 }));
        const isCurrent = () => !lifetime.signal.aborted && credentials.getIdentity()?.partition === identity.partition;
        session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, ({ url, resourceType }, callback) => {
          const allowed = resourceType === "webSocket"
            ? isCurrent() && hostedBotsSocketAllowed(identity, url)
            : url.startsWith(HOSTED_BOTS_ORIGIN + "/");
          callback({ cancel: !allowed });
        });
        session.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
          if (details.resourceType !== "webSocket") {
            callback({ requestHeaders: details.requestHeaders });
            return;
          }
          if (!isCurrent() || !hostedBotsSocketAllowed(identity, details.url)) {
            callback({ cancel: true });
            return;
          }
          void readCookieHeader(session.cookies).then((cookie) => {
            const token = credentials.getToken();
            if (!cookie || !token || !isCurrent()) {
              callback({ cancel: true });
              return;
            }
            const requestHeaders = Object.fromEntries(Object.entries(details.requestHeaders).filter(([name]) =>
              !["cookie", "authorization", "origin", "x-matrix-hosted-bots-proxy", "x-matrix-hosted-bots-session"].includes(name.toLowerCase())));
            requestHeaders.Origin = HOSTED_BOTS_ORIGIN;
            requestHeaders.Authorization = "Bearer " + token;
            requestHeaders["x-matrix-hosted-bots-proxy"] = "1";
            requestHeaders["x-matrix-hosted-bots-session"] = cookie;
            callback({ requestHeaders });
          }, (error: unknown) => {
            console.warn("[hosted-bots-embed] Socket credentials unavailable", error instanceof Error ? error.name : "UnknownError");
            callback({ cancel: true });
          });
        });
        active = {
          partition, refs: 0,
          dispose: () => {
            lifetime.abort();
            session.protocol.unhandle("https");
            session.protocol.unhandle("http");
            session.webRequest.onBeforeRequest(null);
            session.webRequest.onBeforeSendHeaders(null);
          },
        };
        attached.set(session, active);
      }
      if (active.partition !== partition) throw new Error("Bots workspace scope changed");
      const retained = active;
      retained.refs += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retained.refs -= 1;
        if (retained.refs > 0) return;
        retained.dispose();
        attached.delete(session);
      };
    },
  };
}
