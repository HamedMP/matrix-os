import { request as unixRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import type { createNodeWebSocket } from "@hono/node-ws";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createOpenMausBotSockets, openMausBotWebSocketPath } from "./oss-sockets.js";

export const OPENMAUSBOT_PROXY_BASE = "/api/hosted-bots/runtime";
export const OPENMAUSBOT_CLIENT_ORIGIN = "https://matrix-bots.invalid";
export const OPENMAUSBOT_RUNTIME_SOCKET = "/run/matrix-openmausbot/http.sock";

const PROXY_MARKER = "x-matrix-hosted-bots-proxy";
const SESSION_HEADER = "x-matrix-hosted-bots-session";
export const OPENMAUSBOT_SET_SESSION_HEADER = "x-matrix-hosted-bots-set-session";
const SESSION_NAME = /^omb_session_\d{1,5}_[a-z0-9]{0,12}$/i;
const SESSION_VALUE = /^omb_sess_[a-z0-9_-]{1,200}$/i;
// Public surface used by the pinned v0.1.150 frontend. Keep server-internal,
// test, cloud-sync, admin bootstrap and arbitrary proxy paths outside this bridge.
// Attachment uploads use the files, attachments and attachment-storage families.
const API_SURFACE = new Set((
  "accounts admin-activity app-triggers attachment-storage attachments auth bot-defaults bot-presets bots brand " +
  "browser-engine browser-sites calendar-calls cli-candidates cli-test computers config connectors decider desktop-viewer " +
  "edition email events files fleet groups health helpers images inbox instances keys limit-resets live local-computer logins " +
  "mcp me needs-you notifications org-library phones plan-usage postiz presence profile published-pages routine-runs routines " +
  "search section-context settings setup-import shared-computers sidebar-sections skills-library starter stop-line team " +
  "team-computers team-library team-map team-memory teams threads time-zone tts updates usage web-panels webhooks workspace " +
  "workspace-backup"
).split(" "));
const STATIC_SURFACE = /^\/(?:$|pair\/?$|rail\/?$|desktop-viewer\/?$|assets\/.+|app-icon(?:-\d+\.png|\.svg)$|apple-touch-icon\.png$|manifest\.webmanifest$|novnc-NOTICE\.txt$)/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const REQUEST_HEADERS = ["accept", "content-type", "range", "if-none-match", "if-modified-since", "user-agent",
  "x-omb-background", "x-omb-sha256"];
const RESPONSE_HEADERS = ["content-type", "content-length", "content-disposition", "content-encoding",
  "accept-ranges", "content-range", "etag", "last-modified", "content-security-policy", "x-frame-options",
  "referrer-policy", "cross-origin-resource-policy", "cross-origin-opener-policy", "x-openmausbot-folder", "x-omb-cloud-power"];
const BODY_LIMIT = 8 * 1024 * 1024;
const MAX_ACTIVE_REQUESTS = 24;
const IDLE_MS = 120_000;
const START_MS = 12_000;

function isSessionCookie(pair: string): boolean {
  const separator = pair.indexOf("=");
  return separator > 0 && SESSION_NAME.test(pair.slice(0, separator)) && SESSION_VALUE.test(pair.slice(separator + 1));
}

function readSession(headers: Headers): string | undefined {
  const presented = headers.get(SESSION_HEADER);
  return presented && isSessionCookie(presented) ? presented : undefined;
}

export function toOpenMausBotRequestHeaders(headers: Headers): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = {
    host: new URL(OPENMAUSBOT_CLIENT_ORIGIN).host,
    origin: OPENMAUSBOT_CLIENT_ORIGIN,
    "x-forwarded-proto": "https",
  };
  for (const name of REQUEST_HEADERS) {
    const value = headers.get(name);
    if (value !== null) forwarded[name] = value;
  }
  const cookie = readSession(headers);
  if (cookie) forwarded.cookie = cookie;
  return forwarded;
}

