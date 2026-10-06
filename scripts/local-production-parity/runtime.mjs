import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  root, machineName, runtimeDirectory, runtimeDiskPath, runtimeSeedPath,
  runtimePidPath, runtimeLogPath, runtimeSshKeyPath,
} from "./config.mjs";

export function readRuntimePid() {
  if (!existsSync(runtimePidPath)) return null;
  const pid = Number(readFileSync(runtimePidPath, "utf8").trim());
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

export function runtimeProcessIsOwned(options = {}) {
  const pid = options.pid ?? readRuntimePid();
  const diskPath = options.diskPath ?? runtimeDiskPath;
  const processCommand = options.processCommand ?? ((candidatePid) => {
    const result = spawnSync("ps", ["-p", String(candidatePid), "-o", "command="], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : "";
  });
  return pid !== null && processCommand(pid).includes(diskPath);
}

export function runtimeProcessPids(options = {}) {
  const diskPath = options.diskPath ?? runtimeDiskPath;
  const processList = options.processList ?? (() => {
    const result = spawnSync("ps", ["-axo", "pid=,command="], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`ps -axo pid=,command= failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
  });
  return processList().split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match || !match[2].includes("qemu-system-x86_64") || !match[2].includes(`file=${diskPath}`)) return [];
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
  // Use the installed executable so QEMU can locate its firmware.
  const result = spawnSync("which", ["qemu-system-x86_64"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("qemu-system-x86_64 is required");
  const child = spawn(result.stdout.trim(), qemuRuntimeArguments(), {
    cwd: root,
    stdio: ["ignore", output, output],
  });
  closeSync(output);
  if (!child.pid) throw new Error("QEMU did not return a process id");
  writeFileSync(runtimePidPath, `${child.pid}\n`, { mode: 0o600 });
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

export function sshArguments(command) {
  return [
    "-i", runtimeSshKeyPath,
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "ConnectTimeout=5",
    "-p", "2222",
    "-o", "StrictHostKeyChecking=no",
    "-o", `UserKnownHostsFile=${resolve(runtimeDirectory, "known_hosts")}`,
    "matrix-local-operator@127.0.0.1",
    ...command,
  ];
}

export async function waitForRuntimeSsh(timeoutMs = 15 * 60_000, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = spawnSync("ssh", sshArguments(["true"]), { cwd: root, stdio: "ignore" });
    if (result.status === 0) return;
    if (!runtimeProcessIsOwned()) throw new Error(`QEMU exited during startup; inspect ${runtimeLogPath}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  }
  throw new Error(`Timed out waiting for the production VM; inspect ${runtimeLogPath}`);
}

export async function waitForRuntimeReadiness(timeoutMs = 30 * 60_000, signal) {
  const deadline = Date.now() + timeoutMs;
  const probe = [
    "sudo", "test", "-f", "/opt/matrix/register-complete", "&&",
    "sudo", "systemctl", "is-active", "--quiet",
    "nginx", "matrix-gateway", "matrix-shell", "matrix-scope-runtime", "matrix-terminal-runtime",
  ];
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = spawnSync("ssh", sshArguments(probe), { cwd: root, stdio: "ignore" });
    if (result.status === 0) return;
    if (!runtimeProcessIsOwned()) throw new Error(`QEMU exited during readiness checks; inspect ${runtimeLogPath}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  }
  throw new Error("Timed out waiting for production registration and runtime services");
}
