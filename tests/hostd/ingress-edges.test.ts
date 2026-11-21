import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from "node:https";
import { connect as netConnect, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createIngress, MAX_INDEXED_HANDLES, parseHandle, type Ingress, type IngressDeps } from "../../packages/hostd/src/ingress.js";
import type { VmRecord } from "../../packages/hostd/src/vm-store.js";

// Edge paths of the host ingress: index rebuild races, upgrade relays,
// stream failures, and the defensive backstops behind Node's own parser.

const TOKEN = "host-auth-token-0123456789abcdef";
let certDir: string;
let tls: { cert: string; key: string };

beforeAll(async () => {
  certDir = await mkdtemp(join(tmpdir(), "hostd-ingress-edge-cert-"));
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=vm.local", "-days", "1",
      "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem")],
    { stdio: "ignore" },
  );
  tls = { cert: await readFile(join(certDir, "cert.pem"), "utf8"), key: await readFile(join(certDir, "key.pem"), "utf8") };
});

afterAll(async () => {
  await rm(certDir, { recursive: true, force: true });
});

function record(overrides: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm_0123456789abcdef01234567",
    machineId: "machine-1",
    generation: 1,
    handle: "alice",
    tier: "free",
    state: "running",
    privateIPv4: "127.0.0.1",
    mac: "52:54:00:78:00:0a",
    bootMiB: 2048,
    maxMiB: 8192,
    diskGiB: 20,
    chVersion: "v54.1",
    snapshot: null,
    updatedAt: "2026-11-21T00:00:00.000Z",
    ...overrides,
  };
}

let records: VmRecord[];
let listener: ((id: string) => void) | null;
let listHook: (() => Promise<void> | void) | null;
const store: IngressDeps["store"] = {
  async list() {
    if (listHook) await listHook();
    return records;
  },
  onChange(cb) {
    listener = cb;
    return () => {
      listener = null;
    };
  },
};

let ingress: Ingress | undefined;
let ingressPort: number;
let logs: Array<{ event: string; fields: Record<string, unknown> }>;
const servers: Array<NetServer | HttpsServer> = [];

async function listen(server: NetServer | HttpsServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

async function start(options: Partial<IngressDeps> = {}): Promise<Ingress> {
  ingress = createIngress({ store, hostAuthToken: TOKEN, tls, log: (event, fields) => logs.push({ event, fields }), ...options });
  ingressPort = await new Promise<number>((resolve) =>
    ingress!.server.listen(0, "127.0.0.1", () => resolve((ingress!.server.address() as AddressInfo).port)),
  );
  return ingress;
}

beforeEach(() => {
  records = [record()];
  listener = null;
  listHook = null;
  logs = [];
});

afterEach(async () => {
  if (ingress) await ingress.close();
  ingress = undefined;
  for (const server of servers.splice(0)) {
    (server as HttpsServer).closeAllConnections?.();
    await new Promise((r) => server.close(() => r(undefined)));
  }
  vi.restoreAllMocks();
});

const authed = (host = "alice.matrix-os.com", extra: Record<string, string> = {}) => ({ host, "x-matrix-host-auth": TOKEN, ...extra });

function send(headers: Record<string, string>, path = "/"): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: "127.0.0.1", port: ingressPort, path, headers, rejectUnauthorized: false, agent: false },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        res.on("error", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function rawTlsSocket(): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: "127.0.0.1", port: ingressPort, rejectUnauthorized: false }, () => resolve(socket));
    socket.once("error", reject);
  });
}

async function rawTls(payload: string): Promise<string> {
  const socket = await rawTlsSocket();
  return new Promise((resolve) => {
    let text = "";
    socket.on("data", (c: Buffer) => (text += c.toString()));
    socket.on("error", () => resolve(text));
    socket.on("close", () => resolve(text));
    socket.write(payload);
  });
}

const upgradeRequest = (host = "alice.matrix-os.com", extra = "") =>
  `GET /ws HTTP/1.1\r\nhost: ${host}\r\nx-matrix-host-auth: ${TOKEN}\r\nconnection: Upgrade\r\nupgrade: websocket\r\n` +
  `sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`;

const has = (event: string) => logs.some((l) => l.event === event);