function appendSessionCookie(headers: Headers, serialized: string) {
  const [pair, ...attributes] = serialized.split(";").map((value) => value.trim());
  if (!pair) return;
  const parts = attributes.map((value) => value.toLowerCase());
  if (!parts.includes("path=/") || !parts.includes("httponly") || !parts.includes("samesite=lax")
    || parts.some((value) => value.startsWith("domain="))) return;
  const clear = pair.endsWith("=") && SESSION_NAME.test(pair.slice(0, -1)) && parts.includes("max-age=0");
  if (!isSessionCookie(pair) && !clear) return;
  headers.set(OPENMAUSBOT_SET_SESSION_HEADER, parts.includes("secure") ? serialized : serialized + "; Secure");
}

function responseHeaders(reply: IncomingMessage): Headers {
  const headers = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
  for (const name of RESPONSE_HEADERS) {
    const value = reply.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  for (const cookie of reply.headers["set-cookie"] ?? []) appendSessionCookie(headers, cookie);
  const location = reply.headers.location;
  if (location && URL.canParse(location, OPENMAUSBOT_CLIENT_ORIGIN)) {
    const url = new URL(location, OPENMAUSBOT_CLIENT_ORIGIN);
    if (url.origin === OPENMAUSBOT_CLIENT_ORIGIN && !url.username && !url.password) {
      headers.set("location", url.pathname + url.search + url.hash);
    }
  }
  return headers;
}

export function openMausBotUpstreamPath(requestUrl: string): string | null {
  const { pathname, search } = new URL(requestUrl);
  if (!pathname.startsWith(OPENMAUSBOT_PROXY_BASE + "/")) return null;
  const path = pathname.slice(OPENMAUSBOT_PROXY_BASE.length);
  if (path.length > 2_048 || search.length > 8_192 || /%2f|%5c|%25/i.test(path)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return null;
  }
  if (decoded.includes("//") || decoded.includes("\\") || /[\x00-\x1f\x7f]/u.test(decoded)
    || decoded.split("/").some((segment) => segment === "." || segment === "..")
    || !(STATIC_SURFACE.test(decoded) || decoded === "/api/x/status"
      || (decoded.startsWith("/api/") && API_SURFACE.has(decoded.split("/")[2] ?? "")))) return null;
  return path + search;
}

function requestUnix(socketPath: string, path: string, options: {
  method: string; headers: OutgoingHttpHeaders; body?: Uint8Array; signal: AbortSignal;
}): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = unixRequest({
      socketPath, path, method: options.method, headers: options.headers, signal: options.signal, agent: false,
    });
    const timeout = setTimeout(() => request.destroy(new Error("OpenMausBot response deadline")), START_MS);
    timeout.unref();
    request.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    request.setTimeout(IDLE_MS, () => request.destroy(new Error("OpenMausBot stream idle")));
    request.once("response", (reply) => {
      clearTimeout(timeout);
      resolve(reply);
    });
    request.end(options.body);
  });
}

function openResponse(reply: IncomingMessage, method: string): Response {
  const status = reply.statusCode ?? 502;
  const headers = responseHeaders(reply);
  if (method === "HEAD" || status === 204 || status === 304 || status === 205) {
    reply.resume();
    return new Response(null, { status, headers });
  }
  const body = Readable.toWeb(reply) as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers });
}

