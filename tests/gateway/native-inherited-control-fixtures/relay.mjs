// Intermediary retains its actual service spawn/birth. IPC values are fixture
// observations; product code must not accept this JSON as an identity proof.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
const native = createRequire(import.meta.url)(process.argv[2]);
const pidfdMode = process.argv[3] === "--pidfd-ancillary";
const closedStderrMode = process.argv[3] === "--closed-stderr";
const guardMode = process.argv[3] === "--guard-mode" ? process.argv[4] : null;
assert.ok(process.argv.length === 3 || pidfdMode && process.argv.length === 5 || closedStderrMode && process.argv.length === 4
  || process.argv.length === 5 && ["invalid-argument", "worker-attempt", "capacity127", "gc-role"].includes(guardMode));
let service, birth, exited, stopped = false, messages = 0;
async function tell(value) {
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 4096 && process.connected);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay IPC deadline")), 2000);
    process.send(value, error => { clearTimeout(timer); error ? reject(error) : resolve(); });
  });
}
async function waitExit() {
  let timer;
  try { return await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("actual service exit deadline")), 2000); })]); }
  finally { clearTimeout(timer); }
}
async function cleanup(code) {
  if (stopped) return;
  stopped = true;
  try {
    if (service && service.exitCode === null && service.signalCode === null) service.kill("SIGKILL");
    if (exited) await waitExit();
  } finally { if (birth) native.close(birth); }
  process.exit(code);
}
async function failure(phase, error) {
  await tell({ event: "relay-error", phase, errorType: error.name }).catch(() => { process.stderr.write("relay fixture IPC unavailable\n"); });
  await cleanup(1);
}
process.on("message", async message => {
  try {
    assert.ok(++messages <= 8 && message && Object.keys(message).length === 1);
    if (message.command === "cleanup") { await cleanup(0); return; }
    assert.ok(["receive", "receive-pidfd-ancillary", "receive-copied-writer", "control-loss-current", "send", "close", "ping", "exit"].includes(message.command));
    assert.ok(service.connected);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("service command IPC deadline")), 2000);
      service.send(message, error => { clearTimeout(timer); error ? reject(error) : resolve(); });
    });
  } catch (error) { await failure("parent-command", error); }
});
process.on("disconnect", () => cleanup(1).catch(() => process.exit(1)));
try {
  const extra = pidfdMode ? ["--pidfd-ancillary", process.argv[4]] : closedStderrMode ? ["--closed-stderr"] : guardMode ? [guardMode] : [];
  const selectedFixture = guardMode ? "./guard-service.mjs" : "./service.mjs";
  const flags = guardMode === "gc-role" ? ["--expose-gc"] : [];
  service = spawn(process.execPath, [...flags, fileURLToPath(new URL(selectedFixture, import.meta.url)), process.argv[2], ...extra], { stdio: [0, 1, 2, "ipc"], env: process.env });
  exited = new Promise((resolve, reject) => { service.once("error", reject); service.once("close", (code, signal) => resolve({ code, signal })); });
  exited.catch(() => {});
  birth = native.retainChild(service.pid); // Actual returned native child, retained before callbacks.
  service.on("message", message => {
    try {
      if (message?.event === "closed" || message?.event === "guard-result" && message.mode === "gc-role") { fstatSync(0); fstatSync(1); }
      tell({ event: "service", message, retainedServiceAlive: native.childAlive(birth), relayAliasesOpen: true }).catch(error => failure("service-message", error));
    } catch (error) { failure("service-message", error).catch(() => process.exit(1)); }
  });
  service.once("close", (code, signal) => {
    tell({ event: "service-exit", code, signal, retainedServiceAlive: native.childAlive(birth) }).catch(error => failure("service-exit", error));
  });
  await tell({ event: "spawned", actualServicePID: service.pid, relayPID: process.pid, retainedServiceAlive: native.childAlive(birth) });
} catch (error) { await failure("spawn", error); }
