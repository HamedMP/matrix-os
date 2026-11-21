import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from "node:https";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
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
      else send();
    });
  });
  wss = new WebSocketServer({ noServer: true });
  vm.on("upgrade", (req, socket, head) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: "" });
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
});
