#!/usr/bin/env node

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const COMPOSE = [
  "docker",
  "compose",
  "-f",
  "docker-compose.dev.yml",
];
const STARTUP_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

export const LOCAL_DEVELOPMENT_SERVICES = [
  "@matrix-os/gateway",
  "@matrix-os/proxy",
  "@matrix-os/platform",
  "./shell",
];

const localServiceProcesses = [
  { name: "gateway", args: ["--import=tsx", "--watch", "packages/gateway/src/main.ts"] },
  { name: "proxy", args: ["--import=tsx", "--watch", "packages/proxy/src/main.ts"] },
  { name: "platform", args: ["--import=tsx", "--watch", "packages/platform/src/main.ts"] },
  {
    name: "shell",
    args: [
      "shell/node_modules/next/dist/bin/next",
      "dev",
      "shell",
      "-H",
      "127.0.0.1",
      "-p",
      "3000",
    ],
  },
];

export const localInfrastructureCommands = {
  start: [...COMPOSE, "up", "--detach", "postgres", "minio"],
  stop: [...COMPOSE, "stop", "postgres", "minio"],
  stopApplicationContainers: [...COMPOSE, "stop", "dev", "proxy", "platform"],
  setObjectStoreAlias: [...COMPOSE, "run", "--rm", "--no-deps", "minio-alias"],
  configureObjectStore: [...COMPOSE, "run", "--rm", "--no-deps", "minio-init"],
  verifyPostgres: [
    ...COMPOSE,
    "exec",
    "-T",
    "postgres",
    "pg_isready",
    "-U",
    "matrixos",
    "-d",
    "matrixos_platform",
  ],
};

const buildCommand = [
  "pnpm",
  "--filter",
  "@matrix-os/observability",
  "--filter",
  "@matrix-os/brand",
  "--filter",
  "@matrix-os/terminal-runtime",
  "--filter",
  "@matrix-os/kernel",
  "build",
];

const infrastructureChecks = [
  ["object storage", "http://127.0.0.1:9100/minio/health/live"],
];

const serviceChecks = [
  ["shell", "http://127.0.0.1:3000/"],
  ["gateway", "http://127.0.0.1:4000/health"],
  ["proxy", "http://127.0.0.1:8080/health"],
  ["platform", "http://127.0.0.1:9000/health"],
];

export function createLocalDevelopmentEnv(baseEnv = process.env) {
  const { PORT: _ignoredPort, ...env } = baseEnv;
  const home = baseEnv.HOME ?? baseEnv.USERPROFILE ?? homedir();
  return {
    ...env,
    MATRIX_HOME: baseEnv.MATRIX_HOME ?? join(home, "matrixos"),
    MATRIX_HANDLE: baseEnv.MATRIX_HANDLE?.trim() || "dev",
    MATRIX_DISPLAY_NAME: baseEnv.MATRIX_DISPLAY_NAME ?? "Developer",
    DATABASE_URL: "postgresql://matrixos:matrixos@127.0.0.1:5432/matrixos",
    PLATFORM_DATABASE_URL: "postgresql://matrixos:matrixos@127.0.0.1:5432/matrixos_platform",
    PLATFORM_INTERNAL_URL: "http://127.0.0.1:9000",
    PLATFORM_PUBLIC_URL: "http://127.0.0.1:9000",
    PLATFORM_SECRET: baseEnv.PLATFORM_SECRET ?? "dev-secret",
    PLATFORM_JWT_SECRET: baseEnv.PLATFORM_JWT_SECRET ?? "dev-platform-jwt-secret-please-change-32",
    MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: "true",
    GATEWAY_URL_TEMPLATE: "http://127.0.0.1:4000",
    GATEWAY_URL: "http://127.0.0.1:4000",
    NEXT_PUBLIC_GATEWAY_URL: "http://127.0.0.1:4000",
    NEXT_PUBLIC_GATEWAY_WS: "ws://127.0.0.1:4000/ws",
    MATRIX_BIND_HOST: "127.0.0.1",
    S3_ENDPOINT: "http://127.0.0.1:9100",
    S3_PUBLIC_ENDPOINT: "http://127.0.0.1:9100",
    S3_ACCESS_KEY_ID: "matrixos",
    S3_SECRET_ACCESS_KEY: "matrixos123",
    S3_BUCKET: "matrixos-sync",
    S3_FORCE_PATH_STYLE: "true",
    E2E_TEST_BYPASS: "1",
    NEXT_PUBLIC_E2E_TEST_BYPASS: "1",
    MATRIX_AUTH_ALLOW_INSECURE_DEV: "1",
    MATRIX_DEV_APP_AUTH_BYPASS: "1",
    MATRIX_SELF_HOSTED: "1",
    MATRIX_HOME_MIRROR: "true",
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: options.stdio ?? "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}

async function commandSucceeds(command) {
  try {
    await run(command[0], command.slice(1), { stdio: "ignore" });
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

async function isHttpHealthy(url, cancellationSignal) {
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.any([cancellationSignal, AbortSignal.timeout(3_000)]),
    });
    return response.ok;
  } catch (error) {
    if (cancellationSignal.aborted) throw cancellationSignal.reason;
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

async function waitUntilHealthy(name, check, cancellationSignal) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    cancellationSignal.throwIfAborted();
    if (await check()) return;
    await delay(POLL_INTERVAL_MS, undefined, { signal: cancellationSignal });
  }
  throw new Error(`${name} did not become healthy within ${STARTUP_TIMEOUT_MS / 1_000} seconds`);
}

async function waitForHttpChecks(checks, cancellationSignal) {
  await Promise.all(checks.map(([name, url]) => (
    waitUntilHealthy(name, () => isHttpHealthy(url, cancellationSignal), cancellationSignal)
  )));
}

export async function startLocalInfrastructure({
  cancellationSignal = new AbortController().signal,
  runCommand = run,
  postgresReady = () => commandSucceeds(localInfrastructureCommands.verifyPostgres),
  waitForHttp = waitForHttpChecks,
  log = console.log,
} = {}) {
  await runCommand(localInfrastructureCommands.start[0], localInfrastructureCommands.start.slice(1));
  await Promise.all([
    waitForHttp(infrastructureChecks, cancellationSignal),
    waitUntilHealthy("PostgreSQL", postgresReady, cancellationSignal),
  ]);
  await runCommand(
    localInfrastructureCommands.setObjectStoreAlias[0],
    localInfrastructureCommands.setObjectStoreAlias.slice(1),
  );
  await runCommand(
    localInfrastructureCommands.configureObjectStore[0],
    localInfrastructureCommands.configureObjectStore.slice(1),
  );
  log("Local infrastructure ready: PostgreSQL :5432, object storage :9100/:9101");
}

function spawnServices(env) {
  const children = localServiceProcesses.map((service) => ({
    name: service.name,
    child: spawn(process.execPath, service.args, {
      detached: process.platform !== "win32",
      env,
      stdio: "inherit",
    }),
  }));
  const completions = children.map(({ name, child }) => new Promise((resolve) => {
    child.once("error", (error) => resolve({ name, pid: child.pid, error }));
    child.once("exit", (code, signal) => resolve({ name, pid: child.pid, code, signal }));
  }));
  const signalChildren = (signal) => {
    for (const { child } of children) {
      if (child.pid === undefined) continue;
      if (process.platform === "win32") {
        if (child.exitCode === null && !child.killed) child.kill(signal);
        continue;
      }
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
          console.warn(`[local-dev] failed to stop process group ${child.pid}:`, error);
        }
      }
    }
  };
  const allExited = Promise.all(completions);
  const exited = Promise.race(completions).then((status) => {
    if ("error" in status) {
      throw new Error(`${status.name} failed to start${status.pid ? ` (pid ${status.pid})` : ""}: ${status.error.message}`);
    }
    if (status.code === 0 || status.signal === "SIGINT" || status.signal === "SIGTERM") return status;
    throw new Error(
      `${status.name} (pid ${status.pid ?? "unknown"}) exited with ${status.code ?? status.signal ?? "unknown status"}`,
    );
  });
  let stopPromise;
  const stop = (signal) => {
    stopPromise ??= (async () => {
      signalChildren(signal);
      const stopped = await Promise.race([
        allExited.then(() => true),
        delay(SHUTDOWN_TIMEOUT_MS).then(() => false),
      ]);
      if (stopped) return;

      signalChildren("SIGKILL");
      const killed = await Promise.race([
        allExited.then(() => true),
        delay(1_000).then(() => false),
      ]);
      if (!killed) throw new Error("local services did not stop after SIGKILL");
    })();
    return stopPromise;
  };
  return { exited, stop };
}

