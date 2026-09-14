#!/opt/matrix/runtime/node/bin/node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, rename, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVICE = "matrix-scope-runtime.service";
const SUPERVISOR_SOCKET = "/run/matrix-scope-runtime/supervisor.sock";
const BROKER_SOCKET = "/run/matrix-scope-runtime/broker.sock";
const DISABLED_MARKER = "/opt/matrix/app/SCOPE_RUNTIME_DISABLED";
const MARKER_BACKUP = "/var/tmp/matrix-scope-runtime-disabled.acceptance";
const BUNDLE_VERSION = "/opt/matrix/app/BUNDLE_VERSION";
const RELEASE_METADATA = "/opt/matrix/release.json";
const EXPECTED_PROFILE_DIGEST = "8f5c1d40eb30581026f89870c98d21064187386d36a80928a9eb2be7b671da37";
const EXPECTED_PROFILE_ID = "scope-runtime-proof-v1";
const EXPECTED_HARNESS_VERSION = "2.1.240";
const MAX_FRAME_BYTES = 64 * 1024;
const SUPERVISOR_QUERY_TIMEOUT_MS = 5_000;
const SUPERVISOR_OPERATION_TIMEOUT_MS = 30_000;
const SYSTEMD_EXEC_STEPS = [
  "ADDRESS_FAMILIES", "CAPABILITIES", "CHDIR", "CHROOT", "EXEC", "GROUP", "NAMESPACE", "SECCOMP", "USER",
];
const SYSTEMD_WORKER_FAILURES = {
  ScopeRuntimeBrokerError: "broker",
  ScopeRuntimeEnvironmentCapacityError: "environment_capacity",
  ScopeRuntimeEnvironmentFixedError: "environment_fixed",
  ScopeRuntimeEnvironmentKeyError: "environment_key",
  ScopeRuntimeFilesystemError: "filesystem",
  ScopeRuntimeIdentityUidError: "identity_uid",
  ScopeRuntimeIdentityWorkingDirectoryError: "identity_working_directory",
  ScopeRuntimeInvocationError: "invocation",
  ScopeRuntimeReadinessError: "readiness",
  ScopeRuntimeUnknownError: "unknown",
};

class AcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.name = "AcceptanceError";
    this.code = code;
  }
}

function assert(condition, code) {
  if (!condition) throw new AcceptanceError(code);
}

async function pathType(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function command(command, args, timeout = 60_000) {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout,
      maxBuffer: MAX_FRAME_BYTES,
      killSignal: "SIGKILL",
    });
    return { code: 0, stdout: result.stdout.trim() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const code = Number.isInteger(error.code) ? error.code : -1;
    const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    return { code, stdout };
  }
}

async function mustCommand(commandPath, args, failure, timeout) {
  const result = await command(commandPath, args, timeout);
  assert(result.code === 0, failure);
  return result.stdout;
}

async function readInstalledRelease() {
  const entry = await pathType(RELEASE_METADATA);
  assert(entry?.isFile() && !entry.isSymbolicLink() && entry.size > 0 && entry.size <= 16 * 1024,
    "exact_bundle_required");
  try {
    const release = JSON.parse(await readFile(RELEASE_METADATA, "utf8"));
    assert(release && typeof release === "object" && !Array.isArray(release), "exact_bundle_required");
    return release;
  } catch (error) {
    if (error instanceof AcceptanceError) throw error;
    if (error instanceof SyntaxError) throw new AcceptanceError("exact_bundle_required");
    throw error;
  }
}

async function waitFor(check, timeoutMs, failure) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new AcceptanceError(failure);
}

function socketExchange(frame, { end = true, timeoutMs = SUPERVISOR_QUERY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: SUPERVISOR_SOCKET });
    let response = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new AcceptanceError("supervisor_response_timeout"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      if (end) socket.end(frame);
      else socket.write(frame);
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > MAX_FRAME_BYTES) {
        reject(new AcceptanceError("supervisor_response_oversized"));
        socket.destroy();
      }
    });
    socket.once("end", finish);
    socket.once("close", finish);
    socket.once("error", finish);
  });
}

