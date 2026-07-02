import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod/v4";
import {
  isRequestPrincipalError,
  mapRequestPrincipalError,
  requireRequestPrincipal,
} from "../request-principal.js";
import { SAFE_NATIVE_APP_ID, SAFE_NATIVE_SESSION_ID } from "./registry.js";
import { NativeAppError, type NativeAppSessionService } from "./service.js";

const NATIVE_APP_BODY_LIMIT = 2048;
const STREAM_FETCH_TIMEOUT_MS = 30_000;
const WS_PENDING_MAX_MESSAGES = 32;
const WS_PENDING_MAX_BYTES = 256 * 1024;
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
const LaunchBodySchema = z.object({
  width: z.number().int().min(320).max(3840).optional(),
  height: z.number().int().min(240).max(2160).optional(),
}).strict();

export interface NativeAppRoutesOptions {
  service: NativeAppSessionService;
  upgradeWebSocket?: (handler: (c: Context) => any) => MiddlewareHandler;
}

interface NativeWebSocketState {
  close(): void;
  send?(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void;
  _nativeAddPendingBytes?: (bytes: number) => void;
  _nativePending?: unknown[];
  _nativePendingBytes?: () => number;
  _nativeUpstream?: { close(): void; send(data: never): void };
  _nativeUpstreamOpen?: () => boolean;
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
  return requireRequestPrincipal(c, {
    authEnabled: true,
    isLocalDevelopment: false,
    requireAuthContextReady: true,
  }).userId;
}

function sanitizeProxyHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const header of HOP_BY_HOP) out.delete(header);
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
  return out;
}

function streamSubPath(c: Context, sessionId: string): string {
  const prefix = `/api/native-apps/sessions/${sessionId}/stream`;
  const raw = c.req.path.slice(prefix.length) || "/";
  return raw.startsWith("/") ? raw : `/${raw}`;
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

async function proxyStreamRequest(c: Context, service: NativeAppSessionService): Promise<Response> {
  const parsed = NativeSessionIdSchema.safeParse(c.req.param("sessionId"));
  if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
  const sessionId = parsed.data;
  const token = getCookie(c, service.streamCookieName(sessionId));
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  const target = service.getStreamTarget(sessionId, token);
  if (!target) return c.json({ error: "Unauthorized" }, 401);

  const upstream = new URL(`http://127.0.0.1:${target.port}${streamSubPath(c, sessionId)}`);
  upstream.search = new URL(c.req.url).search;
  const response = await fetch(upstream, {
    method: c.req.method,
    headers: sanitizeProxyRequestHeaders(c.req.raw.headers),
    body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
    redirect: "error",
    signal: AbortSignal.timeout(STREAM_FETCH_TIMEOUT_MS),
  });
  return new Response(response.body, {
    status: response.status,
    headers: sanitizeProxyHeaders(response.headers),
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
  const token = getCookie(c, service.streamCookieName(sessionId));
  const target = token ? service.getStreamTarget(sessionId, token) : null;
  if (!target) {
    return {
      onOpen: (_evt: unknown, ws: { close(): void }) => ws.close(),
    };
  }
  const subPath = streamSubPath(c, sessionId);
  const search = new URL(c.req.url).search;
  const upstreamUrl = `ws://127.0.0.1:${target.port}${subPath}${search}`;

  return {
    onOpen(_evt: unknown, ws: NativeWebSocketState) {
      const pending: unknown[] = [];
      let pendingBytes = 0;
      let upstreamOpen = false;
      ws._nativePending = pending;
      ws._nativePendingBytes = () => pendingBytes;
      ws._nativeAddPendingBytes = (bytes) => {
        pendingBytes += bytes;
      };
      ws._nativeUpstreamOpen = () => upstreamOpen;

      import("ws").then(({ WebSocket }) => {
        const upstream = new WebSocket(upstreamUrl);
        upstream.on("open", () => {
          upstreamOpen = true;
          for (const item of pending.splice(0)) upstream.send(item as never);
          pendingBytes = 0;
        });
        upstream.on("message", (data) => {
          if (typeof data === "string") ws.send?.(data);
          else if (data instanceof ArrayBuffer) ws.send?.(data);
          else if (Array.isArray(data)) ws.send?.(uint8ArrayFromBuffer(Buffer.concat(data)));
          else ws.send?.(uint8ArrayFromBuffer(data));
        });
        upstream.on("close", () => ws.close());
        upstream.on("error", () => ws.close());
        ws._nativeUpstream = upstream;
      }).catch((err: unknown) => {
        console.warn("[native-apps] websocket proxy setup failed:", err instanceof Error ? err.message : String(err));
        ws.close();
      });
    },
    onMessage(evt: { data: unknown }, ws: NativeWebSocketState) {
      if (ws._nativeUpstream && ws._nativeUpstreamOpen?.()) {
        ws._nativeUpstream.send(evt.data as never);
      } else {
        const nextBytes = websocketPayloadBytes(evt.data);
        if (
          !ws._nativePending
          || ws._nativePending.length >= WS_PENDING_MAX_MESSAGES
          || (ws._nativePendingBytes?.() ?? 0) + nextBytes > WS_PENDING_MAX_BYTES
        ) {
          ws.close();
          return;
        }
        ws._nativeAddPendingBytes?.(nextBytes);
        ws._nativePending?.push(evt.data);
      }
    },
    onClose(_evt: unknown, ws: NativeWebSocketState) {
      ws._nativeUpstream?.close();
    },
    onError(_evt: unknown, ws: NativeWebSocketState) {
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
      setCookie(c, service.streamCookieName(session.id), streamToken, {
        httpOnly: true,
        path: session.streamUrl,
        sameSite: "Strict",
        secure: c.req.url.startsWith("https://"),
        maxAge: 30 * 60,
      });
      return c.json({ session }, 201);
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
      return c.json({ session });
    } catch (err) {
      return mapError(c, err);
    }
  });

  app.delete("/sessions/:sessionId", limited, async (c) => {
    try {
      const sessionId = NativeSessionIdSchema.parse(c.req.param("sessionId"));
      const ownerId = readPrincipal(c);
      const session = await service.terminateSession(ownerId, sessionId);
      return c.json({ session });
    } catch (err) {
      return mapError(c, err);
    }
  });

  if (options.upgradeWebSocket) {
    app.get("/sessions/:sessionId/stream/*", options.upgradeWebSocket((c) => createNativeWebSocketHandler(c, service)));
  }

  app.all("/sessions/:sessionId/stream/*", async (c) => {
    try {
      return await proxyStreamRequest(c, service);
    } catch (err) {
      console.warn("[native-apps] stream proxy failed:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "Native app stream unavailable" }, 503);
    }
  });

  return app;
}
