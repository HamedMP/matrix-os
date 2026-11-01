import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  root, machineName, runtimeDirectory, runtimeDiskPath, runtimeSeedPath,
  runtimePidPath, runtimeLogPath,
} from "./config.mjs";
const executeFile = promisify(execFile);

function ownsRuntimeCommand(command, diskPath) {
  const escaped = diskPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return /^(?:\S*\/)?qemu-system-x86_64\s/.test(command)
    && new RegExp(`(?:^|[\\s,])file=${escaped}(?=,|\\s+-|$)`).test(command);
}

export function readRuntimePid() {
  if (!existsSync(runtimePidPath)) return null;
  const pid = Number(readFileSync(runtimePidPath, "utf8").trim());
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

export function runtimeProcessIsOwned(options = {}) {
  const pid = options.pid ?? readRuntimePid();
  const diskPath = options.diskPath ?? runtimeDiskPath;
  const processCommand = options.processCommand ?? ((candidatePid) => {
    const result = spawnSync("ps", ["-p", String(candidatePid), "-o", "command="], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
    return result.status === 0 ? result.stdout.trim() : "";
  });
  return pid !== null && ownsRuntimeCommand(processCommand(pid), diskPath);
}

export function runtimeProcessPids(options = {}) {
  const diskPath = options.diskPath ?? runtimeDiskPath;
  const processList = options.processList ?? (() => {
    const result = spawnSync("ps", ["-axo", "pid=,command="], { cwd: root, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0) throw new Error(`ps -axo pid=,command= failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
  });
  return processList().split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match || !ownsRuntimeCommand(match[2], diskPath)) return [];
    return [Number(match[1])];
  });
}

export function qemuRuntimeArguments(options = {}) {
  const diskPath = options.diskPath ?? runtimeDiskPath;
  const seedPath = options.seedPath ?? runtimeSeedPath;
  const logPath = options.logPath ?? runtimeLogPath;
  return [
    "-name", machineName,
    "-machine", "q35,accel=tcg",
    "-cpu", "max",
    "-smp", "2",
    "-m", "4096",
    "-display", "none",
    "-serial", `file:${logPath}`,
    "-drive", `if=virtio,format=qcow2,file=${diskPath}`,
    "-drive", `if=virtio,format=raw,readonly=on,file=${seedPath}`,
    "-netdev", "user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22,hostfwd=tcp:127.0.0.1:8443-:443",
    "-device", "virtio-net-pci,netdev=net0,mac=52:54:00:4d:58:01",
  ];
}

export function startQemuRuntime() {
  const output = openSync(resolve(runtimeDirectory, "qemu.log"), "a");
  let child;
  try {
    // Use the installed executable so QEMU can locate its firmware.
    const result = spawnSync("which", ["qemu-system-x86_64"], { cwd: root, encoding: "utf8", timeout: 5000 });
    if (result.status !== 0) throw new Error("qemu-system-x86_64 is required");
    child = spawn(result.stdout.trim(), qemuRuntimeArguments(), {
      cwd: root, detached: true, stdio: ["ignore", output, output],
    });
  } finally { closeSync(output); }
  if (!child.pid) throw new Error("QEMU did not return a process id");
  writeFileSync(runtimePidPath, `${child.pid}\n`, { mode: 0o600 });
  child.unref();
}

export async function stopQemuRuntime() {
  const candidates = runtimeProcessPids();
  if (candidates.length > 1) {
    throw new Error(`Multiple QEMU processes use ${runtimeDiskPath}; refusing automatic cleanup`);
  }
  const pid = candidates[0];
  if (!pid) {
    const recordedPid = readRuntimePid();
    if (recordedPid) {
      try {
        process.kill(recordedPid, 0);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return;
        throw error;
      }
      throw new Error(`Process ${recordedPid} is still alive but does not match ${runtimeDiskPath}; refusing to remove the runtime disk`);
    }
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error;
  }
  const deadline = Date.now() + 30_000;
  while (runtimeProcessPids().includes(pid) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  if (runtimeProcessPids().includes(pid)) {
    throw new Error(`QEMU pid ${pid} did not stop; refusing to remove its disk`);
  }
}

export function sshArguments(command, options = {}) {
  const runtime = options.runtime ?? runtimeDirectory;
  return [
    "-i", resolve(runtime, "operator_ed25519"),
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "ConnectTimeout=5",
    "-p", "2222",
    "-o", `StrictHostKeyChecking=${options.strict ? "yes" : "no"}`,
    "-o", `UserKnownHostsFile=${resolve(runtime, "known_hosts")}`,
    "matrix-local-operator@127.0.0.1",
    ...command,
  ];
}

export async function runRuntimeSshProbe(command, { timeoutMs = 10_000, signal, execute = executeFile } = {}) {
  signal?.throwIfAborted();
  const timeout = Math.max(1, Math.min(timeoutMs, 10_000));
  if (!Number.isFinite(timeout)) throw new Error("Invalid SSH probe timeout");
  try {
    await execute("ssh", sshArguments(command), { cwd: root, timeout,
      signal, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
    return true;
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof Error)) throw error;
    console.warn("VM SSH probe not ready:", error.name);
    return false;
  }
}

export async function waitForRuntimeSsh(timeoutMs = 15 * 60_000, signal, { probe = runRuntimeSshProbe } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (await probe(["true"], { timeoutMs: Math.min(10_000, deadline - Date.now()), signal })) return;
    if (!runtimeProcessIsOwned()) throw new Error(`QEMU exited during startup; inspect ${runtimeLogPath}`);
    await delay(Math.min(5000, Math.max(0, deadline - Date.now())), undefined, { signal });
  }
  throw new Error(`Timed out waiting for the production VM; inspect ${runtimeLogPath}`);
}

export async function waitForRuntimeReadiness(timeoutMs = 30 * 60_000, signal, { probe = runRuntimeSshProbe } = {}) {
  const deadline = Date.now() + timeoutMs;
  const command = [
    "sudo", "test", "-f", "/opt/matrix/register-complete", "&&",
    "sudo", "systemctl", "is-active", "--quiet",
    "nginx", "matrix-gateway", "matrix-shell", "matrix-scope-runtime", "matrix-terminal-runtime",
  ];
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (await probe(command, { timeoutMs: Math.min(10_000, deadline - Date.now()), signal })) return;
    if (!runtimeProcessIsOwned()) throw new Error(`QEMU exited during readiness checks; inspect ${runtimeLogPath}`);
    await delay(Math.min(5000, Math.max(0, deadline - Date.now())), undefined, { signal });
  }
  throw new Error("Timed out waiting for production registration and runtime services");
}
