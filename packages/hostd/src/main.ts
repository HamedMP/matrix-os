import { readFile, statfs } from "node:fs/promises";
import { createServer as createHttpsServer, type Server } from "node:https";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Agent, request } from "undici";
import { createHostApi } from "./api.js";
import { createChClient, type ChClient } from "./ch-client.js";
import { loadConfig, type HostdConfig } from "./config.js";
import { createExec, type Exec } from "./exec.js";
import { createGuestClient, type GuestClient } from "./guest-client.js";
import { createIngress, type Ingress } from "./ingress.js";
import { createMemoryController, readHostAvailableMiB, type MemoryController } from "./memory-controller.js";
import { reconcileVms } from "./reconcile.js";
import { createVmLifecycle, type LifecycleConfig, type VmLifecycle } from "./vm-lifecycle.js";
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
    trim: (id, signal) => guest(id).trim(signal),
    log,
    config: { ...overrides.lifecycleConfig, vmsDir, snapshotsDir, runDir: config.runDir },
  });

  const ingress = createIngress({
    store,
    hostAuthToken: config.ingressToken,
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
  async function shutdown(): Promise<void> {
    await memory.stop();
    await ingress.close();
    await closeServer(api);
    const drainMs = overrides.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      lifecycle.idle().then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), drainMs);
      }),
    ]);
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

// Entry point: config from the environment, then drain on SIGTERM/SIGINT.
export async function main(env: Record<string, string | undefined>, proc: MainProcess, overrides: HostdOverrides = {}): Promise<Hostd> {
  const log = overrides.log ?? defaultLog;
  const hostd = await startHostd(loadConfig(env), overrides);
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
