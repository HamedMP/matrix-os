import { WebSocket } from "ws";
import type { WSContext, WSEvents } from "hono/ws";

const MAX_CONNECTIONS = 4;
const MAX_FRAME = 8 * 1024 * 1024;
const MAX_BUFFERED = 16 * 1024 * 1024;
const IDLE_MS = 120_000;
interface Entry { upstream: WebSocket; client?: WSContext; expiresAt: number; lastTouched: number; onDrop?: () => void; }

/** Full desktop RFB byte stream; never interpret or record user inputs or pixels. */
export function createViewerSockets(authorization?: string) {
  const entries = new Set<Entry>();
  let closed = false;
  const drop = (entry: Entry, code = 1001) => {
    if (!entries.delete(entry)) return;
    entry.upstream.terminate();
    try { entry.client?.close(code, "Viewer disconnected"); }
    catch (error) { console.warn("[browser-lab] Viewer close failed", error instanceof Error ? error.name : "unknown"); }
    try { entry.onDrop?.(); }
    catch (error) { console.warn("[browser-lab] Viewer release failed", error instanceof Error ? error.name : "unknown"); }
  };
  const sweep = () => {
    const now = Date.now();
    for (const entry of entries) {
      if (now >= entry.expiresAt || now - entry.lastTouched > IDLE_MS) drop(entry);
    }
  };
  const timer = setInterval(sweep, 5_000);
  timer.unref();

  return {
    async connect(expiresAt: number, onDrop?: () => void): Promise<WSEvents | null> {
      sweep();
      if (!authorization?.startsWith("Basic ") || closed || entries.size >= MAX_CONNECTIONS || expiresAt <= Date.now()) return null;
      const upstream = new WebSocket("ws://127.0.0.1:6901/websockify", ["binary"], {
        origin: "http://127.0.0.1:6901",
        headers: { Authorization: authorization }, maxPayload: MAX_FRAME, handshakeTimeout: 5_000, perMessageDeflate: false,
      });
      const entry: Entry = { upstream, expiresAt, lastTouched: Date.now(), onDrop };
      entries.add(entry);
      // A byte stream cannot be dropped/reordered: pause it until client upgrade.
      upstream.on("open", () => upstream.pause());
      const ready = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 5_000);
        const done = (ok: boolean) => { clearTimeout(timeout); resolve(ok); };
        upstream.once("open", () => done(true));
        upstream.once("error", () => done(false));
        upstream.once("close", () => done(false));
      });
      if (!ready || closed || !entries.has(entry) || Date.now() >= expiresAt) { drop(entry); return null; }
      const upgradeDeadline = setTimeout(() => drop(entry), 5_000);
      upstream.on("error", () => drop(entry));
      upstream.on("close", () => {
        clearTimeout(upgradeDeadline);
        drop(entry);
      });
      upstream.on("message", (data, isBinary) => {
        entry.lastTouched = Date.now();
        const frame = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        const raw = entry.client?.raw as WebSocket | undefined;
        if (!entry.client || !isBinary || Date.now() >= expiresAt || frame.length > MAX_FRAME || (raw?.bufferedAmount ?? 0) > MAX_BUFFERED) { drop(entry, 1009); return; }
        try { entry.client.send(new Uint8Array(frame)); }
        catch (error) { console.warn("[browser-lab] Viewer send failed", error instanceof Error ? error.name : "unknown"); drop(entry); }
      });
      return {
        onOpen(_event, client) {
          clearTimeout(upgradeDeadline);
          if (!authorization?.startsWith("Basic ") || closed || !entries.has(entry) || Date.now() >= expiresAt) { client.close(1001, "Viewer disconnected"); drop(entry); return; }
          entry.client = client;
          entry.lastTouched = Date.now();
          upstream.resume();
        },
        onMessage(event) {
          entry.lastTouched = Date.now();
          const data = event.data;
          const length = typeof data === "string" ? Buffer.byteLength(data) : data instanceof ArrayBuffer ? data.byteLength : ArrayBuffer.isView(data) ? data.byteLength : Infinity;
          if (typeof data === "string" || length > MAX_FRAME || upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > MAX_BUFFERED || Date.now() >= expiresAt) { drop(entry, 1009); return; }
          upstream.send(data as ArrayBuffer);
        },
        onClose() { drop(entry); },
        onError() { drop(entry); },
      };
    },
    closeConnections() { for (const entry of entries) drop(entry); },
    close() {
      closed = true;
      clearInterval(timer);
      for (const entry of entries) drop(entry);
    },
  };
}