async function supervisorRequest(input) {
  const timeoutMs = input.type === "capability.get"
    ? SUPERVISOR_QUERY_TIMEOUT_MS
    : SUPERVISOR_OPERATION_TIMEOUT_MS;
  const response = await socketExchange(`${JSON.stringify(input)}\n`, { timeoutMs });
  assert(response.length > 0 && Buffer.byteLength(response, "utf8") <= MAX_FRAME_BYTES,
    "supervisor_response_invalid");
  try {
    return JSON.parse(response.trim());
  } catch (error) {
    if (error instanceof SyntaxError) throw new AcceptanceError("supervisor_response_invalid");
    throw error;
  }
}

async function expectClosed(frame) {
  const response = await socketExchange(frame);
  assert(response === "", "invalid_frame_received_response");
}

function capabilityRequest() {
  return {
    version: 1,
    type: "capability.get",
    requestId: randomUUID(),
  };
}

function validateCapability(response) {
  assert(response?.version === 1 && response.type === "capability.result" && response.ok === true,
    "capability_invalid");
  assert(response.supervisorVersion === "1.0.0", "supervisor_version_invalid");
  const profile = response.profile;
  assert(profile?.profileId === EXPECTED_PROFILE_ID && profile.profileVersion === 1,
    "profile_identity_invalid");
  assert(profile.profileDigest === EXPECTED_PROFILE_DIGEST, "profile_digest_invalid");
  assert(/^[1-9][0-9]{0,19}$/.test(profile.executionGeneration), "generation_invalid");
  assert(profile.identity?.mode === "dynamic" && profile.identity.uidMin === 61_184
    && profile.identity.uidMax === 65_519, "dynamic_identity_invalid");
  assert(profile.limits?.memoryMaxBytes === 1_073_741_824
    && profile.limits.cpuQuotaPercent === 200
    && profile.limits.tasksMax === 256
    && profile.limits.storageMaxBytes === 10_737_418_240, "profile_limits_invalid");
  assert(profile.adapters?.length === 1
    && profile.adapters[0]?.adapterId === "claude-code"
    && profile.adapters[0]?.harnessVersion === EXPECTED_HARNESS_VERSION
    && JSON.stringify(profile.adapters[0]?.workloads) === '["chat_ai"]',
  "adapter_capability_invalid");
  return profile;
}

async function startBroker() {
  const existing = await pathType(BROKER_SOCKET);
  assert(!existing, "broker_socket_collision");
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(BROKER_SOCKET, resolve);
  });
  await chmod(BROKER_SOCKET, 0o666);
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve) => server.close(() => resolve()));
    const entry = await pathType(BROKER_SOCKET);
    if (entry?.isSocket() && !entry.isSymbolicLink()) await rm(BROKER_SOCKET);
  };
}

function unitForRuntime(runtimeHandle) {
  const match = /^runtime_([a-f0-9]{32})$/.exec(runtimeHandle);
  assert(match, "runtime_handle_invalid");
  return `matrix-scope-runtime-${match[1]}.service`;
}

async function captureSupervisorJournalCursor() {
  const journal = await command("/usr/bin/journalctl", [
    "--unit", SERVICE, "--show-cursor", "--lines=0", "--no-pager",
  ]);
  const cursor = /^-- cursor: ([A-Za-z0-9_=;.:+-]{1,1024})$/m.exec(journal.stdout)?.[1];
  assert(journal.code === 0 && cursor, "journal_cursor_unavailable");
  return cursor;
}

