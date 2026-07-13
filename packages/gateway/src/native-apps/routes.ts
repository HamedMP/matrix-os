import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, generateCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod/v4";
import {
  isRequestPrincipalError,
  mapRequestPrincipalError,
  requireRequestPrincipal,
} from "../request-principal.js";
import { SAFE_NATIVE_APP_ID, SAFE_NATIVE_SESSION_ID, SAFE_NATIVE_STREAM_TOKEN } from "./registry.js";
import { NativeAppError, type NativeAppSession, type NativeAppSessionService } from "./service.js";

const NATIVE_APP_BODY_LIMIT = 2048;
const STREAM_FETCH_TIMEOUT_MS = 30_000;
const STREAM_RESPONSE_BODY_MAX_BYTES = 16 * 1024 * 1024;
const WS_PENDING_MAX_MESSAGES = 32;
const WS_PENDING_MAX_BYTES = 256 * 1024;
const WS_FRAME_MAX_BYTES = 4 * 1024 * 1024;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);
const DECODED_FETCH_RESPONSE_HEADERS = ["content-encoding", "content-length"] as const;
const SAFE_UPSTREAM_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "if-modified-since",
  "if-none-match",
  "pragma",
  "range",
] as const;

const NativeAppIdSchema = z.string().regex(SAFE_NATIVE_APP_ID);
const NativeSessionIdSchema = z.string().regex(SAFE_NATIVE_SESSION_ID);
const NativeStreamTokenSchema = z.string().regex(SAFE_NATIVE_STREAM_TOKEN);
const SAFE_EXPLICIT_VM_PREFIX = /^\/vm\/[a-z0-9][a-z0-9-]{0,62}$/;
const LaunchBodySchema = z.object({
  width: z.number().int().min(320).max(3840).optional(),
  height: z.number().int().min(240).max(2160).optional(),
}).strict();
const NATIVE_STREAM_TOKEN_PARAM = "nativeStreamToken";
const XPRA_WORKER_FALLBACK_MARKER = "matrix-xpra-worker-fallback";
const XPRA_WORKER_FALLBACK_SCRIPT = `<script id="${XPRA_WORKER_FALLBACK_MARKER}">
(() => {
  const NativeWorker = window.Worker;
  if (!NativeWorker) return;
  window.Worker = function MatrixXpraWorker(url, options) {
    try {
      return new NativeWorker(url, options);
    } catch (error) {
      if (!String(url).endsWith("js/lib/wsworker_check.js")) throw error;
      let messageListener = null;
      return {
        addEventListener(type, listener) {
          if (type === "message") messageListener = listener;
        },
        postMessage() {
          queueMicrotask(() => messageListener?.({ data: { result: false } }));
        },
        terminate() {},
      };
    }
  };
})();
</script>`;

export interface NativeAppRoutesOptions {
  service: NativeAppSessionService;
  upgradeWebSocket?: (handler: (c: Context) => any) => MiddlewareHandler;
}

