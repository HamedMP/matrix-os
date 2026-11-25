import { readFile, statfs } from "node:fs/promises";
import { createServer as createHttpsServer, type Server } from "node:https";
import { isIPv4 } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Agent, request } from "undici";
import { createHostApi } from "./api.js";
import { createChClient, type ChClient } from "./ch-client.js";
import { loadConfig, type HostdConfig } from "./config.js";
import { createExec, run, type Exec } from "./exec.js";
import { createGuestClient, type GuestClient } from "./guest-client.js";
import { createIngress, type Ingress } from "./ingress.js";
import { hostVmMemoryBudgetMiB } from "./memory-admission.js";
import { createMemoryController, readHostAvailableMiB, type MemoryController } from "./memory-controller.js";
import { reconcileVms } from "./reconcile.js";
import { createVmLifecycle, DEFAULT_LIFECYCLE_CONFIG, type LifecycleConfig, type VmLifecycle } from "./vm-lifecycle.js";
import { createVmStore, type VmRecord, type VmStore } from "./vm-store.js";

// Composes hostd: ONE VmStore shared by the lifecycle, the ingress, the
// memory controller and the API (the ingress index and the memory loop rely
// on its change notifications); startup reconciliation before anything
// listens; both TLS servers on the same certificate; and a graceful drain.

export const DRAIN_TIMEOUT_MS = 30_000;
const HEALTH_PATH = "/health";

type Log = (event: string, fields: Record<string, unknown>) => void;

export interface HostdOverrides {
  exec?: Exec;
  ch?: (id: string) => ChClient;
  guest?: (id: string) => GuestClient;
  gatewayHealth?: (ip: string, signal: AbortSignal) => Promise<boolean>;
  hostAvailableMiB?: (signal: AbortSignal) => Promise<number>;
  memoryBudgetMiB?: () => number;
  lifecycleConfig?: Partial<LifecycleConfig>;
  ingressUpstreamPort?: number;
  memoryIntervalMs?: number;
  drainTimeoutMs?: number;
  now?: () => number;
  log?: Log;
}

export interface Hostd {
  store: VmStore;
  lifecycle: VmLifecycle;
  ingress: Ingress;
  memory: MemoryController;
  api: Server;
  // Seconds since the owner last reached this VM through the ingress (or since hostd started).
  idleSeconds(record: VmRecord): number;
  close(): Promise<void>;
}

const defaultLog: Log = (event, fields) => console.error(JSON.stringify({ event, ...fields }));

// GET https://<ip>/health on the VM's nginx (self-signed on the private bridge).
export function createGatewayHealth(port = 443): { probe: (ip: string, signal: AbortSignal) => Promise<boolean>; close(): Promise<void> } {
  const agent = new Agent({ connect: { rejectUnauthorized: false }, connections: 4 });
  return {
    async probe(ip, signal) {
      const res = await request(`https://${ip}:${port}${HEALTH_PATH}`, { dispatcher: agent, signal, method: "GET" });
      await res.body.dump();
      return res.statusCode === 200;
    },
    close: () => agent.close(),
  };
}

export async function poolFreeBytes(dir: string): Promise<number> {
  const info = await statfs(dir);
  return info.bavail * info.bsize;
}

async function readVmBindings(exec: Exec, bridge: string): Promise<ReadonlyMap<string, string>> {
  const { stdout } = await run(
    exec, ["ip", "-j", "-4", "neigh", "show", "dev", bridge, "nud", "permanent"],
    AbortSignal.timeout(2_000),
  );
  const rows: unknown = JSON.parse(stdout);
  if (!Array.isArray(rows) || rows.length > 1024) throw new Error("invalid host network bindings");
  const bindings = new Map<string, string>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const { dst, lladdr, state } = row as { dst?: unknown; lladdr?: unknown; state?: unknown };
    if (typeof dst !== "string" || !isIPv4(dst) || typeof lladdr !== "string") continue;
    if (Array.isArray(state) && state.includes("PERMANENT")) bindings.set(dst, lladdr.toLowerCase());
  }
  return bindings;
}

