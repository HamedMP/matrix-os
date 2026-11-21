import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { Agent, createServer, request as httpsRequest, type Server } from "node:https";
import { isIPv4, type Socket } from "node:net";
import { pipeline } from "node:stream";
import type { TLSSocket } from "node:tls";
import type { VmState, VmStore } from "./vm-store.js";

// Host ingress: the public HTTPS front door of a metal host. The platform
// proxies owner traffic here with `host: <handle>.matrix-os.com` and the
// per-host `x-matrix-host-auth` secret; the ingress forwards it, unchanged
// apart from that secret and hop-by-hop headers, to the VM's own nginx on the
// private bridge. It never wakes a VM: waking is the platform's job via hostd.

export const HOST_AUTH_HEADER = "x-matrix-host-auth";
export const MAX_INDEXED_HANDLES = 10_000;
export const INDEX_MAX_AGE_MS = 2_000;
export const UPSTREAM_CONNECT_TIMEOUT_MS = 5_000;
export const IDLE_SOCKET_TIMEOUT_MS = 15 * 60_000;
export const MAX_UPSTREAM_PER_VM = 256;

const HANDLE_HOST = /^([a-z0-9][a-z0-9-]{0,62})\.matrix-os\.com(?::443)?$/i;
const ASLEEP: ReadonlySet<VmState> = new Set<VmState>(["suspended", "suspending", "resuming", "stopped"]);
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type IngressErrorCode =
  | "bad_request"
  | "unauthorized"
  | "runtime_unknown"
  | "runtime_asleep"
  | "runtime_unavailable"
  | "runtime_busy"
  | "runtime_unreachable";

const STATUS: Record<IngressErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  runtime_unknown: 404,
  runtime_asleep: 503,
  runtime_unavailable: 503,
  runtime_busy: 503,
  runtime_unreachable: 502,
};

export interface IngressDeps {
  store: Pick<VmStore, "list" | "onChange">;
  hostAuthToken: string;
  tls: { cert: string | Buffer; key: string | Buffer };
  // The VM nginx port; 443 in production, overridable for tests.
  upstreamPort?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxUpstreamPerVm?: number;
  // Seam for tests; defaults to node:https request.
  upstreamRequest?: typeof httpsRequest;
  log?: (event: string, fields: Record<string, unknown>) => void;
  now?: () => number;
}

export interface Ingress {
  server: Server;
  close(): Promise<void>;
}

interface IndexEntry {
  id: string;
  state: VmState;
  privateIPv4: string;
}

type Route = { ok: true; entry: IndexEntry } | { ok: false; code: IngressErrorCode };

const errorFields = (error: unknown) =>
  error instanceof Error
    ? { error: error.name, message: error.message, code: (error as { code?: unknown }).code }
    : { error: String(error) };

const digest = (value: string) => createHash("sha256").update(value).digest();

export function parseHandle(host: string | undefined): string | null {
  if (typeof host !== "string") return null;
  const match = HANDLE_HOST.exec(host);
  return match ? match[1]!.toLowerCase() : null;
}

function forwardedHeaders(req: IncomingMessage, upgrade: boolean): OutgoingHttpHeaders {
  const listed = new Set(
    String(req.headers.connection ?? "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers as IncomingHttpHeaders)) {
    if (value === undefined || name === HOST_AUTH_HEADER || HOP_BY_HOP.has(name) || listed.has(name)) continue;
    out[name] = value;
  }
  const client = req.socket.remoteAddress ?? "";
  const prior = req.headers["x-forwarded-for"];
  const priorText = Array.isArray(prior) ? prior.join(", ") : prior;
  out["x-forwarded-for"] = priorText ? `${priorText}, ${client}` : client;
  out["x-forwarded-proto"] = "https";
  // Request framing is re-established on the upstream hop, never left to
  // Node's per-method defaults: for GET/DELETE/OPTIONS/HEAD Node would write a
  // body raw with no length on a keep-alive socket, letting a client smuggle a
  // second request (with forged platform headers) into the VM's nginx. A
  // chunked incoming body is therefore always forwarded chunked. Bodies on
  // these methods stay allowed (DELETE with a body is legitimate).
  if (req.headers["transfer-encoding"] !== undefined) {
    out["transfer-encoding"] = "chunked";
    delete out["content-length"];
  }
  if (upgrade) {
    out.connection = "Upgrade";
    out.upgrade = req.headers.upgrade ?? "websocket";
  }
  return out;
}

// Ambiguous framing (both content-length and transfer-encoding) is rejected
// outright rather than resolved, so the ingress and the VM can never disagree
// on where a request ends. Node's parser also rejects it; this is the backstop.
export function hasAmbiguousFraming(req: IncomingMessage): boolean {
  return req.headers["transfer-encoding"] !== undefined && req.headers["content-length"] !== undefined;
}

function stripHopByHop(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    out[name] = value;
  }
  return out;
}