interface NativeWebSocketState {
  close(): void;
  send?(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void;
  _nativeAddPendingBytes?: (bytes: number) => void;
  _nativeClosed?: () => boolean;
  _nativeMarkClosed?: () => void;
  _nativePending?: unknown[];
  _nativePendingBytes?: () => number;
  _nativeResetPendingBytes?: () => void;
  _nativeUpstream?: { close(): void; send(data: never): void };
  _nativeUpstreamOpen?: () => boolean;
}

type WebSocketConstructor = new (url: string) => {
  close(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(data: never): void;
};

function ensureNativeWebSocketPendingState(ws: NativeWebSocketState): unknown[] {
  if (
    ws._nativePending
    && ws._nativePendingBytes
    && ws._nativeAddPendingBytes
    && ws._nativeClosed
    && ws._nativeMarkClosed
    && ws._nativeUpstreamOpen
  ) {
    return ws._nativePending;
  }
  const pending: unknown[] = [];
  let pendingBytes = 0;
  let closed = false;
  ws._nativePending = pending;
  ws._nativePendingBytes = () => pendingBytes;
  ws._nativeAddPendingBytes = (bytes) => {
    pendingBytes += bytes;
  };
  ws._nativeClosed = () => closed;
  ws._nativeMarkClosed = () => {
    closed = true;
  };
  ws._nativeResetPendingBytes = () => {
    pendingBytes = 0;
  };
  ws._nativeUpstreamOpen = () => false;
  return pending;
}

function resolveWebSocketConstructor(wsModule: unknown): WebSocketConstructor {
  const candidate = (wsModule as { default?: unknown; WebSocket?: unknown }).default
    ?? (wsModule as { WebSocket?: unknown }).WebSocket;
  if (typeof candidate !== "function") {
    throw new Error("ws constructor unavailable");
  }
  return candidate as WebSocketConstructor;
}

function mapError(c: Context, err: unknown): Response {
  if (err instanceof z.ZodError) {
    return c.json({ error: "Invalid request" }, 400);
  }
  if (err instanceof NativeAppError) {
    if (err.status >= 500) {
      console.warn("[native-apps] request failed:", err.code, err.message);
    }
    return c.json({ error: err.clientMessage }, err.status);
  }
  if (isRequestPrincipalError(err)) {
    const mapped = mapRequestPrincipalError(err, "Native app request failed");
    if (mapped.log) console.warn("[native-apps] principal error:", err.name);
    return c.json(mapped.body, mapped.status);
  }
  console.warn("[native-apps] unexpected route error:", err instanceof Error ? err.message : String(err));
  return c.json({ error: "Native app request failed" }, 500);
}

function readPrincipal(c: Context): string {
  const configuredUserId = process.env.MATRIX_USER_ID ?? process.env.MATRIX_HANDLE;
  return requireRequestPrincipal(c, {
    authEnabled: true,
    configuredUserId,
    isLocalDevelopment: false,
    isTrustedSingleUserGateway: Boolean(configuredUserId),
    requireAuthContextReady: true,
  }).userId;
}

function configuredPublicSchemeIsHttps(): boolean | null {
  const configuredUrl = process.env.MATRIX_PUBLIC_APP_URL
    ?? process.env.NEXT_PUBLIC_MATRIX_APP_URL
    ?? process.env.NEXT_PUBLIC_GATEWAY_URL
    ?? process.env.NEXT_PUBLIC_MATRIX_GATEWAY_URL
    ?? process.env.MATRIX_PUBLIC_GATEWAY_URL
    ?? process.env.PUBLIC_GATEWAY_URL
    ?? process.env.PUBLIC_APP_URL;
  if (!configuredUrl) return null;
  try {
    return new URL(configuredUrl).protocol === "https:";
  } catch (err: unknown) {
    console.warn("[native-apps] invalid public app URL for stream cookie security:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

function shouldUseSecureStreamCookie(c: Context): boolean {
  if (process.env.MATRIX_NATIVE_APP_INSECURE_COOKIES === "1") return false;
  if (process.env.MATRIX_NATIVE_APP_SECURE_COOKIES === "1") return true;
  const configuredHttps = configuredPublicSchemeIsHttps();
  if (configuredHttps === true) return true;
  if (process.env.NODE_ENV === "production") return true;
  if (configuredHttps === false) return false;
  return c.req.url.startsWith("https://");
}

function nativeStreamRoutePrefix(c: Context): string {
  const forwardedPrefix = c.req.header("x-forwarded-prefix");
  if (forwardedPrefix && SAFE_EXPLICIT_VM_PREFIX.test(forwardedPrefix)) return forwardedPrefix;
  const configuredPrefix = process.env.MATRIX_HANDLE ? `/vm/${process.env.MATRIX_HANDLE}` : "";
  return SAFE_EXPLICIT_VM_PREFIX.test(configuredPrefix) ? configuredPrefix : "";
}

function streamCookiePath(c: Context, sessionId: string): string {
  return `${nativeStreamRoutePrefix(c)}/api/native-apps/sessions/${sessionId}/stream/`;
}

function routeNativeSession(c: Context, session: NativeAppSession): NativeAppSession {
  const prefix = nativeStreamRoutePrefix(c);
  if (!prefix || !session.streamUrl.startsWith("/api/native-apps/")) return session;
  return { ...session, streamUrl: `${prefix}${session.streamUrl}` };
}

function nativeStreamCookieOptions(c: Context, sessionId: string) {
  const secureCookie = shouldUseSecureStreamCookie(c);
  return {
    httpOnly: true,
    path: streamCookiePath(c, sessionId),
    sameSite: secureCookie ? "None" : "Lax",
    secure: secureCookie,
    maxAge: 30 * 60,
  } as const;
}

function nativeStreamCookieHeader(c: Context, service: NativeAppSessionService, sessionId: string, streamToken: string): string {
  return generateCookie(service.streamCookieName(sessionId), streamToken, nativeStreamCookieOptions(c, sessionId));
}

function setNativeStreamCookie(c: Context, service: NativeAppSessionService, sessionId: string, streamToken: string): void {
  setCookie(c, service.streamCookieName(sessionId), streamToken, nativeStreamCookieOptions(c, sessionId));
}

function clearNativeStreamCookie(c: Context, service: NativeAppSessionService, sessionId: string): void {
  deleteCookie(c, service.streamCookieName(sessionId), nativeStreamCookieOptions(c, sessionId));
}

function sanitizeProxyHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const header of HOP_BY_HOP) out.delete(header);
  for (const header of DECODED_FETCH_RESPONSE_HEADERS) out.delete(header);
  out.delete("set-cookie");
  out.delete("set-cookie2");
  return out;
}

function sanitizeProxyRequestHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const header of SAFE_UPSTREAM_REQUEST_HEADERS) {
    const value = headers.get(header);
    if (value !== null) out.set(header, value);
  }
  out.set("accept-encoding", "identity");
  return out;
}

function streamRequestPath(c: Context, sessionId: string): {
  capabilityToken: string | null;
  upstreamPath: string;
} {
  const prefix = `/api/native-apps/sessions/${sessionId}/stream`;
  const raw = c.req.path.slice(prefix.length) || "/";
  const normalized = raw.startsWith("/") ? raw : `/${raw}`;
  const nextSlash = normalized.indexOf("/", 1);
  const firstSegment = nextSlash === -1 ? normalized.slice(1) : normalized.slice(1, nextSlash);
  const parsed = NativeStreamTokenSchema.safeParse(firstSegment);
  if (!parsed.success) {
    return { capabilityToken: null, upstreamPath: normalized };
  }
  return {
    capabilityToken: parsed.data,
    upstreamPath: nextSlash === -1 ? "/" : normalized.slice(nextSlash),
  };
}

function streamSearchWithoutBootstrapToken(c: Context): string {
  const url = new URL(c.req.url);
  url.searchParams.delete(NATIVE_STREAM_TOKEN_PARAM);
  return url.search;
}

function streamBootstrapToken(c: Context): string | null {
  const raw = new URL(c.req.url).searchParams.get(NATIVE_STREAM_TOKEN_PARAM);
  if (raw === null) return null;
  return NativeStreamTokenSchema.parse(raw);
}

function uint8ArrayFromBuffer(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(buffer.byteLength);
  out.set(buffer);
  return out;
}

function websocketPayloadBytes(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (Buffer.isBuffer(data)) return data.byteLength;
  return 0;
}

function streamRequestHasBody(c: Context): boolean {
  if (c.req.method === "GET" || c.req.method === "HEAD") return false;
  const contentLength = c.req.header("content-length");
  if (contentLength && Number(contentLength) > 0) return true;
  return c.req.raw.body !== null;
}

async function readBoundedStreamResponseBody(response: Response): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > STREAM_RESPONSE_BODY_MAX_BYTES) {
        await reader.cancel();
        throw new Error("native app stream response exceeded limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function injectXpraWorkerFallback(
  body: Uint8Array<ArrayBuffer> | null,
  upstreamPath: string,
  contentType: string | null,
): Uint8Array<ArrayBuffer> | null {
  if (
    !body
    || (upstreamPath !== "/" && upstreamPath !== "/index.html")
    || !contentType?.toLowerCase().includes("text/html")
  ) {
    return body;
  }
  const html = new TextDecoder().decode(body);
  if (html.includes(XPRA_WORKER_FALLBACK_MARKER)) return body;
  const headMatch = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!headMatch) return body;
  const insertAt = headMatch.index + headMatch[0].length;
  return new TextEncoder().encode(
    `${html.slice(0, insertAt)}${XPRA_WORKER_FALLBACK_SCRIPT}${html.slice(insertAt)}`,
  );
}