export async function startLocalDevelopment({
  cancellationController = new AbortController(),
  startInfrastructure = startLocalInfrastructure,
  runCommand = run,
  startServices = spawnServices,
  waitForHttp = waitForHttpChecks,
  log = console.log,
} = {}) {
  const signal = cancellationController.signal;
  await startInfrastructure({ cancellationSignal: signal, log });
  const env = createLocalDevelopmentEnv();
  await runCommand(
    localInfrastructureCommands.stopApplicationContainers[0],
    localInfrastructureCommands.stopApplicationContainers.slice(1),
  );
  await runCommand(buildCommand[0], buildCommand.slice(1), { env });
  const services = startServices(env);
  let stoppedBySignal = false;
  const stop = (receivedSignal) => {
    stoppedBySignal = true;
    cancellationController.abort(new Error(`local development stopped by ${receivedSignal}`));
    void services.stop(receivedSignal);
  };
  const signalHandlers = new Map([
    ["SIGINT", () => stop("SIGINT")],
    ["SIGTERM", () => stop("SIGTERM")],
  ]);
  for (const [name, handler] of signalHandlers) process.on(name, handler);

  try {
    await Promise.race([
      waitForHttp(serviceChecks, signal),
      services.exited.then((status) => {
        throw new Error(
          `${status.name} (pid ${status.pid ?? "unknown"}) stopped before local development became ready`,
        );
      }),
    ]);
    log("Matrix OS ready: shell :3000, gateway :4000, proxy :8080, platform :9000");
    const status = await services.exited;
    if (!stoppedBySignal) {
      throw new Error(`${status.name} (pid ${status.pid ?? "unknown"}) stopped unexpectedly`);
    }
  } catch (error) {
    if (!signal.aborted) cancellationController.abort(error);
    await services.stop("SIGTERM");
    if (stoppedBySignal) return;
    throw error;
  } finally {
    for (const [name, handler] of signalHandlers) process.off(name, handler);
  }
}

async function main() {
  const mode = process.argv[2] ?? "full";
  if (mode === "infra") {
    await startLocalInfrastructure();
    return;
  }
  if (mode === "stop") {
    await run(localInfrastructureCommands.stop[0], localInfrastructureCommands.stop.slice(1));
    return;
  }
  if (mode === "full") {
    try {
      process.loadEnvFile();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await startLocalDevelopment();
    return;
  }
  throw new Error(`unknown local development mode: ${mode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Local development failed: ${message}`);
    process.exitCode = 1;
  });
}