async function vmUnitsOffline(exec: Exec, id: string): Promise<boolean> {
  const result = await exec(["systemctl", "is-active", `matrix-vm@${id}.service`, `matrix-vm-restore@${id}.service`], {
    signal: AbortSignal.timeout(2_000),
  });
  if (result.code === 0) return false;
  if (result.code !== 3 && result.code !== 4) throw new Error(`could not determine VM liveness (exit ${result.code})`);
  const states = result.stdout.trim().split(/\s+/);
  return states.length === 2 && states.every((state) => state === "inactive" || state === "failed" || state === "unknown");
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function startHostd(config: HostdConfig, overrides: HostdOverrides = {}): Promise<Hostd> {
  const log = overrides.log ?? defaultLog;
  const now = overrides.now ?? Date.now;
  const vmsDir = join(config.stateDir, "vms");
  const snapshotsDir = join(config.stateDir, "snapshots");
  const tls = { cert: await readFile(config.tlsCertPath), key: await readFile(config.tlsKeyPath) };
  const exec = overrides.exec ?? createExec();
  // Each call returns a new client: the lifecycle and the memory loop close theirs after each use.
  const ch = overrides.ch ?? ((id: string) => createChClient(join(config.runDir, id, "ch.sock")));
  const guest = overrides.guest ?? ((id: string) => createGuestClient(join(config.runDir, id, "vsock.sock")));
  const hostAvailableMiB = overrides.hostAvailableMiB ?? ((signal: AbortSignal) => readHostAvailableMiB(signal));
  const health = overrides.gatewayHealth ? null : createGatewayHealth();
  const gatewayHealth = overrides.gatewayHealth ?? health!.probe;
  const pool = { freeBytes: () => poolFreeBytes(snapshotsDir) };

  const store = createVmStore(vmsDir, { log });
  await reconcileVms({ store, exec, ch, snapshotsDir, log, now });

  const lifecycle = createVmLifecycle({
    store,
    exec,
    ch,
    pool,
    gatewayHealth,
    memoryBudgetMiB: overrides.memoryBudgetMiB ?? hostVmMemoryBudgetMiB,
    trim: (id, signal) => guest(id).trim(signal),
    log,
    config: {
      poolMaxDataPercent: config.poolMaxDataPercent,
      poolMaxMetadataPercent: config.poolMaxMetadataPercent,
      poolQueryTimeoutMs: config.poolQueryTimeoutMs,
      ...overrides.lifecycleConfig,
      vmsDir,
      snapshotsDir,
      runDir: config.runDir,
    },
  });

  const ingress = createIngress({
    store,
    hostAuthToken: config.ingressToken,
    readVmBindings: () => readVmBindings(exec, overrides.lifecycleConfig?.bridge ?? DEFAULT_LIFECYCLE_CONFIG.bridge),
    vmIsOffline: (id) => vmUnitsOffline(exec, id),
    tls,
    upstreamPort: overrides.ingressUpstreamPort,
    log,
    now,
  });

  const startedAt = now();
  const idleSeconds = (record: VmRecord) =>
    Math.max(0, (now() - (ingress.lastRequestAt(record.handle) ?? startedAt)) / 1000);

  const memory = createMemoryController({
    store,
    ch,
    guest,
    resize: (id, targetMiB) => lifecycle.resize(id, targetMiB),
    hostAvailableMiB,
    idleSeconds,
    intervalMs: overrides.memoryIntervalMs,
    log,
  });

  const app = createHostApi({ lifecycle, store, pool, hostAvailableMiB, apiToken: config.apiToken, log });
  const api = serve({
    fetch: app.fetch,
    createServer: createHttpsServer,
    serverOptions: { cert: tls.cert, key: tls.key, minVersion: "TLSv1.2" },
    port: config.apiPort,
    hostname: config.apiHost,
    autoCleanupIncoming: true,
  }) as Server;
  api.on("tlsClientError", (error) => log("api.tls_client_error", { error: error.name }));

  try {
    if (!api.listening) await new Promise<void>((resolve, reject) => {
      api.once("listening", resolve);
      api.once("error", reject);
    });
    await listen(ingress.server, config.ingressPort, config.ingressHost);
  } catch (error: unknown) {
    await ingress.close();
    await closeServer(api);
    await health?.close();
    throw error;
  }
  memory.start();
  log("hostd.started", { apiPort: config.apiPort, ingressPort: config.ingressPort });

  let closing: Promise<void> | null = null;
  // Stops accepting at once (server.close() refuses new connections
  // synchronously), then bounds the whole drain, memory loop included, by one
  // deadline that starts now: systemd kills hostd soon after it.
  async function shutdown(): Promise<void> {
    const drainMs = overrides.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), drainMs);
    });
    const listenersClosed = Promise.all([ingress.close(), closeServer(api)]);
    const work = (async () => {
      await Promise.all([memory.stop(), listenersClosed]);
      await lifecycle.idle();
      return true as const;
    })();
    // A drain that fails after the deadline won is still logged, not unhandled.
    work.then(undefined, (error: unknown) =>
      log("hostd.drain_failed", { error: error instanceof Error ? error.name : String(error) }),
    );
    const drained = await Promise.race([work, deadline]);
    clearTimeout(timer);
    if (!drained) log("hostd.drain_timeout", { timeoutMs: drainMs });
    await health?.close();
    log("hostd.stopped", { drained });
  }

  return {
    store,
    lifecycle,
    ingress,
    memory,
    api,
    idleSeconds,
    close() {
      closing ??= shutdown();
      return closing;
    },
  };
}

export interface MainProcess {
  once(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  exit(code: number): void;
}

interface MainOverrides extends HostdOverrides {
  directories?: Pick<HostdConfig, "stateDir" | "runDir">;
}

// Entry point: config from the environment, then drain on SIGTERM/SIGINT.
export async function main(env: Record<string, string | undefined>, proc: MainProcess, overrides: MainOverrides = {}): Promise<Hostd> {
  const log = overrides.log ?? defaultLog;
  const hostd = await startHostd({ ...loadConfig(env), ...overrides.directories }, overrides);
  const stop = () => {
    hostd.close().then(
      () => proc.exit(0),
      (error: unknown) => {
        log("hostd.shutdown_failed", { error: error instanceof Error ? error.name : String(error) });
        proc.exit(1);
      },
    );
  };
  proc.once("SIGTERM", stop);
  proc.once("SIGINT", stop);
  return hostd;
}

// Starts hostd; a startup failure (bad config, port in use) logs the error
// name and the offending config keys, never values, and exits 1.
export function runMain(
  env: Record<string, string | undefined>,
  proc: MainProcess,
  overrides: HostdOverrides = {},
): Promise<Hostd | undefined> {
  const log = overrides.log ?? defaultLog;
  return main(env, proc, overrides).catch((error: unknown) => {
    log("hostd.start_failed", {
      error: error instanceof Error ? error.name : String(error),
      keys: (error as { keys?: unknown } | null)?.keys,
    });
    proc.exit(1);
    return undefined;
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) void runMain(process.env, process);