async function proxyStreamRequest(c: Context, service: NativeAppSessionService): Promise<Response> {
  const parsed = NativeSessionIdSchema.safeParse(c.req.param("sessionId"));
  if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
  const sessionId = parsed.data;
  let bootstrapToken: string | null;
  try {
    bootstrapToken = streamBootstrapToken(c);
  } catch (err) {
    if (err instanceof z.ZodError) return c.json({ error: "Invalid request" }, 400);
    throw err;
  }
  const requestPath = streamRequestPath(c, sessionId);
  const token = requestPath.capabilityToken
    ?? getCookie(c, service.streamCookieName(sessionId))
    ?? bootstrapToken;
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  const target = service.getStreamTarget(sessionId, token);
  if (!target) return c.json({ error: "Unauthorized" }, 401);
  if (streamRequestHasBody(c)) return c.json({ error: "Invalid request" }, 400);

  const upstream = new URL(`http://127.0.0.1:${target.port}${requestPath.upstreamPath}`);
  upstream.search = streamSearchWithoutBootstrapToken(c);
  const response = await fetch(upstream, {
    method: c.req.method,
    headers: sanitizeProxyRequestHeaders(c.req.raw.headers),
    body: undefined,
    redirect: "error",
    signal: AbortSignal.timeout(STREAM_FETCH_TIMEOUT_MS),
  });
  const headers = sanitizeProxyHeaders(response.headers);
  const bufferedBody = await readBoundedStreamResponseBody(response);
  const body = injectXpraWorkerFallback(
    bufferedBody,
    requestPath.upstreamPath,
    response.headers.get("content-type"),
  );
  const responseToken = requestPath.capabilityToken ?? bootstrapToken;
  if (responseToken) {
    headers.append("Set-Cookie", nativeStreamCookieHeader(c, service, sessionId, responseToken));
  }
  return new Response(body, {
    status: response.status,
    headers,
  });
}

