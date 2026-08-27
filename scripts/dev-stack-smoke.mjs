#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
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

export const DOCKER_FULL_STACK_SERVICES = [
  "shell",
  "gateway",
  "proxy",
  "platform",
  "postgres",
  "minio",
  "conduit",
];

export const dockerFullStackCommands = {
  start: [...COMPOSE, "up", "--detach", "--build"],
  cleanup: [...COMPOSE, "down", "--remove-orphans"],
};

const httpChecks = [
  ["shell", "http://127.0.0.1:3000/"],
  ["gateway", "http://127.0.0.1:4000/health"],
  ["proxy", "http://127.0.0.1:8080/health"],
  ["platform", "http://127.0.0.1:9000/health"],
  ["minio", "http://127.0.0.1:9100/minio/health/live"],
  ["conduit", "http://127.0.0.1:6167/_matrix/client/versions"],
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

async function isHttpHealthy(url) {
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

async function waitForHttp(name, url, deadline) {
  while (Date.now() < deadline) {
    if (await isHttpHealthy(url)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`${name} did not become healthy before the smoke timeout`);
}

async function verifyPostgres() {
  await run(COMPOSE[0], [
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

export async function smokeDockerFullStack() {
  try {
    await access(".env.docker");
  } catch (error) {
    throw new Error(".env.docker is required; copy .env.docker.example before running the smoke", {
      cause: error,
    });
  }
  let startAttempted = false;
  try {
    startAttempted = true;
    await run(dockerFullStackCommands.start[0], dockerFullStackCommands.start.slice(1));
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    await Promise.all(httpChecks.map(([name, url]) => waitForHttp(name, url, deadline)));
    await verifyPostgres();
    console.log(`Docker full-stack smoke passed: ${DOCKER_FULL_STACK_SERVICES.join(", ")}`);
  } finally {
    if (startAttempted) {
      await run(dockerFullStackCommands.cleanup[0], dockerFullStackCommands.cleanup.slice(1));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => activeChild?.kill(signal));
  }
  smokeDockerFullStack().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown failure";
    console.error(`Docker full-stack smoke failed: ${message}`);
    process.exitCode = 1;
  });
}