export function createOpenMausBotGateway(options: {
  socketPath: string;
  admitted: boolean;
  isOwner: (c: Context) => boolean;
  upgradeWebSocket?: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"];
}) {
  const app = new Hono();
  const active = new Set<AbortController>();
  const sockets = options.admitted && options.upgradeWebSocket ? createOpenMausBotSockets(options.socketPath) : null;
  let closing = false;
  app.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    if (!options.admitted) return c.json({ error: "not_found" }, 404);
    if (!options.isOwner(c)) return c.json({ error: "forbidden" }, 403);
    if (closing) return c.json({ error: "unavailable" }, 503);
    await next();
  });

  app.get("/", async (c) => {
    if (active.size >= MAX_ACTIVE_REQUESTS) return c.json({ error: "unavailable" }, 503);
    const lifetime = new AbortController();
    active.add(lifetime);
    try {
      const reply = await requestUnix(options.socketPath, "/api/health", {
        method: "GET", headers: { host: new URL(OPENMAUSBOT_CLIENT_ORIGIN).host },
        signal: AbortSignal.any([c.req.raw.signal, lifetime.signal, AbortSignal.timeout(2_000)]),
      });
      if (reply.statusCode !== 200) {
        reply.destroy();
        return c.json({ error: "unavailable" }, 503);
      }
      let health = "";
      for await (const chunk of reply) {
        health += String(chunk);
        if (health.length > 256) throw new Error("Invalid OpenMausBot health response");
      }
      const value: unknown = JSON.parse(health);
      if (typeof value !== "object" || value === null || !("app" in value) || value.app !== "openmausbot") {
        return c.json({ error: "unavailable" }, 503);
      }
      return c.json({ ready: true });
    } catch (error) {
      console.warn("[hosted-bots] OSS health unavailable", { errorName: error instanceof Error ? error.name : "UnknownError" });
      return c.json({ error: "unavailable" }, 503);
    } finally {
      active.delete(lifetime);
    }
  });

  app.get("/*", async (c, next) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return next();
    if (c.req.header(PROXY_MARKER) !== "1" || c.req.header("origin") !== OPENMAUSBOT_CLIENT_ORIGIN) {
      return c.json({ error: "forbidden" }, 403);
    }
    const path = openMausBotUpstreamPath(c.req.url);
    if (!path || !openMausBotWebSocketPath(path) || !sockets || !options.upgradeWebSocket) {
      return c.json({ error: "not_found" }, 404);
    }
    const headers = toOpenMausBotRequestHeaders(c.req.raw.headers);
    const events = await sockets.connect(path, headers, c.req.header("sec-websocket-protocol") ?? null, c.req.raw.signal);
    if (!events) return c.json({ error: "unavailable" }, 503);
    return options.upgradeWebSocket(() => events)(c, next);
  });

  app.all("/*", bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ error: "too_large" }, 413) }), async (c) => {
    if (c.req.header(PROXY_MARKER) !== "1" || c.req.header("sec-fetch-mode") === "navigate") {
      return c.json({ error: "forbidden" }, 403);
    }
    const method = c.req.method;
    if (!METHODS.has(method)) return c.json({ error: "method_not_allowed" }, 405);
    const path = openMausBotUpstreamPath(c.req.url);
    if (path && (!path.startsWith("/api/") || path.split("?")[0] === "/api/x/status")
      && method !== "GET" && method !== "HEAD") return c.json({ error: "method_not_allowed" }, 405);
    if (!path) return c.json({ error: "not_found" }, 404);
    if (active.size >= MAX_ACTIVE_REQUESTS) return c.json({ error: "unavailable" }, 503);

    const lifetime = new AbortController();
    active.add(lifetime);
    try {
      const headers = toOpenMausBotRequestHeaders(c.req.raw.headers);
      const body = c.req.raw.body ? new Uint8Array(await c.req.arrayBuffer()) : undefined;
      if (body) headers["content-length"] = body.byteLength;
      const reply = await requestUnix(options.socketPath, path, {
        method, headers, body, signal: AbortSignal.any([c.req.raw.signal, lifetime.signal]),
      });
      reply.once("close", () => active.delete(lifetime));
      return openResponse(reply, method);
    } catch (error) {
      active.delete(lifetime);
      lifetime.abort();
      if (error instanceof Error && error.name === "BodyLimitError") return c.json({ error: "too_large" }, 413);
      console.warn("[hosted-bots] OSS transport failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
      return c.json({ error: "unavailable" }, 502);
    }
  });

  return {
    routes: app,
    close() {
      closing = true;
      sockets?.close();
      for (const request of active) request.abort();
      active.clear();
    },
  };
}
