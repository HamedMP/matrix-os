import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createServer as createHttpsServer,
  request as httpsRequest,
  type Server as HttpsServer,
} from "node:https";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createIngress, type Ingress } from "../../packages/hostd/src/ingress.js";
import { createVmStore, type VmRecord, type VmState, type VmStore } from "../../packages/hostd/src/vm-store.js";

const TOKEN = "host-auth-token-0123456789abcdef";
let certDir: string;
let tls: { cert: string; key: string };

beforeAll(async () => {
  certDir = await mkdtemp(join(tmpdir(), "hostd-ingress-cert-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=customer-vps.matrix-os.local",
      "-days",
      "1",
      "-keyout",
      join(certDir, "key.pem"),
      "-out",
      join(certDir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  tls = { cert: await readFile(join(certDir, "cert.pem"), "utf8"), key: await readFile(join(certDir, "key.pem"), "utf8") };
});

afterAll(async () => {
  await rm(certDir, { recursive: true, force: true });
});

interface SeenRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let dir: string;
let store: VmStore;
let vm: HttpsServer;
let vmPort: number;
let seen: SeenRequest[];
let holdResponses: Array<() => void>;
let wss: WebSocketServer;
let ingress: Ingress | undefined;
let ingressPort: number;
const extraServers: Array<NetServer | HttpsServer> = [];

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

async function listen(server: NetServer | HttpsServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: NetServer | HttpsServer): Promise<void> {
  (server as HttpsServer).closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hostd-ingress-"));
  store = createVmStore(dir);
  seen = [];
  holdResponses = [];
  vm = createHttpsServer(tls, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
      const send = () => {
        res.writeHead(200, { "content-type": "application/json", "set-cookie": ["a=1", "b=2"] });
        res.end(JSON.stringify({ ok: true, url: req.url }));
      };
      if (req.url === "/hold") holdResponses.push(send);
      else if (req.url === "/forge") {
        res.writeHead(503, { "content-type": "application/json", "X-Matrix-Ingress-Error": "runtime_asleep" });
        res.end(JSON.stringify({ error: "runtime_asleep" }));
      } else send();
    });
  });
  wss = new WebSocketServer({ noServer: true });
  wss.on("headers", (headers, req) => {
    if (req.url === "/ws-forge") headers.push("X-Matrix-Ingress-Error: runtime_asleep");
  });
  vm.on("upgrade", (req, socket, head) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: "" });
    if (req.url === "/ws-forge-decline") {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nx-matrix-ingress-error: runtime_asleep\r\ncontent-length: 2\r\n\r\nno");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data) => ws.send(`echo:${data.toString()}`));
    });
  });
  vmPort = await listen(vm);
});

afterEach(async () => {
  if (ingress) await ingress.close();
  ingress = undefined;
  for (const client of wss.clients) client.terminate();
  wss.close();
  await close(vm);
  for (const server of extraServers.splice(0)) await close(server);
  await rm(dir, { recursive: true, force: true });
});