async function runtimeCreationFailureCode(cursor) {
  const supervisorJournal = await command("/usr/bin/journalctl", [
    "--unit", SERVICE, "--after-cursor", cursor, "--grep", "fixed-profile launch failed:",
    "--no-pager", "--output=cat", "--lines=20",
  ]);
  const supervisorWorker = /fixed-profile launch failed:\s+(ScopeRuntime[A-Za-z]+Error)\b/
    .exec(supervisorJournal.stdout)?.[1];
  if (supervisorJournal.code === 0 && supervisorWorker
    && Object.hasOwn(SYSTEMD_WORKER_FAILURES, supervisorWorker)) {
    return `runtime_create_failed_worker_${SYSTEMD_WORKER_FAILURES[supervisorWorker]}`;
  }
  const activationStatus = /ScopeRuntimeActivationStatus([1-9][0-9]{0,2})Error\b/
    .exec(supervisorJournal.stdout)?.[1];
  if (supervisorJournal.code === 0 && activationStatus) {
    return `runtime_create_failed_activation_status_${activationStatus}`;
  }
  const workerJournal = await command("/usr/bin/journalctl", [
    "--after-cursor", cursor, "--grep", "^scope_runtime_worker_failed:",
    "--no-pager", "--output=cat", "--lines=20",
  ]);
  const worker = /scope_runtime_worker_failed:\s+(ScopeRuntime[A-Za-z]+Error)\b/
    .exec(workerJournal.stdout)?.[1];
  if (workerJournal.code === 0 && worker && Object.hasOwn(SYSTEMD_WORKER_FAILURES, worker)) {
    return `runtime_create_failed_worker_${SYSTEMD_WORKER_FAILURES[worker]}`;
  }
  const journal = await command("/usr/bin/journalctl", [
    "--unit", "matrix-scope-runtime-*.service", "--after-cursor", cursor,
    "--no-pager", "--output=cat", "--lines=80",
  ]);
  if (journal.code !== 0) return "runtime_create_failed";
  const step = /Failed at step ([A-Z][A-Z0-9_-]{0,31})\b/.exec(journal.stdout)?.[1];
  if (step && SYSTEMD_EXEC_STEPS.includes(step)) {
    return `runtime_create_failed_step_${step.toLowerCase()}`;
  }
  const status = /status=([0-9]{1,3})\/[A-Z][A-Z0-9_-]{0,31}\b/.exec(journal.stdout)?.[1];
  return status ? `runtime_create_failed_status_${status}` : "runtime_create_failed";
}

async function assertWorkloadBoundary(unit) {
  await waitFor(async () => (await command("/usr/bin/systemctl", ["is-active", "--quiet", unit])).code === 0,
    10_000, "workload_not_active");
  await waitFor(async () => {
    const log = await command("/usr/bin/journalctl", ["--unit", unit, "--no-pager", "--output=cat", "--lines=40"]);
    return log.code === 0 && log.stdout.includes("scope_runtime_worker_ready");
  }, 10_000, "workload_boundary_not_ready");
  const properties = await mustCommand("/usr/bin/systemctl", [
    "show", unit,
    "--property=DynamicUser",
    "--property=PrivateUsers",
    "--property=PrivateNetwork",
    "--property=MemoryMax",
    "--property=TasksMax",
    "--property=WorkingDirectory",
    "--property=RootDirectory",
    "--property=MainPID",
  ], "workload_properties_unavailable");
  for (const property of [
    "DynamicUser=yes",
    "PrivateUsers=yes",
    "PrivateNetwork=yes",
    "MemoryMax=1073741824",
    "TasksMax=256",
    "WorkingDirectory=/workspace",
  ]) assert(properties.includes(property), "workload_profile_mismatch");
  const root = /^RootDirectory=(.+)$/m.exec(properties)?.[1];
  assert(root?.startsWith("/var/lib/matrix-scope-runtime/runtimes/") && root.endsWith("/root"),
    "workload_root_invalid");
  const pid = Number(/^MainPID=([0-9]+)$/m.exec(properties)?.[1]);
  assert(Number.isInteger(pid) && pid > 1, "workload_pid_invalid");
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const uid = Number(/^Uid:\s+([0-9]+)/m.exec(status)?.[1]);
  assert(Number.isInteger(uid) && uid >= 61_184 && uid <= 65_519, "workload_uid_invalid");
  return uid;
}

async function createRuntime(profile) {
  const cursor = await captureSupervisorJournalCursor();
  const response = await supervisorRequest({
    version: 1,
    type: "runtime.create",
    requestId: randomUUID(),
    scopeHandle: `scope_${"1".repeat(32)}`,
    profileId: profile.profileId,
    workload: "chat_ai",
    adapterId: "claude-code",
    harnessVersion: EXPECTED_HARNESS_VERSION,
  });
  if (!(response?.type === "runtime.result" && response.ok === true && response.state === "running")) {
    throw new AcceptanceError(await runtimeCreationFailureCode(cursor));
  }
  assert(response.executionGeneration === profile.executionGeneration, "runtime_generation_mismatch");
  return response.runtimeHandle;
}

async function stopRuntime(runtimeHandle, generation) {
  const response = await supervisorRequest({
    version: 1,
    type: "runtime.stop",
    requestId: randomUUID(),
    runtimeHandle,
  });
  assert(response?.type === "runtime.result" && response.ok === true && response.state === "stopped"
    && response.runtimeHandle === runtimeHandle && response.executionGeneration === generation,
  "runtime_stop_failed");
}