export function createNativeWebSocketHandler(c: Context, service: NativeAppSessionService) {
  const parsed = NativeSessionIdSchema.safeParse(c.req.param("sessionId"));
  if (!parsed.success) {
    return {
      onOpen: (_evt: unknown, ws: { close(): void }) => ws.close(),
    };
  }
  const sessionId = parsed.data;
  let bootstrapToken: string | null;
  try {
    bootstrapToken = streamBootstrapToken(c);
  } catch (err: unknown) {
    if (!(err instanceof z.ZodError)) {
      console.warn("[native-apps] unexpected websocket stream token parse error:", err instanceof Error ? err.message : String(err));
    }
    bootstrapToken = null;
  }
  const requestPath = streamRequestPath(c, sessionId);
  const token = requestPath.capabilityToken
    ?? getCookie(c, service.streamCookieName(sessionId))
    ?? bootstrapToken;
  const streamToken = token ?? null;
  if (!streamToken) {
    return {
      onOpen: (_evt: unknown, ws: { close(): void }) => ws.close(),
    };
  }
  const target = service.getStreamTarget(sessionId, streamToken);
  if (!target) {
    return {
      onOpen: (_evt: unknown, ws: { close(): void }) => ws.close(),
    };
  }
  const search = streamSearchWithoutBootstrapToken(c);
  const upstreamUrl = `ws://127.0.0.1:${target.port}${requestPath.upstreamPath}${search}`;

  return {
    onOpen(_evt: unknown, ws: NativeWebSocketState) {
      const pending = ensureNativeWebSocketPendingState(ws);
      let upstreamOpen = false;
      ws._nativeUpstreamOpen = () => upstreamOpen;

      import("ws").then((wsModule) => {
        const WebSocket = resolveWebSocketConstructor(wsModule);
        if (ws._nativeClosed?.()) return;
        const upstream = new WebSocket(upstreamUrl);
        ws._nativeUpstream = upstream;
        if (ws._nativeClosed?.()) {
          upstream.close();
          return;
        }
        upstream.on("open", () => {
          upstreamOpen = true;
          for (const item of pending.splice(0)) upstream.send(item as never);
          ws._nativeResetPendingBytes?.();
        });
        upstream.on("message", (data) => {
          if (!service.touchStreamSession(sessionId, streamToken) || websocketPayloadBytes(data) > WS_FRAME_MAX_BYTES) {
            ws._nativeMarkClosed?.();
            upstream.close();
            ws.close();
            return;
          }
          if (typeof data === "string") ws.send?.(data);
          else if (data instanceof ArrayBuffer) ws.send?.(data);
          else if (Array.isArray(data)) ws.send?.(uint8ArrayFromBuffer(Buffer.concat(data)));
          else ws.send?.(uint8ArrayFromBuffer(data));
        });
        upstream.on("close", () => ws.close());
        upstream.on("error", () => ws.close());
      }).catch((err: unknown) => {
        console.warn("[native-apps] websocket proxy setup failed:", err instanceof Error ? err.message : String(err));
        ws.close();
      });
    },
    onMessage(evt: { data: unknown }, ws: NativeWebSocketState) {
      if (ws._nativeClosed?.()) return;
      const nextBytes = websocketPayloadBytes(evt.data);
      if (nextBytes > WS_FRAME_MAX_BYTES || !service.touchStreamSession(sessionId, streamToken)) {
        ws._nativeMarkClosed?.();
        ws._nativeUpstream?.close();
        ws.close();
        return;
      }
      if (ws._nativeUpstream && ws._nativeUpstreamOpen?.()) {
        ws._nativeUpstream.send(evt.data as never);
      } else {
        const pending = ensureNativeWebSocketPendingState(ws);
        if (
          pending.length >= WS_PENDING_MAX_MESSAGES
          || (ws._nativePendingBytes?.() ?? 0) + nextBytes > WS_PENDING_MAX_BYTES
        ) {
          ws._nativeMarkClosed?.();
          ws.close();
          return;
        }
        ws._nativeAddPendingBytes?.(nextBytes);
        pending.push(evt.data);
      }
    },
    onClose(_evt: unknown, ws: NativeWebSocketState) {
      ws._nativeMarkClosed?.();
      ws._nativeUpstream?.close();
    },
    onError(_evt: unknown, ws: NativeWebSocketState) {
      ws._nativeMarkClosed?.();
      ws._nativeUpstream?.close();
    },
  };
}

