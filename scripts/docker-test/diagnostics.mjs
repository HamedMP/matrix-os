#!/usr/bin/env node
// Preserve bounded Docker failure evidence before the scenario removes containers.
import { spawnSync } from "node:child_process";
import { constants, closeSync, fchmodSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [composeFile, overrideFile, service, directory, scenario] = process.argv.slice(2);
// Fixed scenario names keep filenames safe and retained artifacts bounded.
const scenarios = ["fresh-install", "upgrade", "customized-files", "multi-user", "channels", "recovery", "resource-limits"];
const scenarioPrefix = scenario === undefined ? "" : `${scenario}-`;
const limit = 256 * 1024;
const compose = ["compose", "-f", composeFile];
if (overrideFile) compose.push("-f", overrideFile);

function capture(args) {
  const result = spawnSync("docker", args, {
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  const header = Buffer.from(`exit=${result.status ?? "unavailable"} signal=${result.signal ?? "none"} error=${result.error?.code ?? "none"}\n`);
  const output = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]);
  const available = limit - header.length;
  if (output.length <= available) return Buffer.concat([header, output]);
  const marker = Buffer.from("\n[bounded Docker output truncated]\n");
  const half = Math.floor((available - marker.length) / 2);
  return Buffer.concat([header, output.subarray(0, half), marker, output.subarray(output.length - half)]);
}

function save(name, body) {
  const descriptor = openSync(join(directory, `pre-cleanup-${scenarioPrefix}${service}-${name}.log`), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, body);
  } finally {
    closeSync(descriptor);
  }
}

try {
  if (!composeFile || !directory || (scenario !== undefined && !scenarios.includes(scenario)) || !/^[a-z][a-z0-9-]{0,63}$/.test(service ?? "")) throw new Error("Invalid diagnostics arguments");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Invalid diagnostics directory");
  save("compose", capture([...compose, "logs", "--no-color", "--tail", "200", service]));
  save("containers", capture([...compose, "ps", "--all", "--format", "json", service]));
  const ids = capture([...compose, "ps", "--all", "--quiet", service]).toString().split("\n").filter((id) => /^[a-f0-9]{12,64}$/.test(id)).slice(0, 10);
  // State-only inspection deliberately excludes Config.Env, mounts and auth.
  save("state", ids.length ? capture(["inspect", "--format", "{{json .State}}", ...ids]) : Buffer.from("No container available for inspection\n"));
  console.log(`[DIAGNOSTICS] Preserved bounded ${service} logs and state before cleanup`);
} catch (error) {
  console.error(`[DIAGNOSTICS] Could not preserve Docker diagnostics (${error?.code ?? "invalid output"})`);
  process.exitCode = 1;
}
