#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const COMPOSE = [
  "docker",
  "compose",
  "--env-file",
  ".env.docker",
  "-f",
  "docker-compose.dev.yml",
  "--profile",
  "full",
];
const STARTUP_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_000;
let activeChild;
let cleanupInProgress = false;

export function createSmokeCancellation(getActiveChild, isCleanupInProgress) {
  const controller = new AbortController();
  let handled = false;
  return {
    signal: controller.signal,
    handleSignal(signal) {
      if (handled) return;
      handled = true;
      controller.abort(new Error(`smoke canceled by ${signal}`));
      if (!isCleanupInProgress()) getActiveChild()?.kill(signal);
    },
  };
}

export function installSmokeSignalHandlers(signalTarget, cancellation) {
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => cancellation.handleSignal(signal);
    handlers.set(signal, handler);
    signalTarget.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) signalTarget.off(signal, handler);
  };
}

const smokeCancellation = createSmokeCancellation(
  () => activeChild,
  () => cleanupInProgress,
);

export const DOCKER_FULL_STACK_SERVICES = [
  "shell",
  "gateway",
  "proxy",
  "platform",
  "postgres",
  "minio",
];

export const dockerFullStackCommands = {
  prepare: ["docker", "volume", "create", "matrixos-ai-auth"],
  start: [...COMPOSE, "up", "--detach", "--build"],
  cleanup: [...COMPOSE, "down", "--remove-orphans"],
};

const httpChecks = [
  ["shell", "http://127.0.0.1:3000/"],
  ["gateway", "http://127.0.0.1:4000/health"],
  ["proxy", "http://127.0.0.1:8080/health"],
  ["platform", "http://127.0.0.1:9000/health"],
  ["minio", "http://127.0.0.1:9100/minio/health/live"],
];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    activeChild = child;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      activeChild = undefined;
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
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

async function waitForHttp(name, url, deadline, cancellationSignal) {
  while (Date.now() < deadline) {
    cancellationSignal.throwIfAborted();
    if (await isHttpHealthy(url, cancellationSignal)) return;
    await delay(POLL_INTERVAL_MS, undefined, { signal: cancellationSignal });
  }
  throw new Error(`${name} did not become healthy before the smoke timeout`);
}

async function waitForServices(cancellationSignal) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  await Promise.all(
    httpChecks.map(([name, url]) => waitForHttp(name, url, deadline, cancellationSignal)),
  );
}

async function verifyPostgres(runCommand = run) {
  await runCommand(COMPOSE[0], [
    ...COMPOSE.slice(1),
    "exec",
    "-T",
    "postgres",
    "pg_isready",
    "-U",
    "matrixos",
    "-d",
    "matrixos_platform",
  ]);
}

export async function smokeDockerFullStack({
  cancellationSignal = smokeCancellation.signal,
  accessEnv = () => access(".env.docker"),
  runCommand = run,
  waitForServices: waitForServicesDependency = waitForServices,
  verifyDatabase = () => verifyPostgres(runCommand),
  log = console.log,
} = {}) {
  try {
    await accessEnv();
  } catch (error) {
    throw new Error(".env.docker is required; copy .env.docker.example before running the smoke", {
      cause: error,
    });
  }
  await runCommand(
    dockerFullStackCommands.prepare[0],
    dockerFullStackCommands.prepare.slice(1),
  );
  let startAttempted = false;
  try {
    startAttempted = true;
    await runCommand(dockerFullStackCommands.start[0], dockerFullStackCommands.start.slice(1));
    await waitForServicesDependency(cancellationSignal);
    await verifyDatabase();
    log(`Docker full-stack smoke passed: ${DOCKER_FULL_STACK_SERVICES.join(", ")}`);
  } finally {
    if (startAttempted) {
      cleanupInProgress = true;
      try {
        await runCommand(
          dockerFullStackCommands.cleanup[0],
          dockerFullStackCommands.cleanup.slice(1),
        );
      } finally {
        cleanupInProgress = false;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const removeSignalHandlers = installSmokeSignalHandlers(process, smokeCancellation);
  smokeDockerFullStack()
    .catch((error) => {
      const message = error instanceof Error ? error.message : "unknown failure";
      console.error(`Docker full-stack smoke failed: ${message}`);
      process.exitCode = 1;
    })
    .finally(removeSignalHandlers);
}
