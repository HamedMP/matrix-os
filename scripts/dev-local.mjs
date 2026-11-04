#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { runCommand as run } from "./local-production-parity/commands.mjs";
import { spawnServices } from "./source-processes.mjs";

const COMPOSE = [
  "docker",
  "compose",
  "-f",
  "docker-compose.dev.yml",
];
const STARTUP_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_000;

export const LOCAL_DEVELOPMENT_SERVICES = [
  "@matrix-os/gateway",
  "@matrix-os/proxy",
  "@matrix-os/platform",
  "./shell",
];

export const localServiceProcesses = [
  {
    name: "kernel-build",
    cwd: "packages/kernel",
    args: [
      "../../node_modules/tsx/dist/cli.mjs", "watch", "--clear-screen=false",
      "--include", "src/**/*", "--include", "tsconfig.json", "--include", "../../tsconfig.json",
      "--exclude", "dist/**",
      "../../scripts/build-typescript.mjs",
    ],
  },
  { name: "gateway", args: ["node_modules/tsx/dist/cli.mjs", "watch", "--clear-screen=false", "packages/gateway/src/main.ts"] },
  { name: "proxy", args: ["node_modules/tsx/dist/cli.mjs", "watch", "--clear-screen=false", "packages/proxy/src/main.ts"] },
  { name: "platform", args: ["node_modules/tsx/dist/cli.mjs", "watch", "--clear-screen=false", "packages/platform/src/main.ts"] },
  {
    name: "shell",
    args: [
      "shell/node_modules/next/dist/bin/next",
      "dev",
      "shell",
      "--webpack",
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
    // Managed E2E mode retains Clerk context for Files and shared views.
    MATRIX_SELF_HOSTED: "0",
    MATRIX_HOME_MIRROR: "true",
  };
}

export { run as runLocalDevelopmentCommand };

async function commandSucceeds(command, options) {
  try {
    await options.runCommand(command[0], command.slice(1), { ...options, stdio: "ignore" });
    return true;
  } catch (error) {
    options.signal?.throwIfAborted();
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

async function isHttpHealthy(url, cancellationSignal, timeoutMs) {
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.any([cancellationSignal, AbortSignal.timeout(Math.min(3_000, timeoutMs))]),
    });
    return response.ok;
  } catch (error) {
    if (cancellationSignal.aborted) throw cancellationSignal.reason;
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

async function waitUntilHealthy(name, check, cancellationSignal, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    cancellationSignal.throwIfAborted();
    if (await check({ signal: cancellationSignal, timeoutMs: Math.max(1, Math.min(5_000, deadline - Date.now())) })) return;
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(POLL_INTERVAL_MS, remaining), undefined, { signal: cancellationSignal });
  }
  throw new Error(`${name} did not become healthy within ${timeoutMs / 1_000} seconds`);
}

async function waitForHttpChecks(checks, cancellationSignal) {
  await Promise.all(checks.map(([name, url]) => (
    waitUntilHealthy(name, ({ timeoutMs }) => isHttpHealthy(url, cancellationSignal, timeoutMs), cancellationSignal)
  )));
}

export async function startLocalInfrastructure({
  cancellationSignal = new AbortController().signal,
  runCommand = run,
  postgresReady = (options) => commandSucceeds(localInfrastructureCommands.verifyPostgres, { ...options, runCommand }),
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
  waitForHttp = waitForHttpChecks,
  log = console.log,
} = {}) {
  await runCommand(localInfrastructureCommands.start[0], localInfrastructureCommands.start.slice(1),
    { signal: cancellationSignal, timeoutMs: startupTimeoutMs });
  await Promise.all([
    waitForHttp(infrastructureChecks, cancellationSignal),
    waitUntilHealthy("PostgreSQL", postgresReady, cancellationSignal, startupTimeoutMs),
  ]);
  await runCommand(
    localInfrastructureCommands.setObjectStoreAlias[0],
    localInfrastructureCommands.setObjectStoreAlias.slice(1),
    { signal: cancellationSignal },
  );
  await runCommand(
    localInfrastructureCommands.configureObjectStore[0],
    localInfrastructureCommands.configureObjectStore.slice(1),
    { signal: cancellationSignal },
  );
  log("Local infrastructure ready: PostgreSQL :5432, object storage :9100/:9101");
}

export async function startLocalDevelopment({
  cancellationController = new AbortController(),
  startInfrastructure = startLocalInfrastructure,
  runCommand = run,
  startServices = (env) => spawnServices(localServiceProcesses, env),
  waitForHttp = waitForHttpChecks,
  log = console.log,
} = {}) {
  const signal = cancellationController.signal;
  let services;
  let stoppedBySignal = false;
  const stop = (receivedSignal) => {
    stoppedBySignal = true;
    cancellationController.abort(new Error(`local development stopped by ${receivedSignal}`));
  };
  const signalHandlers = new Map([
    ["SIGINT", () => stop("SIGINT")],
    ["SIGTERM", () => stop("SIGTERM")],
  ]);
  for (const [name, handler] of signalHandlers) process.on(name, handler);
  let onAbort;
  const cancelled = new Promise((resolve) => {
    onAbort = resolve;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    signal.throwIfAborted();
    await startInfrastructure({ cancellationSignal: signal, log });
    const env = createLocalDevelopmentEnv();
    const options = { env, signal, timeoutMs: 600_000 };
    await runCommand(
      localInfrastructureCommands.stopApplicationContainers[0],
      localInfrastructureCommands.stopApplicationContainers.slice(1),
      { signal },
    );
    await runCommand("pnpm", ["--filter", "@matrix-os/gateway", "build:native"], options);
    await runCommand(buildCommand[0], buildCommand.slice(1), options);
    // Configured platform integrations consume the emitted gateway modules.
    await runCommand("pnpm", ["--filter", "@matrix-os/gateway", "build"], options);
    signal.throwIfAborted();
    services = startServices(env);
    const interrupted = cancelled.then(() => { throw signal.reason; });
    await Promise.race([
      waitForHttp(serviceChecks, signal),
      interrupted,
      services.exited.then((status) => {
        throw new Error(
          `${status.name} (pid ${status.pid ?? "unknown"}) stopped before local development became ready`,
        );
      }),
    ]);
    log("Matrix OS ready: shell :3000, gateway :4000, proxy :8080, platform :9000");
    const status = await Promise.race([services.exited, interrupted]);
    if (!stoppedBySignal) {
      throw new Error(`${status.name} (pid ${status.pid ?? "unknown"}) stopped unexpectedly`);
    }
  } catch (error) {
    if (!signal.aborted) cancellationController.abort(error);
    await services?.stop("SIGTERM");
    if (stoppedBySignal) return;
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    for (const [name, handler] of signalHandlers) process.off(name, handler);
  }
}

async function withInfrastructureSignals(action) {
  const controller = new AbortController();
  const handlers = ["SIGINT", "SIGTERM"].map((signal) => [
    signal, () => controller.abort(new Error(`local infrastructure stopped by ${signal}`)),
  ]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try { await action(controller.signal); }
  finally { for (const [signal, handler] of handlers) process.off(signal, handler); }
}

async function main() {
  const mode = process.argv[2] ?? "full";
  if (mode === "infra") {
    await withInfrastructureSignals((signal) => startLocalInfrastructure({ cancellationSignal: signal }));
    return;
  }
  if (mode === "stop") {
    await withInfrastructureSignals((signal) => run(
      localInfrastructureCommands.stop[0], localInfrastructureCommands.stop.slice(1), { signal },
    ));
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
