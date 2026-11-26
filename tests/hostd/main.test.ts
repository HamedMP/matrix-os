import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer, request as httpsRequest, type Server } from "node:https";
import { connect as netConnect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChClient } from "../../packages/hostd/src/ch-client.js";
import type { HostdConfig } from "../../packages/hostd/src/config.js";
import type { Exec } from "../../packages/hostd/src/exec.js";
import type { GuestClient } from "../../packages/hostd/src/guest-client.js";
import { createGatewayHealth, main, poolFreeBytes, runMain, startHostd, type Hostd, type HostdOverrides } from "../../packages/hostd/src/main.js";
import { createVmStore, type VmRecord } from "../../packages/hostd/src/vm-store.js";

const API_TOKEN = "api-token-0123456789abcdef0123456789abcdef";
const INGRESS_TOKEN = "ingress-token-0123456789abcdef0123456789";
const MiB = 1024 * 1024;

let certDir: string;
let tls: { cert: string; key: string };

beforeAll(() => {
  certDir = execFileSync("mktemp", ["-d", join(tmpdir(), "hostd-main-cert-XXXXXX")]).toString().trim();
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=hostd.local", "-days", "1",
      "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem")],
    { stdio: "ignore" },
  );
  tls = {
    cert: execFileSync("cat", [join(certDir, "cert.pem")]).toString(),
    key: execFileSync("cat", [join(certDir, "key.pem")]).toString(),
  };
});

afterAll(async () => {
  await rm(certDir, { recursive: true, force: true });
});

let root: string;
let config: HostdConfig;
let hostd: Hostd | undefined;
let events: string[];
let trimGate: Promise<void> | null;
let active: Set<string>;
let chRunning: boolean;
let t: number;

const exec: Exec = async (argv) => {
  events.push(`exec:${argv.join(" ")}`);
  if (argv[0] === "ip") return { code: 0, stdout: "[]", stderr: "" };
  if (argv[0] === "lvs" && argv.includes("data_percent,metadata_percent")) return { code: 0, stdout: "  10.00  5.00\n", stderr: "" };
  if (argv[0] === "lvs" && argv.includes("lv_size")) return { code: 0, stdout: "  21474836480\n", stderr: "" };
  if (argv[1] === "is-active") {
    const states = argv.slice(2).map((unit) => active.has(unit) ? "active" : "inactive");
    return { code: states.includes("active") ? 0 : 3, stdout: states.join("\n"), stderr: "" };
  }
  // lvs of a VM disk: exit 5 with LVM's "no such LV" message.
  if (argv[0] === "lvs") return { code: 5, stdout: "", stderr: '  Failed to find logical volume "vmvg/mx-x"\n' };
  return { code: 0, stdout: "", stderr: "" };
};

function ch(): ChClient {
  const ok = async () => undefined;
  return {
    info: async () => ({ state: chRunning ? "Running" : "Shutdown", memoryActualBytes: 2048 * MiB }),
    pause: ok,
    resume: ok,
    async snapshot(dir) {
      await writeFile(join(dir, "memory-ranges"), "mem");
    },
    async resizeMemory(bytes) {
      events.push(`ch:resize ${bytes / MiB}`);
    },
    async powerButton() {
      chRunning = false;
    },
    shutdownVmm: ok,
    close: ok,
  };
}

function guest(id: string): GuestClient {
  return {
    stats: async () => ({ psiSome10: 50, availableMiB: 100, anonMiB: 1900 }),
    async trim() {
      events.push(`trim:${id}`);
      if (trimGate) await trimGate;
    },
  };
}

const overrides = (extra: HostdOverrides = {}): HostdOverrides => ({
  exec,
  ch: () => ch(),
  guest,
  gatewayHealth: async () => true,
  hostAvailableMiB: async () => 100_000,
  memoryBudgetMiB: () => 100_000,
  lifecycleConfig: { trimSettleMs: 0, serialLogDir: join(root, "log") },
  memoryIntervalMs: 60_000,
  now: () => t,
  log: () => undefined,
  ...extra,
});