function errorBody(code: IngressErrorCode): string {
  return JSON.stringify({ error: code });
}

function errorHeaders(code: IngressErrorCode, body: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(body)),
  };
  if (code === "runtime_asleep") headers["retry-after"] = "2";
  return headers;
}

function sendError(res: ServerResponse, code: IngressErrorCode): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = errorBody(code);
  res.writeHead(STATUS[code], errorHeaders(code, body));
  res.end(body);
}

function writeSocketError(socket: Socket, code: IngressErrorCode): void {
  const body = errorBody(code);
  const lines = Object.entries({ ...errorHeaders(code, body), connection: "close" }).map(([k, v]) => `${k}: ${v}`);
  const reason = code === "bad_request" ? "Bad Request" : code === "unauthorized" ? "Unauthorized" : code === "runtime_unknown" ? "Not Found" : code === "runtime_unreachable" ? "Bad Gateway" : "Service Unavailable";
  if (socket.writable) socket.end(`HTTP/1.1 ${STATUS[code]} ${reason}\r\n${lines.join("\r\n")}\r\n\r\n${body}`);
  else socket.destroy();
}

export function createIngress(deps: IngressDeps): Ingress {
  const log = deps.log ?? ((event, fields) => console.error(JSON.stringify({ event, ...fields })));
  const now = deps.now ?? Date.now;
  const upstreamPort = deps.upstreamPort ?? 443;
  const connectTimeoutMs = deps.connectTimeoutMs ?? UPSTREAM_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = deps.idleTimeoutMs ?? IDLE_SOCKET_TIMEOUT_MS;
  const maxPerVm = deps.maxUpstreamPerVm ?? MAX_UPSTREAM_PER_VM;
  const upstreamRequest = deps.upstreamRequest ?? httpsRequest;
  if (deps.hostAuthToken.length < 16) throw new Error("host auth token too short");
  const tokenDigest = digest(deps.hostAuthToken);

  // Handle -> VM index, rebuilt from the store on a change notification and
  // at most every INDEX_MAX_AGE_MS otherwise; requests never read disk.
  let index: Map<string, IndexEntry> | null = null;
  let builtAt = 0;
  let dirty = true;
  let building: Promise<void> | null = null;

  async function rebuild(): Promise<void> {
    dirty = false;
    const next = new Map<string, IndexEntry>();
    try {
      const records = await deps.store.list();
      for (const record of records) {
        if (next.size >= MAX_INDEXED_HANDLES) {
          log("ingress.index_capped", { cap: MAX_INDEXED_HANDLES, records: records.length });
          break;
        }
        const handle = record.handle.toLowerCase();
        if (next.has(handle)) {
          log("ingress.duplicate_handle", { id: record.id });
          continue;
        }
        next.set(handle, { id: record.id, state: record.state, privateIPv4: record.privateIPv4 });
      }
      index = next;
      builtAt = now();
    } catch (error: unknown) {
      // Keep serving from the previous index; retry on the next request.
      dirty = true;
      log("ingress.index_rebuild_failed", errorFields(error));
    }
  }

  function refresh(): Promise<void> {
    if (!building) {
      building = rebuild().finally(() => {
        building = null;
        // A change that landed mid-rebuild is picked up by the next request.
      });
    }
    return building;
  }

  const unsubscribe = deps.store.onChange(() => {
    dirty = true;
  });

  async function lookup(handle: string): Promise<IndexEntry | null | undefined> {
    if (dirty || index === null || now() - builtAt >= INDEX_MAX_AGE_MS) await refresh();
    if (dirty && building === null) await refresh();
    if (index === null) return undefined;
    return index.get(handle) ?? null;
  }

  function authorized(headers: IncomingHttpHeaders): boolean {
    const value = headers[HOST_AUTH_HEADER];
    if (typeof value !== "string" || value.length === 0) return false;
    return timingSafeEqual(digest(value), tokenDigest);
  }

  // Active upstream connections per VM; entries exist only while non-zero, and
  // the map is capped at the index size.
  const active = new Map<string, number>();
  function acquire(id: string): boolean {
    const count = active.get(id) ?? 0;
    if (count >= maxPerVm) return false;
    if (count === 0 && active.size >= MAX_INDEXED_HANDLES) return false;
    active.set(id, count + 1);
    return true;
  }
  function releaser(id: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (active.get(id) ?? 1) - 1;
      if (count <= 0) active.delete(id);
      else active.set(id, count);
    };
  }

  async function route(req: IncomingMessage): Promise<Route> {
    if (!authorized(req.headers)) return { ok: false, code: "unauthorized" };
    const handle = parseHandle(req.headers.host);
    if (handle === null) return { ok: false, code: "runtime_unknown" };
    const entry = await lookup(handle);
    if (entry === undefined) return { ok: false, code: "runtime_unavailable" };
    if (entry === null) return { ok: false, code: "runtime_unknown" };
    if (ASLEEP.has(entry.state)) return { ok: false, code: "runtime_asleep" };
    if (entry.state !== "running" || !isIPv4(entry.privateIPv4)) return { ok: false, code: "runtime_unavailable" };
    return { ok: true, entry };
  }

  const upgraded = new Set<Socket>();
  const agent = new Agent({ keepAlive: true, maxSockets: maxPerVm, maxFreeSockets: 16, rejectUnauthorized: false });
  const handshaken = new WeakSet<Socket>();

  // Opens the upstream request with a connect (TCP + TLS) timeout. Reused
  // keep-alive sockets have already completed their handshake.
  function openUpstream(req: IncomingMessage, entry: IndexEntry, upgrade: boolean) {
    const upstream = upstreamRequest({
      host: entry.privateIPv4,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: forwardedHeaders(req, upgrade),
      agent,
      // The VM's nginx uses a self-signed certificate on the private bridge.
      rejectUnauthorized: false,
    });
    upstream.on("socket", (socket: Socket) => {
      socket.setTimeout(idleTimeoutMs);
      if (handshaken.has(socket)) return;
      const timer = setTimeout(() => {
        upstream.destroy(Object.assign(new Error("upstream connect timeout"), { code: "ETIMEDOUT" }));
      }, connectTimeoutMs);
      const done = () => clearTimeout(timer);
      (socket as TLSSocket).once("secureConnect", () => {
        handshaken.add(socket);
        done();
      });
      socket.once("close", done);
      socket.once("error", done);
    });
    upstream.on("timeout", () => upstream.destroy(Object.assign(new Error("upstream idle timeout"), { code: "ETIMEDOUT" })));
    return upstream;
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const result: Route = hasAmbiguousFraming(req) ? { ok: false, code: "bad_request" } : await route(req);
    if (!result.ok) {
      req.resume();
      sendError(res, result.code);
      return;
    }
    // The client may have gone away while the lookup was awaited: never take a
    // slot or open an upstream for it.
    if (req.destroyed || res.closed) return;
    const { entry } = result;
    if (!acquire(entry.id)) {
      req.resume();
      sendError(res, "runtime_busy");
      return;
    }
    // From here every path releases: the close listener is attached before
    // anything that can throw.
    const release = releaser(entry.id);
    res.once("close", release);
    let upstream: ReturnType<typeof openUpstream>;
    try {
      upstream = openUpstream(req, entry, false);
    } catch (error: unknown) {
      log("ingress.upstream_open_failed", { id: entry.id, ...errorFields(error) });
      release();
      req.resume();
      sendError(res, "runtime_unreachable");
      return;
    }
    res.once("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.once("response", (up) => {
      res.writeHead(up.statusCode ?? 502, up.statusMessage, stripHopByHop(up.headers));
      pipeline(up, res, (error) => {
        if (error) log("ingress.response_stream_failed", { id: entry.id, ...errorFields(error) });
      });
    });
    upstream.once("error", (error) => {
      log("ingress.upstream_failed", { id: entry.id, ...errorFields(error) });
      sendError(res, "runtime_unreachable");
      release();
    });
    pipeline(req, upstream, (error) => {
      if (error) log("ingress.request_stream_failed", { id: entry.id, ...errorFields(error) });
    });
  }

  async function onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    socket.on("error", (error) => log("ingress.client_socket_failed", errorFields(error)));
    const result: Route = hasAmbiguousFraming(req) ? { ok: false, code: "bad_request" } : await route(req);
    if (!result.ok) {
      writeSocketError(socket, result.code);
      return;
    }
    // The client may have disconnected during the lookup: its close event has
    // already fired, so a slot taken now would never be released.
    if (socket.destroyed) return;
    const { entry } = result;
    if (!acquire(entry.id)) {
      writeSocketError(socket, "runtime_busy");
      return;
    }
    const release = releaser(entry.id);
    // Upgraded sockets leave the server's connection list; track them so
    // close() can drain them. Bounded by the per-VM connection cap.
    upgraded.add(socket);
    socket.once("close", () => {
      upgraded.delete(socket);
      release();
    });
    socket.setTimeout(idleTimeoutMs, () => socket.destroy());
    let upstream: ReturnType<typeof openUpstream>;
    try {
      upstream = openUpstream(req, entry, true);
    } catch (error: unknown) {
      log("ingress.upstream_open_failed", { id: entry.id, upgrade: true, ...errorFields(error) });
      release();
      writeSocketError(socket, "runtime_unreachable");
      return;
    }
    socket.once("close", () => upstream.destroy());
    upstream.once("upgrade", (up, upSocket: Socket, upHead: Buffer) => {
      const lines = [`HTTP/1.1 ${up.statusCode ?? 101} ${up.statusMessage ?? "Switching Protocols"}`];
      for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upHead.length > 0) socket.write(upHead);
      if (head.length > 0) upSocket.write(head);
      upSocket.setTimeout(idleTimeoutMs, () => upSocket.destroy());
      upSocket.on("error", (error) => log("ingress.upstream_socket_failed", { id: entry.id, ...errorFields(error) }));
      upSocket.once("close", () => socket.destroy());
      socket.once("close", () => upSocket.destroy());
      upSocket.pipe(socket);
      socket.pipe(upSocket);
    });
    upstream.once("response", (up) => {
      // The VM declined the upgrade (for example its own auth check): relay it.
      const lines = [`HTTP/1.1 ${up.statusCode ?? 502} ${up.statusMessage ?? ""}`];
      for (const [name, value] of Object.entries(stripHopByHop(up.headers))) {
        for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
      }
      lines.push("connection: close");
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      up.pipe(socket);
    });
    upstream.once("error", (error) => {
      log("ingress.upstream_failed", { id: entry.id, upgrade: true, ...errorFields(error) });
      writeSocketError(socket, "runtime_unreachable");
      release();
    });
    upstream.end();
  }

  const server = createServer({
    cert: deps.tls.cert,
    key: deps.tls.key,
    minVersion: "TLSv1.2",
    // No total request timeout: uploads and streamed responses are long-lived.
    requestTimeout: 0,
  });
  server.setTimeout(idleTimeoutMs);
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    onRequest(req, res).catch((error: unknown) => {
      log("ingress.request_failed", errorFields(error));
      sendError(res, "runtime_unavailable");
    });
  });
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    onUpgrade(req, socket, head).catch((error: unknown) => {
      log("ingress.upgrade_failed", errorFields(error));
      writeSocketError(socket, "runtime_unavailable");
    });
  });
  server.on("tlsClientError", (error) => log("ingress.tls_client_error", errorFields(error)));

  return {
    server,
    async close() {
      unsubscribe();
      agent.destroy();
      server.closeAllConnections();
      for (const socket of upgraded) socket.destroy();
      upgraded.clear();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