describe("host ingress edges", () => {
  it("parses no handle from a missing host and refuses a short token", () => {
    expect(parseHandle(undefined)).toBeNull();
    expect(() => createIngress({ store, hostAuthToken: "short", tls })).toThrow();
  });

  it("drops headers named in Connection and keeps the rest", async () => {
    const seen: IncomingMessage[] = [];
    const vm = createHttpsServer(tls, (req, res) => {
      seen.push(req);
      res.end("ok");
    });
    await start({ upstreamPort: await listen(vm) });
    expect((await send(authed("alice.matrix-os.com", { connection: "keep-alive, x-drop", "x-drop": "1", "x-keep": "1" }))).status).toBe(200);
    expect(seen[0]!.headers["x-drop"]).toBeUndefined();
    expect(seen[0]!.headers["x-keep"]).toBe("1");
  });

  it("answers runtime_unavailable while the first index cannot be built", async () => {
    listHook = () => {
      throw new Error("EIO");
    };
    await start();
    const first = await send(authed());
    expect(first.status).toBe(503);
    expect(JSON.parse(first.body)).toEqual({ error: "runtime_unavailable" });
    expect(has("ingress.index_rebuild_failed")).toBe(true);
  });

  it("caps the index and skips duplicate handles", async () => {
    records = Array.from({ length: MAX_INDEXED_HANDLES + 2 }, (_, i) =>
      record({ id: `vm_${i.toString(16).padStart(24, "0")}`, handle: i === 1 ? "h0" : `h${i}` }),
    );
    await start();
    expect((await send(authed(`h${MAX_INDEXED_HANDLES + 1}.matrix-os.com`))).status).toBe(404);
    expect(has("ingress.index_capped")).toBe(true);
    expect(has("ingress.duplicate_handle")).toBe(true);
  });

  it("shares one rebuild between concurrent lookups and rebuilds again after a change lands mid-rebuild", async () => {
    let lists = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    listHook = async () => {
      lists += 1;
      if (lists === 1) {
        await gate;
        listener?.("vm_x");
      }
    };
    await start({ upstreamPort: 1 });
    const a = send(authed("nobody.matrix-os.com"));
    const b = send(authed("nobody.matrix-os.com"));
    await expect.poll(() => lists).toBe(1);
    release();
    await Promise.all([a, b]);
    expect(lists).toBe(2);
  });

  it("counts concurrent upstream connections per VM and releases each", async () => {
    const holds: Array<() => void> = [];
    const vm = createHttpsServer(tls, (_req, res) => holds.push(() => res.end("ok")));
    await start({ upstreamPort: await listen(vm), maxUpstreamPerVm: 2 });
    const a = send(authed());
    const b = send(authed());
    await expect.poll(() => holds.length).toBe(2);
    expect((await send(authed())).status).toBe(503);
    holds[0]!();
    expect((await a).status).toBe(200);
    holds[1]!();
    expect((await b).status).toBe(200);
  });

  it("destroys a response whose upstream fails after the headers were sent", async () => {
    const vm = createHttpsServer(tls, (req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      setTimeout(() => req.socket.destroy(), 20);
    });
    await start({ upstreamPort: await listen(vm) });
    const reply = await send(authed()).catch((error: unknown) => error);
    expect(reply).toBeTruthy();
    await expect.poll(() => has("ingress.upstream_failed") || has("ingress.response_stream_failed")).toBe(true);
  });

  it("times out an idle upstream", async () => {
    const vm = createHttpsServer(tls, () => undefined);
    // Fire the upstream request's own timeout event, independent of the client socket's.
    const upstreamRequest = ((...args: Parameters<typeof httpsRequest>) => {
      const req = httpsRequest(...args);
      setTimeout(() => req.emit("timeout"), 50);
      return req;
    }) as typeof httpsRequest;
    await start({ upstreamPort: await listen(vm), upstreamRequest });
    expect((await send(authed())).status).toBe(502);
    await expect.poll(() => has("ingress.upstream_failed")).toBe(true);
    expect(logs.find((l) => l.event === "ingress.upstream_failed")!.fields.code).toBe("ETIMEDOUT");
  });

  it("aborts the upstream when the client goes away mid-request and frees the slot", async () => {
    let upstreamClosed = false;
    const vm = createHttpsServer(tls, (req) => req.socket.once("close", () => (upstreamClosed = true)));
    await start({ upstreamPort: await listen(vm), maxUpstreamPerVm: 1 });
    const client = await rawTlsSocket();
    client.write(`GET /slow HTTP/1.1\r\nhost: alice.matrix-os.com\r\nx-matrix-host-auth: ${TOKEN}\r\n\r\n`);
    await new Promise((r) => setTimeout(r, 100));
    client.destroy();
    await expect.poll(() => upstreamClosed).toBe(true);
  });

  it("answers upgrades with typed errors and HTTP reasons", async () => {
    const refused = createNetServer();
    const refusedPort = await listen(refused);
    refused.close();
    servers.splice(servers.indexOf(refused), 1);
    records = [record(), record({ id: "vm_bbbbbbbbbbbbbbbbbbbbbbbb", handle: "sleepy", state: "suspended" })];
    await start({ upstreamPort: refusedPort });
    expect(await rawTls(upgradeRequest("nobody.matrix-os.com"))).toMatch(/^HTTP\/1.1 404 Not Found/);
    expect(await rawTls(upgradeRequest("sleepy.matrix-os.com"))).toMatch(/^HTTP\/1.1 503 Service Unavailable[\s\S]*retry-after: 2/);
    expect(await rawTls(upgradeRequest())).toMatch(/^HTTP\/1.1 502 Bad Gateway/);
    expect(has("ingress.upstream_failed")).toBe(true);
  });

  it("refuses an upgrade beyond the per-VM cap, and when opening the upstream throws", async () => {
    const holds: Array<() => void> = [];
    const vm = createHttpsServer(tls, (_req, res) => holds.push(() => res.end("ok")));
    let calls = 0;
    const upstreamRequest = ((...args: Parameters<typeof httpsRequest>) => {
      calls += 1;
      if (calls === 2) throw "not an Error";
      return httpsRequest(...args);
    }) as typeof httpsRequest;
    await start({ upstreamPort: await listen(vm), maxUpstreamPerVm: 1, upstreamRequest });
    const held = send(authed());
    await expect.poll(() => holds.length).toBe(1);
    expect(await rawTls(upgradeRequest())).toMatch(/^HTTP\/1.1 503 Service Unavailable[\s\S]*runtime_busy/);
    holds[0]!();
    await held;
    expect(await rawTls(upgradeRequest())).toMatch(/^HTTP\/1.1 502 Bad Gateway/);
    expect(logs.find((l) => l.event === "ingress.upstream_open_failed")!.fields).toMatchObject({ error: "not an Error" });
  });

  it("relays a declined upgrade with its headers", async () => {
    const vm = createHttpsServer(tls);
    vm.on("upgrade", (_req, socket: Socket) => {
      socket.end("HTTP/1.1 403 Forbidden\r\nset-cookie: a=1\r\nset-cookie: b=2\r\ncontent-length: 2\r\n\r\nno");
    });
    await start({ upstreamPort: await listen(vm) });
    const raw = await rawTls(upgradeRequest());
    expect(raw).toMatch(/^HTTP\/1.1 403 Forbidden/);
    expect(raw).toContain("set-cookie: a=1\r\nset-cookie: b=2");
    expect(raw).toContain("connection: close");
    expect(raw.endsWith("no")).toBe(true);
  });

  it("forwards bytes sent with the upgrade in both directions and times out an idle upgraded socket", async () => {
    let fromClient = "";
    const vm = createHttpsServer(tls);
    vm.on("upgrade", (_req, socket: Socket, head: Buffer) => {
      fromClient += head.toString();
      socket.on("data", (c: Buffer) => (fromClient += c.toString()));
      socket.write("HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\nhello-from-vm");
    });
    await start({ upstreamPort: await listen(vm), idleTimeoutMs: 300 });
    const socket = await rawTlsSocket();
    let text = "";
    socket.on("data", (c: Buffer) => (text += c.toString()));
    const closed = new Promise((r) => socket.once("close", r));
    socket.write(`${upgradeRequest()}early-bytes`);
    await expect.poll(() => text).toContain("hello-from-vm");
    await expect.poll(() => fromClient).toContain("early-bytes");
    await closed;
  });

  it("destroys upgraded sockets when the ingress closes", async () => {
    const wss = new WebSocketServer({ noServer: true });
    const vm = createHttpsServer(tls);
    vm.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, () => undefined));
    await start({ upstreamPort: await listen(vm) });
    const ws = new WebSocket(`wss://127.0.0.1:${ingressPort}/ws`, { headers: authed(), rejectUnauthorized: false });
    await new Promise((r) => ws.once("open", r));
    const closed = new Promise((r) => ws.once("close", r));
    await ingress!.close();
    ingress = undefined;
    await closed;
    wss.close();
  });

  it("logs TLS client errors and uses the default logger when none is given", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    ingress = createIngress({ store, hostAuthToken: TOKEN, tls });
    ingressPort = await new Promise<number>((resolve) =>
      ingress!.server.listen(0, "127.0.0.1", () => resolve((ingress!.server.address() as AddressInfo).port)),
    );
    const socket = netConnect(ingressPort, "127.0.0.1");
    await new Promise((r) => socket.once("connect", r));
    socket.end("this is not a TLS client hello\r\n\r\n");
    await expect.poll(() => error.mock.calls.some((c) => String(c[0]).includes("ingress.tls_client_error"))).toBe(true);
  });
});