const mainOverrides = (extra: HostdOverrides = {}) => ({
  ...overrides(extra),
  directories: { stateDir: config.stateDir, runDir: config.runDir },
});

interface Reply {
  status: number;
  body: string;
}

function call(port: number, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { ...headers, ...(raw ? { "content-type": "application/json" } : {}) },
        rejectUnauthorized: false,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    req.end(raw);
  });
}

const port = (server: Server) => (server.address() as AddressInfo).port;

async function free(): Promise<string> {
  const probe = createHttpsServer(tls);
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const p = port(probe);
  await new Promise((r) => probe.close(r));
  return String(p);
}
const apiCall = (method: string, path: string, body?: unknown) =>
  call(port(hostd!.api), method, path, { authorization: `Bearer ${API_TOKEN}` }, body);
const ingressCall = (id: string) =>
  call(port(hostd!.ingress.server), "GET", "/", {
    host: "app.matrix-os.com", "x-matrix-host-auth": INGRESS_TOKEN, "x-matrix-vm-target": `${id}:1`,
  });

const createBody = {
  machineId: "machine-1",
  generation: 1,
  handle: "alice",
  tier: "free",
  bootMiB: 2048,
  maxMiB: 8192,
  diskGiB: 20,
  userData: "#cloud-config\n",
  goldenVersion: "2026.11.20-1",
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hostd-main-"));
  await mkdir(join(root, "state", "snapshots"), { recursive: true });
  config = {
    apiToken: API_TOKEN,
    ingressToken: INGRESS_TOKEN,
    tlsCertPath: join(certDir, "cert.pem"),
    tlsKeyPath: join(certDir, "key.pem"),
    apiHost: "127.0.0.1",
    apiPort: 0,
    ingressHost: "127.0.0.1",
    ingressPort: 0,
    stateDir: join(root, "state"),
    runDir: join(root, "run"),
    poolMaxDataPercent: 85,
    poolMaxMetadataPercent: 80,
    poolQueryTimeoutMs: 5_000,
  };
  events = [];
  trimGate = null;
  active = new Set();
  chRunning = true;
  t = 1_000_000;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await hostd?.close();
  hostd = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("hostd main", () => {
  it("serves the authenticated API over TLS", async () => {
    hostd = await startHostd(config, overrides());
    const anonymous = await call(port(hostd.api), "GET", "/v1/capacity", {});
    expect(anonymous.status).toBe(401);
    const capacity = await apiCall("GET", "/v1/capacity");
    expect(capacity.status).toBe(200);
    expect(JSON.parse(capacity.body)).toMatchObject({ memoryAvailableMiB: 100_000, runningVms: 0, suspendedVms: 0 });
    expect(JSON.parse(capacity.body).poolFreeBytes).toBeGreaterThan(0);
    expect(JSON.parse(capacity.body).thinPool).toEqual({ dataPercent: 10, metadataPercent: 5 });
  });

  it("refuses a create when host-wide memory will not fit", async () => {
    hostd = await startHostd(config, overrides({ memoryBudgetMiB: () => 2_048 }));
    expect(await apiCall("POST", "/v1/vms", createBody)).toMatchObject({
      status: 503, body: '{"error":"capacity"}',
    });
    expect(await hostd.store.list()).toEqual([]);
  });

  it("queries permanent host neighbors before routing to a running guest", async () => {
    hostd = await startHostd(config, overrides());
    const reply = await apiCall("POST", "/v1/vms", createBody);
    expect(reply.status).toBe(201);
    const { id } = JSON.parse(reply.body) as { id: string };
    active.add(`matrix-vm@${id}.service`);
    expect(await ingressCall(id)).toMatchObject({
      status: 503, body: '{"error":"runtime_unavailable"}',
    });
    expect(events).toContain("exec:ip -j -4 neigh show dev brmx nud permanent");
  });

  it("signals wake after the VMM exits without an update to the running record", async () => {
    hostd = await startHostd(config, overrides());
    const { id } = JSON.parse((await apiCall("POST", "/v1/vms", createBody)).body) as { id: string };
    const unit = `matrix-vm@${id}.service`;
    const restoreUnit = `matrix-vm-restore@${id}.service`;
    active.add(restoreUnit);
    expect(JSON.parse((await ingressCall(id)).body)).toEqual({ error: "runtime_unavailable" });
    active.delete(restoreUnit);
    expect(JSON.parse((await ingressCall(id)).body)).toEqual({ error: "runtime_asleep" });
    expect(events).toContain(`exec:systemctl is-active ${unit} ${restoreUnit}`);
    await expect(hostd.store.get(id)).resolves.toMatchObject({ state: "running" });
  });

  it("returns retryable capacity and drops the record if disk reservation is refused", async () => {
    hostd = await startHostd(config, overrides({
      exec: async (argv, options) => argv[0] === "/usr/local/libexec/matrix-hostd-thin"
        ? { code: 75, stdout: "", stderr: "capacity" }
        : exec(argv, options),
    }));
    expect(await apiCall("POST", "/v1/vms", createBody)).toMatchObject({
      status: 503, body: '{"error":"capacity"}',
    });
    expect(await hostd.store.list()).toEqual([]);
  });

  it("applies the configured thin pool thresholds: create answers 503 capacity past them", async () => {
    hostd = await startHostd({ ...config, poolMaxDataPercent: 9 }, overrides());
    const refused = await apiCall("POST", "/v1/vms", createBody);
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toEqual({ error: "capacity" });
    await expect(hostd.store.list()).resolves.toEqual([]);
  });

  it("shares one store: a VM created and suspended through the API is seen by the ingress at once", async () => {
    hostd = await startHostd(config, overrides());
    expect(JSON.parse((await ingressCall("vm_0123456789abcdef01234567")).body)).toEqual({ error: "runtime_unknown" });
    const created = JSON.parse((await apiCall("POST", "/v1/vms", createBody)).body) as { id: string };
    expect((await apiCall("POST", `/v1/vms/${created.id}/suspend`)).status).toBe(202);
    await hostd.lifecycle.idle();
    // The ingress index is younger than its 2 s max age: only a change notification refreshes it.
    const asleep = await ingressCall(created.id);
    expect(asleep.status).toBe(503);
    expect(JSON.parse(asleep.body)).toEqual({ error: "runtime_asleep" });
    expect(events).toContain(`trim:${created.id}`);
  });

  it("measures idle seconds from the VM's last ingress request, or from startup", async () => {
    hostd = await startHostd(config, overrides());
    const created = JSON.parse((await apiCall("POST", "/v1/vms", createBody)).body) as { id: string };
    const record = (await hostd.store.get(created.id))!;
    t += 90_000;
    expect(hostd.idleSeconds(record)).toBe(90);
    await apiCall("POST", `/v1/vms/${created.id}/suspend`);
    await hostd.lifecycle.idle();
    await ingressCall(created.id);
    t += 5_000;
    expect(hostd.idleSeconds(record)).toBe(5);
  });

  it("the memory controller resizes through the lifecycle", async () => {
    hostd = await startHostd(config, overrides());
    const resize = vi.spyOn(hostd.lifecycle, "resize");
    await apiCall("POST", "/v1/vms", createBody);
    await hostd.memory.tick();
    expect(events).toContain("ch:resize 3072");
    expect(resize).toHaveBeenCalledWith(expect.any(String), 3072, { tier: "free", maxMiB: 8192, action: "grow" });
  });

  it("reconciles transitional records before serving", async () => {
    const store = createVmStore(join(config.stateDir, "vms"));
    const base: VmRecord = {
      id: "vm_0123456789abcdef01234567",
      machineId: "m1",
      generation: 1,
      handle: "alice",
      tier: "free",
      state: "creating",
      privateIPv4: "10.78.0.10",
      mac: "52:54:00:78:00:0a",
      bootMiB: 2048,
      maxMiB: 8192,
      diskGiB: 20,
      chVersion: "v54.1",
      snapshot: null,
      updatedAt: "2026-11-21T00:00:00.000Z",
    };
    await store.put(base);
    await store.put({ ...base, id: "vm_bbbbbbbbbbbbbbbbbbbbbbbb", machineId: "m2", handle: "bob", state: "resuming" });
    active.add("matrix-vm-restore@vm_bbbbbbbbbbbbbbbbbbbbbbbb.service");
    hostd = await startHostd(config, overrides());
    const vms = JSON.parse((await apiCall("GET", "/v1/vms")).body) as { vms: Array<{ id: string; state: string }> };
    expect(vms.vms.map((v) => [v.id, v.state])).toEqual([
      ["vm_0123456789abcdef01234567", "failed"],
      ["vm_bbbbbbbbbbbbbbbbbbbbbbbb", "running"],
    ]);
  });

  it("a repeated create recreates a VM whose create failed and refuses one that failed later", async () => {
    hostd = await startHostd(config, overrides());
    const first = JSON.parse((await apiCall("POST", "/v1/vms", createBody)).body) as { id: string };
    const record = (await hostd.store.get(first.id))!;
    await hostd.store.put({ ...record, state: "failed" });
    expect((await apiCall("POST", "/v1/vms", createBody)).status).toBe(409);
    await hostd.store.put({ ...record, state: "failed", failedDuring: "create" });
    const again = await apiCall("POST", "/v1/vms", createBody);
    expect(again.status).toBe(201);
    expect(JSON.parse(again.body).id).not.toBe(first.id);
  });

  it("close waits for in-flight lifecycle operations, bounded by the drain timeout", async () => {
    let release!: () => void;
    trimGate = new Promise((r) => {
      release = r;
    });
    hostd = await startHostd(config, overrides());
    const created = JSON.parse((await apiCall("POST", "/v1/vms", createBody)).body) as { id: string };
    await apiCall("POST", `/v1/vms/${created.id}/suspend`);
    let closed = false;
    const closing = hostd.close().then(() => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(false);
    expect(hostd.api.listening).toBe(false);
    expect(hostd.ingress.server.listening).toBe(false);
    release();
    await closing;
    await expect(hostd.store.get(created.id)).resolves.toMatchObject({ state: "suspended" });

    trimGate = new Promise(() => undefined);
    const logs: string[] = [];
    hostd = await startHostd(config, overrides({ drainTimeoutMs: 20, log: (event) => logs.push(event) }));
    const second = JSON.parse((await apiCall("POST", "/v1/vms", { ...createBody, machineId: "machine-2", handle: "bob" })).body) as {
      id: string;
    };
    await apiCall("POST", `/v1/vms/${second.id}/suspend`);
    await hostd.close();
    expect(logs).toContain("hostd.drain_timeout");
  });

  it("close stops accepting at once and bounds the whole shutdown, including a stuck memory loop", async () => {
    const logs: string[] = [];
    hostd = await startHostd(config, overrides({ drainTimeoutMs: 50, log: (event) => logs.push(event) }));
    hostd.memory.stop = () => new Promise<void>(() => undefined);
    const closing = hostd.close();
    await new Promise((r) => setImmediate(r));
    expect(hostd.api.listening).toBe(false);
    expect(hostd.ingress.server.listening).toBe(false);
    await closing;
    expect(logs).toContain("hostd.drain_timeout");
  });

  it("main loads config from the environment, fails closed, and drains on SIGTERM", async () => {
    const taken = createHttpsServer(tls);
    await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
    const env = {
      HOSTD_API_TOKEN: API_TOKEN,
      HOSTD_INGRESS_TOKEN: INGRESS_TOKEN,
      HOSTD_TLS_CERT_PATH: config.tlsCertPath,
      HOSTD_TLS_KEY_PATH: config.tlsKeyPath,
      HOSTD_API_HOST: "127.0.0.1",
      HOSTD_API_PORT: String(port(taken)),
      HOSTD_INGRESS_HOST: "127.0.0.1",
    };
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    const proc = { once: (signal: string, fn: () => void) => handlers.set(signal, fn), exit: (code: number) => exits.push(code) };
    await expect(main({ ...env, HOSTD_API_TOKEN: undefined }, proc, mainOverrides())).rejects.toMatchObject({
      keys: ["HOSTD_API_TOKEN"],
    });
    // The API port is taken: startup fails and installs no handlers.
    await expect(main({ ...env, HOSTD_INGRESS_PORT: await free() }, proc, mainOverrides())).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    expect(handlers.size).toBe(0);
    await new Promise((r) => taken.close(r));

    const started = await main({ ...env, HOSTD_API_PORT: await free(), HOSTD_INGRESS_PORT: await free() }, proc, mainOverrides());
    hostd = started;
    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    handlers.get("SIGTERM")!();
    await started.close();
    await new Promise((r) => setImmediate(r));
    expect(exits).toEqual([0]);
  });
});

describe("hostd main (production defaults)", () => {
  it("starts with the real exec, clients and host probes, then closes", async () => {
    hostd = await startHostd(config, { log: () => undefined });
    const capacity = await apiCall("GET", "/v1/capacity");
    expect(capacity.status).toBe(200);
    expect(JSON.parse(capacity.body).memoryAvailableMiB).toBeGreaterThan(0);
    await hostd.close();
    await expect(hostd.close()).resolves.toBeUndefined();
  });

  it("uses the real CH and guest clients and the default logger", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = createVmStore(join(config.stateDir, "vms"));
    const vm: VmRecord = {
      id: "vm_0123456789abcdef01234567",
      machineId: "m1",
      generation: 1,
      handle: "alice",
      tier: "free",
      state: "running",
      privateIPv4: "10.78.0.10",
      mac: "52:54:00:78:00:0a",
      bootMiB: 2048,
      maxMiB: 8192,
      diskGiB: 20,
      chVersion: "v54.1",
      snapshot: null,
      updatedAt: "2026-11-21T00:00:00.000Z",
    };
    await store.put(vm);
    // The VM is live, so startup reconcile keeps its running record.
    active.add(`matrix-vm@${vm.id}.service`);
    // Only the exec is faked: no host command may run in a test.
    hostd = await startHostd(config, { exec, lifecycleConfig: { trimSettleMs: 0 } });
    await hostd.memory.tick();
    await expect(hostd.lifecycle.suspend(vm.id)).rejects.toMatchObject({ code: "snapshot_failed" });
    const events = error.mock.calls.map((c) => JSON.parse(String(c[0])).event as string);
    expect(events).toEqual(expect.arrayContaining(["memory.sample_failed", "vm_trim_failed", "vm_snapshot_failed"]));
    const raw = netConnect(port(hostd.api), "127.0.0.1");
    await new Promise((r) => raw.once("connect", r));
    raw.end("not tls\r\n\r\n");
    await expect.poll(() => error.mock.calls.some((c) => String(c[0]).includes("api.tls_client_error"))).toBe(true);
  });

  it("runMain exits 1 on a startup failure, logging the config keys only", async () => {
    const exits: number[] = [];
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const proc = { once: () => undefined, exit: (code: number) => exits.push(code) };
    await expect(
      runMain({ HOSTD_API_TOKEN: API_TOKEN }, proc, overrides({ log: (event, fields) => logs.push({ event, fields }) })),
    ).resolves.toBeUndefined();
    expect(exits).toEqual([1]);
    expect(logs).toContainEqual({
      event: "hostd.start_failed",
      fields: { error: "ConfigError", keys: ["HOSTD_INGRESS_TOKEN", "HOSTD_TLS_CERT_PATH", "HOSTD_TLS_KEY_PATH"] },
    });
    expect(JSON.stringify(logs)).not.toContain(API_TOKEN);
  });

  it("runMain logs a startup failure through the default logger", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exits: number[] = [];
    await runMain({}, { once: () => undefined, exit: (code: number) => exits.push(code) });
    expect(exits).toEqual([1]);
    expect(error.mock.calls.some((c) => String(c[0]).includes("hostd.start_failed"))).toBe(true);
  });

  it("logs a non-Error drain failure", async () => {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    const logs: Array<Record<string, unknown>> = [];
    hostd = await main(
      {
        HOSTD_API_TOKEN: API_TOKEN,
        HOSTD_INGRESS_TOKEN: INGRESS_TOKEN,
        HOSTD_TLS_CERT_PATH: config.tlsCertPath,
        HOSTD_TLS_KEY_PATH: config.tlsKeyPath,
        HOSTD_API_HOST: "127.0.0.1",
        HOSTD_API_PORT: await free(),
        HOSTD_INGRESS_HOST: "127.0.0.1",
        HOSTD_INGRESS_PORT: await free(),
      },
      { once: (s: string, fn: () => void) => handlers.set(s, fn), exit: (code: number) => exits.push(code) },
      mainOverrides({ log: (_event, fields) => logs.push(fields) }),
    );
    const realClose = hostd.close;
    hostd.close = () => Promise.reject("plain");
    handlers.get("SIGTERM")!();
    await new Promise((r) => setImmediate(r));
    expect(exits).toEqual([1]);
    expect(logs).toContainEqual({ error: "plain" });
    hostd.close = realClose;
  });

  it("exits 1 when the drain fails", async () => {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    const logs: string[] = [];
    const env = {
      HOSTD_API_TOKEN: API_TOKEN,
      HOSTD_INGRESS_TOKEN: INGRESS_TOKEN,
      HOSTD_TLS_CERT_PATH: config.tlsCertPath,
      HOSTD_TLS_KEY_PATH: config.tlsKeyPath,
      HOSTD_API_HOST: "127.0.0.1",
      HOSTD_API_PORT: await free(),
      HOSTD_INGRESS_HOST: "127.0.0.1",
      HOSTD_INGRESS_PORT: await free(),
    };
    hostd = await main(
      env,
      { once: (signal: string, fn: () => void) => handlers.set(signal, fn), exit: (code: number) => exits.push(code) },
      mainOverrides({ log: (event) => logs.push(event) }),
    );
    const realClose = hostd.close;
    hostd.close = () => Promise.reject(new Error("drain broke"));
    handlers.get("SIGINT")!();
    await new Promise((r) => setImmediate(r));
    expect(exits).toEqual([1]);
    expect(logs).toContain("hostd.shutdown_failed");
    hostd.close = realClose;
  });
});

describe("hostd host probes", () => {
  it("gateway health is true only for a 200 from /health on the VM's nginx", async () => {
    let status = 200;
    const seen: string[] = [];
    const server = createHttpsServer(tls, (req, res) => {
      seen.push(req.url ?? "");
      res.writeHead(status);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const health = createGatewayHealth(port(server));
    try {
      await expect(health.probe("127.0.0.1", AbortSignal.timeout(2000))).resolves.toBe(true);
      status = 502;
      await expect(health.probe("127.0.0.1", AbortSignal.timeout(2000))).resolves.toBe(false);
      expect(seen).toEqual(["/health", "/health"]);
    } finally {
      await health.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it("pool free bytes come from the pool filesystem", async () => {
    await expect(poolFreeBytes(tmpdir())).resolves.toBeGreaterThan(0);
  });
});
