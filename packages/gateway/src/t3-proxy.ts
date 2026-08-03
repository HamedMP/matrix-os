import { WebSocket } from "ws";

export const T3_PROXY_PREFIX = "/api/integrations/t3";
export const T3_PROXY_BODY_LIMIT = 10 * 1024 * 1024;
export const T3_PROXY_MAX_WS_CONNECTIONS = 100;
export const T3_PROXY_MAX_WS_FRAME_BYTES = 1024 * 1024;
const T3_PROXY_MAX_PENDING_BYTES = 2 * 1024 * 1024;
const T3_PROXY_TIMEOUT_MS = 30_000;
const T3_PROXY_WS_HANDSHAKE_TIMEOUT_MS = 10_000;
const T3_PROXY_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-matrix-code-proxy-token",
  "x-matrix-edge-secret",
  "x-platform-user-id",
  "x-platform-verified",
]);

const FORBIDDEN_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function isAllowedT3Path(path: string): boolean {
  return path === "/.well-known/t3/environment"
    || path === "/oauth/token"
    || path === "/ws"
    || path === "/api"
    || path.startsWith("/api/");
}

export function buildT3ProxyTarget(rawUrl: string, protocol: "http:" | "ws:" = "http:"): string | null {
  if (rawUrl.includes("%")) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (err: unknown) {
    if (err instanceof TypeError) return null;
    throw err;
  }
  if (!url.pathname.startsWith(`${T3_PROXY_PREFIX}/`)) return null;
  const path = url.pathname.slice(T3_PROXY_PREFIX.length);
  if (!isAllowedT3Path(path)) return null;

  const target = new URL(`${protocol}//127.0.0.1:3773`);
  target.pathname = path;
  target.search = url.search;
  return target.toString();
}

function buildT3RequestHeaders(headers: Headers): Headers {
  const result = new Headers();
  for (const [name, value] of headers) {
    if (!FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) {
      result.set(name, value);
    }
  }
  return result;
}

function buildT3ResponseHeaders(headers: Headers): Headers {
  const result = new Headers();
  for (const [name, value] of headers) {
    if (!FORBIDDEN_RESPONSE_HEADERS.has(name.toLowerCase())) {
      result.set(name, value);
    }
  }
  result.set("cache-control", "no-store, private");
  result.set("cdn-cache-control", "no-store");
  result.set("cloudflare-cdn-cache-control", "no-store");
  return result;
}

export async function proxyT3HttpRequest(
  request: Request,
  options: {
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<Response> {
  if (!T3_PROXY_METHODS.has(request.method.toUpperCase())) {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { allow: [...T3_PROXY_METHODS].join(", ") } },
    );
  }
  const target = buildT3ProxyTarget(request.url);
  if (!target) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const upstream = await (options.fetchFn ?? fetch)(target, {
      method: request.method,
      headers: buildT3RequestHeaders(request.headers),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? T3_PROXY_TIMEOUT_MS),
      body: request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer(),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: buildT3ResponseHeaders(upstream.headers),
    });
  } catch (err: unknown) {
    console.warn("[t3-proxy] local HTTP upstream unavailable", {
      errorKind: err instanceof Error ? err.name : typeof err,
    });
    return Response.json(
      { error: "T3 Code is not running" },
      {
        status: 503,
        headers: {
          "cache-control": "no-store, private",
          "cdn-cache-control": "no-store",
          "cloudflare-cdn-cache-control": "no-store",
        },
      },
    );
  }
}

interface T3ClientWebSocket {
  bufferedAmount?: number;
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}

interface T3ClientMessageEvent {
  data: unknown;
}

interface T3UpstreamWebSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown, isBinary?: boolean) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (err: unknown) => void): this;
  send(data: string | Buffer): void;
  close(): void;
}

interface T3ProxyConnection {
  client: T3ClientWebSocket;
  upstream: T3UpstreamWebSocket;
  pending: Array<string | Buffer>;
  pendingBytes: number;
  closed: boolean;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
}

export interface T3WebSocketProxyHub {
  createHandler(rawUrl: string, origin?: string): {
    onOpen?(event: unknown, ws: T3ClientWebSocket): void;
    onMessage?(event: T3ClientMessageEvent): void;
    onClose?(): void;
    onError?(): void;
  };
  close(): void;
  activeConnectionsForTest(): number;
}

export interface T3WebSocketProxyHubOptions {
  maxConnections?: number;
  maxFrameBytes?: number;
  maxPendingBytes?: number;
  handshakeTimeoutMs?: number;
  connect?: (target: string, origin?: string, maxFrameBytes?: number) => T3UpstreamWebSocket;
}

function messageBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data));
}

function outboundFrame(data: unknown): string | Buffer {
  return typeof data === "string" ? data : messageBuffer(data);
}

function frameByteLength(frame: string | Buffer): number {
  return typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
}

function closeClient(ws: T3ClientWebSocket, code = 1011, reason = "T3 connection closed"): void {
  try {
    ws.close(code, reason);
  } catch (err: unknown) {
    console.warn("[t3-proxy] client close failed", {
      errorKind: err instanceof Error ? err.name : typeof err,
    });
  }
}