async function openCrashRequest() {
  let socket;
  const connected = new Promise((resolve, reject) => {
    socket = createConnection({ path: SUPERVISOR_SOCKET });
    socket.once("connect", () => {
      socket.write('{"version":1');
      resolve();
    });
    socket.once("error", reject);
  });
  const closed = new Promise((resolve) => {
    socket.once("close", resolve);
    socket.once("error", resolve);
  });
  await connected;
  return { socket, closed };
}

async function restoreDormantService(runtimeUnits) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await command("/usr/bin/systemctl", ["stop", SERVICE]);
    for (const unit of runtimeUnits) {
      await command("/usr/bin/systemctl", ["stop", unit]);
      await command("/usr/bin/systemctl", ["reset-failed", unit]);
    }
    await command("/usr/bin/systemctl", ["disable", SERVICE]);

    const enabled = await command("/usr/bin/systemctl", ["is-enabled", SERVICE]);
    const active = await command("/usr/bin/systemctl", ["is-active", "--quiet", SERVICE]);
    let runtimeActive = false;
    for (const unit of runtimeUnits) {
      if ((await command("/usr/bin/systemctl", ["is-active", "--quiet", unit])).code === 0) {
        runtimeActive = true;
      }
    }
    if (enabled.stdout === "disabled" && active.code !== 0 && !runtimeActive) return;

    await command("/usr/bin/systemctl", ["kill", "--kill-whom=all", "--signal=SIGKILL", SERVICE]);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new AcceptanceError("service_cleanup_failed");
}