// Node's parser rejects ambiguous framing before the ingress sees it; these
// drive the handlers with synthetic requests to prove the backstops.
describe("host ingress backstops", () => {
  function fakeRequest(headers: Record<string, string>) {
    return Object.assign(new PassThrough(), { headers, method: "POST", url: "/", socket: { remoteAddress: "127.0.0.1" } });
  }

  function fakeResponse() {
    const res = { status: 0, body: "", headersSent: false, destroyed: false };
    return Object.assign(res, {
      writeHead(status: number) {
        res.status = status;
        res.headersSent = true;
      },
      end(body: string) {
        res.body = body;
      },
      destroy() {
        res.destroyed = true;
      },
    });
  }

  function fakeSocket() {
    let written = "";
    const socket = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
    Object.assign(socket, {
      end(text: string) {
        written += text;
        return socket;
      },
    });
    return { socket, written: () => written };
  }

  it("answers 400 to ambiguous framing on a request and on an upgrade", async () => {
    await start();
    const res = fakeResponse();
    ingress!.server.emit("request", fakeRequest({ ...authed(), "content-length": "5", "transfer-encoding": "chunked" }), res);
    await expect.poll(() => res.status).toBe(400);
    const { socket, written } = fakeSocket();
    ingress!.server.emit("upgrade", fakeRequest({ ...authed(), "content-length": "5", "transfer-encoding": "chunked" }), socket, Buffer.alloc(0));
    await expect.poll(() => written()).toMatch(/^HTTP\/1.1 400 Bad Request/);
    socket.emit("error", new Error("client reset"));
    expect(has("ingress.client_socket_failed")).toBe(true);
  });

  it("maps an unexpected handler failure to runtime_unavailable", async () => {
    await start();
    const throwing = Object.defineProperty(new PassThrough(), "headers", {
      get() {
        throw new Error("boom");
      },
    });
    const res = fakeResponse();
    ingress!.server.emit("request", throwing, res);
    await expect.poll(() => res.status).toBe(503);
    expect(has("ingress.request_failed")).toBe(true);
    const { socket, written } = fakeSocket();
    ingress!.server.emit("upgrade", throwing, socket, Buffer.alloc(0));
    await expect.poll(() => written()).toMatch(/^HTTP\/1.1 503 Service Unavailable/);
    expect(has("ingress.upgrade_failed")).toBe(true);
    // A client socket that is no longer writable is destroyed instead of answered.
    const gone = fakeSocket();
    Object.defineProperty(gone.socket, "writable", { value: false });
    ingress!.server.emit("upgrade", throwing, gone.socket, Buffer.alloc(0));
    await expect.poll(() => gone.socket.destroyed).toBe(true);
    // A response that already started is destroyed instead of rewritten.
    const started = fakeResponse();
    started.headersSent = true;
    ingress!.server.emit("request", throwing, started);
    await expect.poll(() => started.destroyed).toBe(true);
  });
});
