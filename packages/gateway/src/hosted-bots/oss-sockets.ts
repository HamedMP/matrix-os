import type { OutgoingHttpHeaders } from "node:http";
import type { WSContext, WSEvents } from "hono/ws";
import { WebSocket } from "ws";

const MAX_SOCKETS = 4;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const HANDSHAKE_MS = 5_000;
const MAX_IDLE_MS = 120_000;
const MAX_LIFETIME_MS = 10 * 60_000;

const BROWSER_VIEWER = /^\/api\/bots\/[\w-]+\/browser\/stream$/;
const DESKTOP_VIEWER = /^\/api\/desktop-viewer\/(?:local\/(?:shared|bot-[a-f0-9]{64}|pool-\d+)|vps\/[\w-]+)\/websockify$/;

export function openMausBotWebSocketPath(path: string | null): "browser" | "desktop" | null {
  if (!path) return null;
  const pathname = path.split("?")[0] ?? "";
  if (BROWSER_VIEWER.test(pathname)) return "browser";
  return DESKTOP_VIEWER.test(pathname) ? "desktop" : null;
}

interface Connection {
  upstream: WebSocket;
  client?: WSContext;
  createdAt: number;
  lastTouched: number;
  handshake?: NodeJS.Timeout;
}

export function createOpenMausBotSockets(socketPath: string) {
  const active = new Set<Connection>();
  let closing = false;

  function drop(connection: Connection) {
    if (!active.delete(connection)) return;
    clearTimeout(connection.handshake);
    connection.upstream.terminate();
    try { connection.client?.close(1001, "Viewer disconnected"); }
    catch (error) { console.warn("[hosted-bots] Viewer close failed", error instanceof Error ? error.name : "UnknownError"); }
  }

  function sweep() {
    const now = Date.now();
    for (const connection of active) {
      if (now - connection.lastTouched > MAX_IDLE_MS || now - connection.createdAt > MAX_LIFETIME_MS) drop(connection);
    }
  }

  const timer = setInterval(sweep, HANDSHAKE_MS);
  timer.unref();

  return {
    async connect(path: string, headers: OutgoingHttpHeaders, protocol: string | null, signal: AbortSignal): Promise<WSEvents | null> {
      sweep();
      const mode = openMausBotWebSocketPath(path);
      if (closing || !mode || !headers.cookie || signal.aborted || active.size >= MAX_SOCKETS) return null;
      if (protocol !== null && (mode !== "desktop" || protocol !== "binary")) return null;
      const upstream = new WebSocket("ws+unix://" + socketPath + ":" + path, protocol ? [protocol] : [], {
        headers, handshakeTimeout: HANDSHAKE_MS, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false,
      });
      const now = Date.now();
      const connection: Connection = { upstream, createdAt: now, lastTouched: now };
      active.add(connection);
      upstream.on("error", () => drop(connection));
      upstream.once("close", () => drop(connection));
      const ready = await new Promise<boolean>((resolve) => {
        function complete(open: boolean) {
          signal.removeEventListener("abort", abort);
          resolve(open);
        }
        function abort() { drop(connection); complete(false); }
        signal.addEventListener("abort", abort, { once: true });
        upstream.once("open", () => { upstream.pause(); complete(true); });
        upstream.once("error", () => complete(false));
        upstream.once("close", () => complete(false));
      });
      if (!ready || closing || !active.has(connection) || (protocol && upstream.protocol !== protocol)) {
        drop(connection);
        return null;
      }
      connection.handshake = setTimeout(() => drop(connection), HANDSHAKE_MS);
      connection.handshake.unref();
      upstream.on("message", (data, binary) => {
        connection.lastTouched = Date.now();
        const raw = connection.client?.raw as WebSocket | undefined;
        const frame = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        if (!connection.client || frame.byteLength > MAX_FRAME_BYTES || (raw?.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) {
          drop(connection);
          return;
        }
        try { connection.client.send(binary ? new Uint8Array(frame) : frame.toString("utf8")); }
        catch (error) {
          console.warn("[hosted-bots] Viewer downstream send failed", error instanceof Error ? error.name : "UnknownError");
          drop(connection);
        }
      });
      return {
        onOpen(_event, client) {
          clearTimeout(connection.handshake);
          if (!active.has(connection) || closing) {
            client.close(1001, "Viewer disconnected");
            return;
          }
          connection.client = client;
          connection.lastTouched = Date.now();
          upstream.resume();
        },
        onMessage(event) {
          const data = event.data;
          const bytes = typeof data === "string" ? Buffer.byteLength(data) : data instanceof ArrayBuffer
            ? data.byteLength : ArrayBuffer.isView(data) ? data.byteLength : Infinity;
          if (bytes > MAX_FRAME_BYTES || upstream.bufferedAmount > MAX_BUFFERED_BYTES || upstream.readyState !== WebSocket.OPEN) {
            drop(connection);
            return;
          }
          connection.lastTouched = Date.now();
          if (typeof data === "string" || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
            upstream.send(data, (error) => { if (error) drop(connection); });
          }
        },
        onClose() { drop(connection); },
        onError() { drop(connection); },
      };
    },
    close() {
      closing = true;
      clearInterval(timer);
      for (const connection of active) drop(connection);
    },
  };
}