async function runAcceptance() {
  assert(process.getuid?.() === 0, "root_required");
  const expectedHead = process.env.MATRIX_SCOPE_EXPECTED_HEAD ?? "";
  assert(/^[a-f0-9]{40}$/.test(expectedHead), "expected_head_invalid");
  const bundleVersion = (await readFile(BUNDLE_VERSION, "utf8")).trim();
  assert(/^[A-Za-z0-9._-]{1,128}$/.test(bundleVersion), "exact_bundle_required");
  const release = await readInstalledRelease();
  assert(release.gitCommit === expectedHead, "exact_bundle_required");
  const marker = await pathType(DISABLED_MARKER);
  assert(marker?.isFile() && !marker.isSymbolicLink(), "disabled_marker_required");
  assert(!(await pathType(MARKER_BACKUP)), "marker_backup_collision");
  const enabled = await command("/usr/bin/systemctl", ["is-enabled", SERVICE]);
  assert(enabled.stdout === "disabled", "service_enabled_unexpectedly");
  const active = await command("/usr/bin/systemctl", ["is-active", "--quiet", SERVICE]);
  assert(active.code !== 0, "service_active_unexpectedly");

  let markerMoved = false;
  let closeBroker;
  const runtimeUnits = [];
  let productionPassed = false;
  let uid;
  let generationBefore;
  let generationAfter;
  try {
    await rename(DISABLED_MARKER, MARKER_BACKUP);
    markerMoved = true;
    await mustCommand("/usr/bin/systemctl", ["start", SERVICE], "supervisor_start_failed");
    await waitFor(async () => (await pathType(SUPERVISOR_SOCKET))?.isSocket(),
      15_000, "supervisor_socket_unavailable");
    closeBroker = await startBroker();

    const profileBefore = validateCapability(await supervisorRequest(capabilityRequest()));
    generationBefore = profileBefore.executionGeneration;

    await expectClosed("not-json\n");
    const validFrame = `${JSON.stringify(capabilityRequest())}\n`;
    await expectClosed(`${validFrame}${validFrame}`);
    await expectClosed(`${"x".repeat(MAX_FRAME_BYTES + 1)}\n`);
    await expectClosed(`${JSON.stringify({ ...capabilityRequest(), command: "/bin/sh" })}\n`);

    const timeoutStarted = Date.now();
    const timeoutResponse = await socketExchange('{"version":1', { end: false, timeoutMs: 15_000 });
    const timeoutElapsed = Date.now() - timeoutStarted;
    assert(timeoutResponse === "" && timeoutElapsed >= 9_000 && timeoutElapsed <= 14_000,
      "request_timeout_invalid");

    const firstHandle = await createRuntime(profileBefore);
    const firstUnit = unitForRuntime(firstHandle);
    runtimeUnits.push(firstUnit);
    uid = await assertWorkloadBoundary(firstUnit);

    const crashRequest = await openCrashRequest();
    await mustCommand("/usr/bin/systemctl", ["kill", "--kill-whom=main", "--signal=SIGKILL", SERVICE],
      "supervisor_crash_failed");
    await Promise.race([
      crashRequest.closed,
      new Promise((_, reject) => setTimeout(() => reject(new AcceptanceError("crash_request_not_closed")), 5_000)),
    ]);
    crashRequest.socket.destroy();
    await closeBroker();
    closeBroker = undefined;

    const profileAfter = await waitFor(async () => {
      try {
        const candidate = validateCapability(await supervisorRequest(capabilityRequest()));
        return candidate.executionGeneration !== generationBefore ? candidate : undefined;
      } catch (error) {
        if (error instanceof AcceptanceError) return undefined;
        throw error;
      }
    }, 20_000, "supervisor_restart_failed");
    generationAfter = profileAfter.executionGeneration;
    assert((await command("/usr/bin/systemctl", ["is-active", "--quiet", firstUnit])).code === 0,
      "runtime_not_reconciled");
    await stopRuntime(firstHandle, generationBefore);
    runtimeUnits.splice(runtimeUnits.indexOf(firstUnit), 1);

    closeBroker = await startBroker();
    const secondHandle = await createRuntime(profileAfter);
    const secondUnit = unitForRuntime(secondHandle);
    runtimeUnits.push(secondUnit);
    await assertWorkloadBoundary(secondUnit);
    await mustCommand("/usr/bin/systemctl", ["stop", SERVICE], "supervisor_shutdown_failed");
    await waitFor(async () => (await command("/usr/bin/systemctl", ["is-active", "--quiet", secondUnit])).code !== 0,
      15_000, "shutdown_drain_failed");
    runtimeUnits.splice(runtimeUnits.indexOf(secondUnit), 1);
    assert(!(await pathType(SUPERVISOR_SOCKET)), "supervisor_socket_not_drained");
    productionPassed = true;
  } finally {
    if (closeBroker) {
      try {
        await closeBroker();
      } catch (error) {
        process.stderr.write(`scope_runtime_production_cleanup_warning:${
          error instanceof Error ? error.name : "UnknownError"}\n`);
      }
    }
    try {
      await restoreDormantService(runtimeUnits);
    } finally {
      if (markerMoved) {
        const currentMarker = await pathType(DISABLED_MARKER);
        assert(!currentMarker, "disabled_marker_collision");
        await rename(MARKER_BACKUP, DISABLED_MARKER);
      }
    }
  }

  const finalEnabled = await command("/usr/bin/systemctl", ["is-enabled", SERVICE]);
  const finalActive = await command("/usr/bin/systemctl", ["is-active", "--quiet", SERVICE]);
  assert(productionPassed && (await pathType(DISABLED_MARKER))?.isFile()
    && finalEnabled.stdout === "disabled" && finalActive.code !== 0, "disabled_marker_not_restored");
  process.stdout.write("scope_runtime_production_acceptance=passed\n");
  process.stdout.write("scope_runtime_service_default=disabled\n");
  process.stdout.write("scope_runtime_disabled_marker=restored\n");
  process.stdout.write("malformed_frame=closed\n");
  process.stdout.write("multi_frame=closed\n");
  process.stdout.write("oversized_frame=closed\n");
  process.stdout.write("request_timeout=closed\n");
  process.stdout.write("restart_reconciliation=passed\n");
  process.stdout.write("shutdown_drain=passed\n");
  process.stdout.write("supervisor_version=1.0.0\n");
  process.stdout.write(`profile_digest=${EXPECTED_PROFILE_DIGEST}\n`);
  process.stdout.write(`execution_generation_before=${generationBefore}\n`);
  process.stdout.write(`execution_generation_after=${generationAfter}\n`);
  process.stdout.write(`scope_uid=${uid}\n`);
}

if (process.env.MATRIX_SCOPE_PRODUCTION_DISPOSABLE !== "1") {
  process.stderr.write("scope_runtime_production_requires_disposable_host\n");
  process.exitCode = 2;
} else {
  await runAcceptance().catch((error) => {
    process.stderr.write(`scope_runtime_production_failed:${
      error instanceof AcceptanceError ? error.code : "unexpected_error"}\n`);
    process.exitCode = error instanceof AcceptanceError ? 1 : 2;
  });
}