export function createNativeAppRoutes(options: NativeAppRoutesOptions) {
  const app = new Hono();
  const { service } = options;
  const limited = bodyLimit({ maxSize: NATIVE_APP_BODY_LIMIT });

  app.get("/", (c) => {
    try {
      readPrincipal(c);
      return c.json({ apps: service.listApps() });
    } catch (err) {
      return mapError(c, err);
    }
  });

  app.post("/:appId/sessions", limited, async (c) => {
    try {
      const appId = NativeAppIdSchema.parse(c.req.param("appId"));
      const ownerId = readPrincipal(c);
      let rawBody: unknown;
      try {
        rawBody = await c.req.json();
      } catch (err: unknown) {
        console.warn("[native-apps] invalid launch JSON:", err instanceof Error ? err.message : String(err));
        return c.json({ error: "Invalid request" }, 400);
      }
      const body = LaunchBodySchema.parse(rawBody);
      const session = await service.launchSession({ ownerId, appId, ...body });
      const streamToken = service.streamCookieValue(session.id);
      if (!streamToken) return c.json({ error: "Native app request failed" }, 500);
      setNativeStreamCookie(c, service, session.id, streamToken);
      return c.json({ session: routeNativeSession(c, session) }, 201);
    } catch (err) {
      return mapError(c, err);
    }
  });

  app.get("/sessions/:sessionId", (c) => {
    try {
      const sessionId = NativeSessionIdSchema.parse(c.req.param("sessionId"));
      const ownerId = readPrincipal(c);
      const session = service.inspectSession(ownerId, sessionId);
      if (!session) return c.json({ error: "Native app session not found" }, 404);
      return c.json({ session: routeNativeSession(c, session) });
    } catch (err) {
      return mapError(c, err);
    }
  });

  app.delete("/sessions/:sessionId", limited, async (c) => {
    try {
      const sessionId = NativeSessionIdSchema.parse(c.req.param("sessionId"));
      const ownerId = readPrincipal(c);
      const session = await service.terminateSession(ownerId, sessionId);
      clearNativeStreamCookie(c, service, sessionId);
      return c.json({ session: routeNativeSession(c, session) });
    } catch (err) {
      return mapError(c, err);
    }
  });

  if (options.upgradeWebSocket) {
    app.get("/sessions/:sessionId/stream/*", options.upgradeWebSocket((c) => createNativeWebSocketHandler(c, service)));
  }

  app.all("/sessions/:sessionId/stream/*", limited, async (c) => {
    try {
      return await proxyStreamRequest(c, service);
    } catch (err) {
      console.warn("[native-apps] stream proxy failed:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "Native app stream unavailable" }, 503);
    }
  });

  return app;
}
