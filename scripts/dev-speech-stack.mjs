#!/usr/bin/env node

import { spawn } from "node:child_process";

const PRIVATE_SPEECH_ENV = [
  "PLATFORM_SPEECH_OPENAI_API_KEY",
  "PLATFORM_SPEECH_SECRET",
];
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };
const activeGroups = new Map();
const stopRequest = Promise.withResolvers();
let requestedStop;
let terminating;

function withoutSpeechSecrets(env) {
  const isolated = { ...env };
  // Keep the names defined with empty values. Node's process.loadEnvFile() and
  // Next's env loader both preserve existing process variables, so neither the
  // gateway's repository-root .env nor shell-local .env files can repopulate
  // platform-only speech credentials after this boundary.
  for (const name of PRIVATE_SPEECH_ENV) isolated[name] = "";
  return isolated;
}

function terminationGraceMs() {
  const parsed = Number(process.env.MATRIX_SPEECH_STACK_TERMINATION_GRACE_MS ?? 2_000);
  return Number.isSafeInteger(parsed) && parsed >= 50 && parsed <= 10_000 ? parsed : 2_000;
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function terminateAll() {
  if (terminating) return terminating;
  terminating = (async () => {
    const groups = [...activeGroups.entries()];
    for (const [pid] of groups) signalGroup(pid, "SIGTERM");
    await Promise.race([
      Promise.allSettled(groups.map(([, child]) => waitForClose(child))),
      new Promise((resolve) => setTimeout(resolve, terminationGraceMs())),
    ]);
    // A package-manager parent can exit before tsx/Next descendants. Address
    // the process group again so those descendants cannot outlive the stack.
    for (const [pid] of groups) signalGroup(pid, "SIGKILL");
    await Promise.allSettled(groups.map(([, child]) => waitForClose(child)));
    activeGroups.clear();
  })();
  return terminating;
}

function spawnTask(args, env) {
  const child = spawn("pnpm", args, {
    detached: true,
    env,
    stdio: "inherit",
  });
  if (child.pid === undefined) throw new Error("Failed to start pnpm");
  activeGroups.set(child.pid, child);
  return child;
}

function resultExitCode(result) {
  if (result.code !== null) return result.code;
  if (result.signal === "SIGINT" || result.signal === "SIGTERM") {
    return SIGNAL_EXIT_CODES[result.signal];
  }
  return 1;
}

function requestStop(signal) {
  if (requestedStop) return;
  requestedStop = { code: SIGNAL_EXIT_CODES[signal] };
  stopRequest.resolve(requestedStop);
}

process.once("SIGINT", () => requestStop("SIGINT"));
process.once("SIGTERM", () => requestStop("SIGTERM"));

async function run() {
  if (process.env.PLATFORM_SPEECH_ENABLED !== "true") {
    console.error("PLATFORM_SPEECH_ENABLED=true is required; see docs/dev/platform-speech-local.md");
    return 1;
  }

  const isolatedEnv = withoutSpeechSecrets(process.env);
  const build = spawnTask([
    "--filter", "@matrix-os/observability",
    "--filter", "@matrix-os/brand",
    "--filter", "@matrix-os/kernel",
    "build",
  ], isolatedEnv);
  const buildResult = await Promise.race([waitForClose(build), stopRequest.promise]);
  if ("code" in buildResult && requestedStop) {
    await terminateAll();
    return requestedStop.code;
  }
  const buildExitCode = resultExitCode(buildResult);
  if (buildExitCode !== 0) {
    await terminateAll();
    return buildExitCode;
  }
  // A completed package-manager command should not have long-lived children.
  // Close its now-orphaned process group before forgetting the PID.
  signalGroup(build.pid, "SIGTERM");
  signalGroup(build.pid, "SIGKILL");
  activeGroups.delete(build.pid);
  if (requestedStop) {
    await terminateAll();
    return requestedStop.code;
  }

  const gatewayPort = process.env.MATRIX_SPEECH_GATEWAY_PORT ?? process.env.PORT ?? "4000";
  const shellPort = process.env.MATRIX_SPEECH_SHELL_PORT ?? process.env.SHELL_PORT ?? "3000";
  const platform = spawnTask(["--filter", "@matrix-os/platform", "dev"], process.env);
  const gateway = spawnTask(["--filter", "@matrix-os/gateway", "dev"], {
    ...isolatedEnv,
    PORT: gatewayPort,
    SHELL_PORT: shellPort,
  });
  const shell = spawnTask(["--filter", "./shell", "dev"], {
    ...isolatedEnv,
    PORT: shellPort,
  });

  const first = await Promise.race([
    ...[platform, gateway, shell].map(async (child) => ({
      type: "child",
      result: await waitForClose(child),
    })),
    stopRequest.promise.then((request) => ({ type: "stop", request })),
  ]);
  const exitCode = first.type === "stop" ? first.request.code : resultExitCode(first.result);
  await terminateAll();
  return exitCode;
}

try {
  process.exitCode = await run();
} catch (error) {
  console.error("Speech stack launcher failed:", error instanceof Error ? error.message : String(error));
  await terminateAll();
  process.exitCode = requestedStop?.code ?? 1;
}