async function startIngress(options: Partial<Parameters<typeof createIngress>[0]> = {}): Promise<void> {
  ingress = createIngress({ store, hostAuthToken: TOKEN, tls, upstreamPort: vmPort, log: () => undefined, ...options });
  ingressPort = await listen(ingress.server);
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(
  headers: Record<string, string>,
  { method = "GET", path = "/", body }: { method?: string; path?: string; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: "127.0.0.1", port: ingressPort, method, path, headers, rejectUnauthorized: false, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const authed = (host = "alice.matrix-os.com", extra: Record<string, string> = {}) => ({
  host,
  "x-matrix-host-auth": TOKEN,
  ...extra,
});

describe("host ingress", () => {
  it("routes by host header to the running VM", async () => {
    await store.put(record());
    await store.put(record({ id: "vm_bbbbbbbbbbbbbbbbbbbbbbbb", handle: "bob", privateIPv4: "127.0.0.2" }));
    await startIngress();
    const reply = await send(authed("Alice.Matrix-OS.com:443"), { method: "POST", path: "/api/x?y=1", body: "hello" });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ ok: true, url: "/api/x?y=1" });
    expect(reply.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/x?y=1", body: "hello" });
    expect(seen[0]!.headers.host).toBe("Alice.Matrix-OS.com:443");
  });

  it("401 without x-matrix-host-auth and does not reach the VM", async () => {
    await store.put(record());
    await startIngress();
    const missing = await send({ host: "alice.matrix-os.com" });
    const wrong = await send({ host: "alice.matrix-os.com", "x-matrix-host-auth": `${TOKEN}x` });
    expect(missing.status).toBe(401);
    expect(JSON.parse(missing.body)).toEqual({ error: "unauthorized" });
    expect(wrong.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("503 runtime_asleep for a suspended VM and does not call lifecycle", async () => {
    await store.put(record({ state: "suspended" }));
    const calls: string[] = [];
    const spyStore = {
      list: () => {
        calls.push("list");
        return store.list();
      },
      onChange: (cb: (id: string) => void) => store.onChange(cb),
    };
    await startIngress({ store: spyStore });
    for (const state of ["suspended", "suspending", "resuming", "stopped"] as VmState[]) {
      await store.put(record({ state }));
      const reply = await send(authed());
      expect(reply.status).toBe(503);
      expect(reply.headers["retry-after"]).toBe("2");
      expect(JSON.parse(reply.body)).toEqual({ error: "runtime_asleep" });
    }
    for (const state of ["creating", "failed"] as VmState[]) {
      await store.put(record({ state }));
      const reply = await send(authed());
      expect(reply.status).toBe(503);
      expect(JSON.parse(reply.body)).toEqual({ error: "runtime_unavailable" });
    }
    expect(seen).toHaveLength(0);
    expect(new Set(calls)).toEqual(new Set(["list"]));
    expect((await store.get(record().id))!.state).toBe("failed");
  });

  it("404 runtime_unknown for an unknown handle", async () => {
    await store.put(record());
    await startIngress();
    for (const host of [
      "carol.matrix-os.com",
      "matrix-os.com",
      "a.b.matrix-os.com",
      "alice.matrix-os.com.evil.test",
      "alice.matrix-os.com:8443",
      "-alice.matrix-os.com",
      "127.0.0.1",
    ]) {
      const reply = await send(authed(host));
      expect(reply.status, host).toBe(404);
      expect(JSON.parse(reply.body)).toEqual({ error: "runtime_unknown" });
    }
    expect(seen).toHaveLength(0);
  });

  it("proxies a WebSocket upgrade", async () => {
    await store.put(record());
    await startIngress();
    const ws = new WebSocket(`wss://127.0.0.1:${ingressPort}/ws/terminal/tab?token=t`, {
      headers: authed(),
      rejectUnauthorized: false,
    });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.once("open", () => ws.send("ping"));
      ws.once("message", (data) => resolve(data.toString()));
      ws.once("error", reject);
    });
    expect(reply).toBe("echo:ping");
    expect(seen[0]).toMatchObject({ method: "GET", url: "/ws/terminal/tab?token=t" });
    expect(seen[0]!.headers["x-matrix-host-auth"]).toBeUndefined();
    ws.close();

    const rejected = new WebSocket(`wss://127.0.0.1:${ingressPort}/ws`, {
      headers: { host: "alice.matrix-os.com" },
      rejectUnauthorized: false,
    });
    const status = await new Promise<number>((resolve) => {
      rejected.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      rejected.once("error", () => resolve(-1));
    });
    expect(status).toBe(401);
    expect(seen).toHaveLength(1);
  });

  it("strips x-matrix-host-auth before forwarding", async () => {
    await store.put(record());
    await startIngress();
    await send(
      authed("alice.matrix-os.com", {
        authorization: "Bearer platform-jwt",
        "x-platform-user-id": "user_1",
        "x-platform-verified": "1",
        cookie: "__session=abc",
        "x-forwarded-for": "203.0.113.7",
      }),
    );
    const headers = seen[0]!.headers;
    expect(headers["x-matrix-host-auth"]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer platform-jwt");
    expect(headers["x-platform-user-id"]).toBe("user_1");
    expect(headers["x-platform-verified"]).toBe("1");
    expect(headers.cookie).toBe("__session=abc");
    expect(headers["x-forwarded-for"]).toBe("203.0.113.7, 127.0.0.1");
    expect(headers["x-forwarded-proto"]).toBe("https");
  });

  it("picks up store changes without a restart", async () => {
    await startIngress();
    expect((await send(authed())).status).toBe(404);
    await store.put(record());
    expect((await send(authed())).status).toBe(200);
    await store.put(record({ state: "suspended" }));
    expect((await send(authed())).status).toBe(503);
    await store.remove(record().id);
    expect((await send(authed())).status).toBe(404);
  });

  it("502 runtime_unreachable when the VM refuses or stalls the connection", async () => {
    const refused = createNetServer();
    const refusedPort = await listen(refused);
    await close(refused);
    await store.put(record());
    await startIngress({ upstreamPort: refusedPort });
    const reply = await send(authed());
    expect(reply.status).toBe(502);
    expect(JSON.parse(reply.body)).toEqual({ error: "runtime_unreachable" });
    await ingress!.close();

    // Accepts TCP but never completes TLS: the connect timeout fires.
    const sockets: Socket[] = [];
    const stall = createNetServer((socket) => sockets.push(socket));
    extraServers.push(stall);
    const stallPort = await listen(stall);
    await startIngress({ upstreamPort: stallPort, connectTimeoutMs: 150 });
    const started = Date.now();
    const stalled = await send(authed());
    expect(stalled.status).toBe(502);
    expect(JSON.parse(stalled.body)).toEqual({ error: "runtime_unreachable" });
    expect(Date.now() - started).toBeLessThan(2_000);
    for (const socket of sockets) socket.destroy();
  });

  it("503 runtime_busy beyond the per-VM upstream connection cap", async () => {
    await store.put(record());
    await startIngress({ maxUpstreamPerVm: 1 });
    const first = send(authed(), { path: "/hold" });
    await expect.poll(() => holdResponses.length).toBe(1);
    const busy = await send(authed());
    expect(busy.status).toBe(503);
    expect(JSON.parse(busy.body)).toEqual({ error: "runtime_busy" });
    holdResponses[0]!();
    expect((await first).status).toBe(200);
    expect((await send(authed())).status).toBe(200);
  });

  it("forwards a chunked body on a bodyless method framed, so an embedded request is never seen", async () => {
    await store.put(record());
    await startIngress();
    const smuggled = "GET /smuggled HTTP/1.1\r\nhost: alice.matrix-os.com\r\nx-platform-verified: 1\r\n\r\n";
    for (const method of ["GET", "DELETE", "OPTIONS"]) {
      const reply = await new Promise<number>((resolve, reject) => {
        const req = httpsRequest(
          {
            host: "127.0.0.1",
            port: ingressPort,
            method,
            path: `/${method.toLowerCase()}`,
            headers: { ...authed(), "transfer-encoding": "chunked" },
            rejectUnauthorized: false,
            agent: false,
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.write(smuggled);
        req.end();
      });
      expect(reply).toBe(200);
    }
    // A follow-up request reuses the pooled upstream socket; a desynced socket would surface the embedded request.
    expect((await send(authed(), { path: "/after" })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.map((r) => r.url)).toEqual(["/get", "/delete", "/options", "/after"]);
    expect(seen.slice(0, 3).map((r) => r.body)).toEqual([smuggled, smuggled, smuggled]);
    expect(seen[0]!.headers["transfer-encoding"]).toBe("chunked");
  });

  it("400 for a request carrying both content-length and transfer-encoding", async () => {
    await store.put(record());
    await startIngress();
    const raw = await rawTls(
      "POST / HTTP/1.1\r\nhost: alice.matrix-os.com\r\nx-matrix-host-auth: " +
        TOKEN +
        "\r\ncontent-length: 5\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n0\r\n\r\n",
    );
    expect(raw.startsWith("HTTP/1.1 400")).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("releases the per-VM slot when a WebSocket client disconnects during a slow lookup", async () => {
    await store.put(record());
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let listCalls = 0;
    const slowStore = {
      list: async () => {
        listCalls++;
        await gate;
        return store.list();
      },
      onChange: (cb: (id: string) => void) => store.onChange(cb),
    };
    await startIngress({ store: slowStore, maxUpstreamPerVm: 1 });
    const client = await rawTlsSocket();
    client.write(
      "GET /ws HTTP/1.1\r\nhost: alice.matrix-os.com\r\nx-matrix-host-auth: " +
        TOKEN +
        "\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\n" +
        "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    await expect.poll(() => listCalls).toBe(1);
    client.destroy();
    await new Promise((r) => setTimeout(r, 100));
    open();
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toHaveLength(0);
    expect((await send(authed())).status).toBe(200);
  });

  it("releases the per-VM slot when an HTTP client disconnects during a slow lookup", async () => {
    await store.put(record());
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let listCalls = 0;
    const slowStore = {
      list: async () => {
        listCalls++;
        await gate;
        return store.list();
      },
      onChange: (cb: (id: string) => void) => store.onChange(cb),
    };
    await startIngress({ store: slowStore, maxUpstreamPerVm: 1 });
    const client = await rawTlsSocket();
    client.write("GET /gone HTTP/1.1\r\nhost: alice.matrix-os.com\r\nx-matrix-host-auth: " + TOKEN + "\r\n\r\n");
    await expect.poll(() => listCalls).toBe(1);
    client.destroy();
    await new Promise((r) => setTimeout(r, 100));
    open();
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.map((r) => r.url)).not.toContain("/gone");
    expect((await send(authed())).status).toBe(200);
  });

  it("releases the per-VM slot when opening the upstream request throws", async () => {
    await store.put(record());
    let calls = 0;
    const upstreamRequest = ((...args: Parameters<typeof httpsRequest>) => {
      calls++;
      if (calls === 1) throw new TypeError("synthetic request failure");
      return httpsRequest(...args);
    }) as typeof httpsRequest;
    await startIngress({ maxUpstreamPerVm: 1, upstreamRequest });
    const first = await send(authed());
    expect(first.status).toBe(502);
    expect(JSON.parse(first.body)).toEqual({ error: "runtime_unreachable" });
    expect((await send(authed())).status).toBe(200);
  });

  it("records the last authorized request per known handle, including asleep VMs", async () => {
    await store.put(record());
    await store.put(record({ id: "vm_bbbbbbbbbbbbbbbbbbbbbbbb", handle: "bob", state: "suspended" }));
    let t = 5_000;
    await startIngress({ now: () => t });
    expect(ingress!.lastRequestAt("alice")).toBeUndefined();
    await send(authed());
    t = 9_000;
    await send(authed("bob.matrix-os.com"));
    await send({ host: "alice.matrix-os.com" });
    await send(authed("nobody.matrix-os.com"));
    expect(ingress!.lastRequestAt("alice")).toBe(5_000);
    expect(ingress!.lastRequestAt("Bob")).toBe(9_000);
    expect(ingress!.lastRequestAt("nobody")).toBeUndefined();
  });

  it("caps the last-request map and evicts the least recently seen handle", async () => {
    await store.put(record());
    await store.put(record({ id: "vm_bbbbbbbbbbbbbbbbbbbbbbbb", handle: "bob", privateIPv4: "127.0.0.2" }));
    await store.put(record({ id: "vm_cccccccccccccccccccccccc", handle: "carol", privateIPv4: "127.0.0.3" }));
    await startIngress({ maxTrackedHandles: 2 });
    await send(authed());
    await send(authed("bob.matrix-os.com"));
    await send(authed());
    await send(authed("carol.matrix-os.com"));
    expect(ingress!.lastRequestAt("alice")).toBeTypeOf("number");
    expect(ingress!.lastRequestAt("bob")).toBeUndefined();
    expect(ingress!.lastRequestAt("carol")).toBeTypeOf("number");
  });

  it("ingress marks its own runtime_asleep answer with x-matrix-ingress-error", async () => {
    await store.put(record({ state: "suspended" }));
    await startIngress();
    const reply = await send(authed());
    expect(reply.status).toBe(503);
    expect(reply.headers["x-matrix-ingress-error"]).toBe("runtime_asleep");
    const ws = await rawTls(
      "GET /ws HTTP/1.1\r\nhost: alice.matrix-os.com\r\nx-matrix-host-auth: " +
        TOKEN +
        "\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\n" +
        "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    expect(ws).toMatch(/^HTTP\/1.1 503 /);
    expect(ws).toContain("x-matrix-ingress-error: runtime_asleep\r\n");
  });

  it("ingress marks every self-generated error with x-matrix-ingress-error", async () => {
    await store.put(record());
    await store.put(record({ id: "vm_bbbbbbbbbbbbbbbbbbbbbbbb", handle: "bob", state: "failed" }));
    const refused = createNetServer();
    const refusedPort = await listen(refused);
    await close(refused);
    const unreachable = record({ id: "vm_cccccccccccccccccccccccc", handle: "carol", privateIPv4: "127.0.0.3" });
    await store.put(unreachable);
    await startIngress({ maxUpstreamPerVm: 1 });
    const cases: Array<[string, Reply]> = [
      ["unauthorized", await send({ host: "alice.matrix-os.com" })],
      ["runtime_unknown", await send(authed("nobody.matrix-os.com"))],
      ["runtime_unavailable", await send(authed("bob.matrix-os.com"))],
    ];
    const held = send(authed(), { path: "/hold" });
    await expect.poll(() => holdResponses.length).toBe(1);
    cases.push(["runtime_busy", await send(authed())]);
    holdResponses[0]!();
    await held;
    await ingress!.close();
    await startIngress({ upstreamPort: refusedPort });
    cases.push(["runtime_unreachable", await send(authed("carol.matrix-os.com"))]);
    for (const [code, reply] of cases) {
      expect(JSON.parse(reply.body), code).toEqual({ error: code });
      expect(reply.headers["x-matrix-ingress-error"], code).toBe(code);
    }
  });

  it("ingress strips x-matrix-ingress-error from a VM response", async () => {
    await store.put(record());
    await startIngress();
    const reply = await send(authed(), { path: "/forge" });
    expect(seen.map((r) => r.url)).toContain("/forge");
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toEqual({ error: "runtime_asleep" });
    expect(reply.headers["x-matrix-ingress-error"]).toBeUndefined();
  });

  it("ingress strips x-matrix-ingress-error from a VM WebSocket handshake answer", async () => {
    await store.put(record());
    await startIngress();
    const upgrade = (path: string) =>
      `GET ${path} HTTP/1.1\r\nhost: alice.matrix-os.com\r\nx-matrix-host-auth: ${TOKEN}\r\n` +
      "connection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\n" +
      "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";
    const declined = await rawTls(upgrade("/ws-forge-decline"));
    expect(declined).toMatch(/^HTTP\/1.1 503 /);
    expect(declined.toLowerCase()).not.toContain("x-matrix-ingress-error");
    expect(declined.endsWith("no")).toBe(true);

    const socket = await rawTlsSocket();
    let text = "";
    socket.on("data", (c: Buffer) => (text += c.toString()));
    socket.write(upgrade("/ws-forge"));
    await expect.poll(() => text).toContain("\r\n\r\n");
    expect(text).toMatch(/^HTTP\/1.1 101 /);
    expect(text.toLowerCase()).not.toContain("x-matrix-ingress-error");
    socket.destroy();
    expect(seen.map((r) => r.url)).toEqual(["/ws-forge-decline", "/ws-forge"]);
  });
});

function rawTlsSocket(): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: "127.0.0.1", port: ingressPort, rejectUnauthorized: false }, () => resolve(socket));
    socket.once("error", reject);
  });
}

async function rawTls(payload: string): Promise<string> {
  const socket = await rawTlsSocket();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("error", () => resolve(Buffer.concat(chunks).toString()));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
    socket.write(payload);
  });
}

describe("host ingress with several VMs sharing one handle", () => {
  // A handle can briefly map to two VMs: a platform re-provision creates the
  // new machine's VM before the old one (stopped, awaiting teardown) is gone.
  const OLD = "vm_aaaaaaaaaaaaaaaaaaaaaaaa";
  const NEW = "vm_ffffffffffffffffffffffff";
  let logs: Array<{ event: string; fields: Record<string, unknown> }>;

  function listStore(records: VmRecord[]): Parameters<typeof createIngress>[0]["store"] {
    return { list: async () => records, onChange: () => () => undefined };
  }

  async function startWith(records: VmRecord[]): Promise<void> {
    logs = [];
    await startIngress({ store: listStore(records), log: (event, fields) => logs.push({ event, fields }) });
  }

  const duplicates = () => logs.filter((l) => l.event === "ingress.duplicate_handle").map((l) => l.fields);

  const stoppedOld = () =>
    record({ id: OLD, machineId: "machine-old", state: "stopped", privateIPv4: "127.0.0.2", updatedAt: "2026-11-20T00:00:00.000Z" });
  const runningNew = () => record({ id: NEW, machineId: "machine-new", state: "running", updatedAt: "2026-11-21T00:00:00.000Z" });

  it("routes to the running VM when a stopped VM with the same handle is listed first", async () => {
    await startWith([stoppedOld(), runningNew()]);
    const reply = await send(authed());
    expect(reply.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(duplicates()).toEqual([{ handle: "alice", kept: NEW, dropped: OLD }]);
  });

  it("routes to the running VM when it is listed first", async () => {
    await startWith([runningNew(), stoppedOld()]);
    expect((await send(authed())).status).toBe(200);
    expect(duplicates()).toEqual([{ handle: "alice", kept: NEW, dropped: OLD }]);
  });

  it("prefers the running VM even when the stopped one was updated more recently", async () => {
    await startWith([{ ...stoppedOld(), updatedAt: "2026-11-22T00:00:00.000Z" }, runningNew()]);
    expect((await send(authed())).status).toBe(200);
  });

  it("keeps the most recently updated of two suspended VMs, whatever the list order", async () => {
    const older = record({ id: NEW, machineId: "machine-old", state: "suspended", updatedAt: "2026-11-20T00:00:00.000Z" });
    const newer = record({ id: OLD, machineId: "machine-new", state: "suspended", updatedAt: "2026-11-21T00:00:00.000Z" });
    for (const order of [[older, newer], [newer, older]]) {
      if (ingress) await ingress.close();
      await startWith(order);
      const reply = await send(authed());
      expect(reply.status).toBe(503);
      expect(JSON.parse(reply.body)).toEqual({ error: "runtime_asleep" });
      expect(duplicates()).toEqual([{ handle: "alice", kept: OLD, dropped: NEW }]);
    }
  });

  it("routes to the most recently updated of two running VMs", async () => {
    // Only 127.0.0.1 answers; picking the older VM would give 502.
    const older = record({ id: OLD, machineId: "machine-old", privateIPv4: "127.0.0.2", updatedAt: "2026-11-20T00:00:00.000Z" });
    const newer = record({ id: NEW, machineId: "machine-new", updatedAt: "2026-11-21T00:00:00.000Z" });
    await startWith([older, newer]);
    expect((await send(authed())).status).toBe(200);
  });

  it("prefers a creating VM over a stopped or failed one", async () => {
    const failed = record({ id: "vm_bbbbbbbbbbbbbbbbbbbbbbbb", machineId: "machine-failed", state: "failed", updatedAt: "2026-11-22T00:00:00.000Z" });
    const creating = record({ id: NEW, machineId: "machine-new", state: "creating" });
    await startWith([failed, creating, stoppedOld()]);
    const reply = await send(authed());
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toEqual({ error: "runtime_unavailable" });
    expect(duplicates().map((d) => d.kept)).toEqual([NEW, NEW]);
  });

  it("prefers a replacement being created over an old suspended VM, so the old machine is never woken", async () => {
    for (const state of ["suspended", "suspending"] as VmState[]) {
      if (ingress) await ingress.close();
      const old = record({ id: OLD, machineId: "machine-old", state, updatedAt: "2026-11-22T00:00:00.000Z" });
      const creating = record({ id: NEW, machineId: "machine-new", state: "creating", updatedAt: "2026-11-20T00:00:00.000Z" });
      await startWith([old, creating]);
      const reply = await send(authed());
      expect(reply.status).toBe(503);
      expect(JSON.parse(reply.body)).toEqual({ error: "runtime_unavailable" });
      expect(duplicates()).toEqual([{ handle: "alice", kept: NEW, dropped: OLD }]);
    }
  });

  it("leaves a single record per handle unchanged and logs no duplicate", async () => {
    await startWith([runningNew(), record({ id: OLD, handle: "bob", state: "stopped" })]);
    expect((await send(authed())).status).toBe(200);
    expect(JSON.parse((await send(authed("bob.matrix-os.com"))).body)).toEqual({ error: "runtime_asleep" });
    expect(duplicates()).toEqual([]);
  });
});