export function createT3WebSocketProxyHub(
  options: T3WebSocketProxyHubOptions = {},
): T3WebSocketProxyHub {
  const maxConnections = options.maxConnections ?? T3_PROXY_MAX_WS_CONNECTIONS;
  const maxFrameBytes = options.maxFrameBytes ?? T3_PROXY_MAX_WS_FRAME_BYTES;
  const maxPendingBytes = options.maxPendingBytes ?? T3_PROXY_MAX_PENDING_BYTES;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? T3_PROXY_WS_HANDSHAKE_TIMEOUT_MS;
  const connect = options.connect ?? (
    (target: string, origin?: string, payloadLimit = maxFrameBytes) => new WebSocket(
      target,
      origin ? { origin, maxPayload: payloadLimit } : { maxPayload: payloadLimit },
    )
  );
  const active = new Set<T3ProxyConnection>();

  const cleanup = (connection: T3ProxyConnection, closeUpstream: boolean): void => {
    if (connection.closed) return;
    connection.closed = true;
    connection.pending.splice(0);
    connection.pendingBytes = 0;
    if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer);
    connection.handshakeTimer = null;
    active.delete(connection);
    if (closeUpstream) {
      try {
        connection.upstream.close();
      } catch (err: unknown) {
        console.warn("[t3-proxy] upstream close failed", {
          errorKind: err instanceof Error ? err.name : typeof err,
        });
      }
    }
  };

  return {
    createHandler(rawUrl: string, origin?: string) {
      const target = buildT3ProxyTarget(rawUrl, "ws:");
      let connection: T3ProxyConnection | null = null;

      return {
        onOpen(_event, client) {
          if (!target || active.size >= maxConnections) {
            closeClient(client, target ? 1013 : 1008, target ? "Too many connections" : "Invalid path");
            return;
          }
          let upstream: T3UpstreamWebSocket;
          try {
            upstream = connect(target, origin, maxFrameBytes);
          } catch (err: unknown) {
            console.warn("[t3-proxy] local WebSocket connection failed", {
              errorKind: err instanceof Error ? err.name : typeof err,
            });
            closeClient(client);
            return;
          }
          connection = {
            client,
            upstream,
            pending: [],
            pendingBytes: 0,
            closed: false,
            handshakeTimer: null,
          };
          active.add(connection);
          connection.handshakeTimer = setTimeout(() => {
            if (!connection || connection.closed || connection.upstream.readyState === WebSocket.OPEN) return;
            closeClient(client, 1013, "T3 connection timed out");
            cleanup(connection, true);
          }, handshakeTimeoutMs);
          connection.handshakeTimer.unref?.();

          upstream.on("open", () => {
            if (!connection || connection.closed) return;
            if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer);
            connection.handshakeTimer = null;
            try {
              for (const frame of connection.pending) upstream.send(frame);
            } catch (err: unknown) {
              console.warn("[t3-proxy] queued upstream send failed", {
                errorKind: err instanceof Error ? err.name : typeof err,
              });
              closeClient(client);
              cleanup(connection, true);
              return;
            }
            connection.pending.splice(0);
            connection.pendingBytes = 0;
          });
          upstream.on("message", (data, isBinary = true) => {
            if (!connection || connection.closed) return;
            const frame = messageBuffer(data);
            if (frame.byteLength > maxFrameBytes) {
              closeClient(client, 1009, "Frame too large");
              cleanup(connection, true);
              return;
            }
            if ((client.bufferedAmount ?? 0) + frame.byteLength > maxPendingBytes) {
              closeClient(client, 1009, "Outbound data limit exceeded");
              cleanup(connection, true);
              return;
            }
            try {
              client.send(isBinary ? new Uint8Array(frame) : frame.toString());
            } catch (err: unknown) {
              console.warn("[t3-proxy] client send failed", {
                errorKind: err instanceof Error ? err.name : typeof err,
              });
              cleanup(connection, true);
            }
          });
          upstream.on("close", () => {
            if (!connection || connection.closed) return;
            closeClient(client);
            cleanup(connection, false);
          });
          upstream.on("error", (err) => {
            console.warn("[t3-proxy] local WebSocket upstream unavailable", {
              errorKind: err instanceof Error ? err.name : typeof err,
            });
            if (!connection || connection.closed) return;
            closeClient(client);
            cleanup(connection, true);
          });
        },
        onMessage(event) {
          if (!connection || connection.closed) return;
          const frame = outboundFrame(event.data);
          const frameBytes = frameByteLength(frame);
          if (frameBytes > maxFrameBytes) {
            closeClient(connection.client, 1009, "Frame too large");
            cleanup(connection, true);
            return;
          }
          if (connection.upstream.readyState === WebSocket.OPEN) {
            if ((connection.upstream.bufferedAmount ?? 0) + frameBytes > maxPendingBytes) {
              closeClient(connection.client, 1009, "Outbound data limit exceeded");
              cleanup(connection, true);
              return;
            }
            try {
              connection.upstream.send(frame);
            } catch (err: unknown) {
              console.warn("[t3-proxy] upstream send failed", {
                errorKind: err instanceof Error ? err.name : typeof err,
              });
              closeClient(connection.client);
              cleanup(connection, true);
            }
            return;
          }
          if (connection.pendingBytes + frameBytes > maxPendingBytes) {
            closeClient(connection.client, 1009, "Pending data limit exceeded");
            cleanup(connection, true);
            return;
          }
          connection.pending.push(frame);
          connection.pendingBytes += frameBytes;
        },
        onClose() {
          if (connection) cleanup(connection, true);
        },
        onError() {
          if (connection) cleanup(connection, true);
        },
      };
    },
    close() {
      for (const connection of [...active]) {
        closeClient(connection.client, 1012, "Gateway restarting");
        cleanup(connection, true);
      }
    },
    activeConnectionsForTest() {
      return active.size;
    },
  };
}
