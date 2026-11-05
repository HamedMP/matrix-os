import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const NODE = "/opt/matrix/runtime/node/bin/node";
export const safeCode = error => /^[a-z][a-z0-9_]{0,95}$/.test(error?.message) ? error.message : "native_acceptance_failed";
export function assert(value, code) { if (!value) throw new Error(code); }
export async function stat(path) {
  try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
export async function command(binary, args, timeout = 15_000) {
  try {
    const { stdout, stderr } = await execute(binary, args, { encoding: "utf8", timeout, maxBuffer: 256 * 1024,
      killSignal: "SIGKILL", env: { PATH: "/usr/bin:/bin", HOME: "/", LANG: "C", GIT_OPTIONAL_LOCKS: "0" } });
    return { code: 0, stdout: stdout.trim(), stderrPresent: stderr.trim().length > 0 };
  } catch (error) { return { code: Number.isInteger(error.code) ? error.code : -1, stdout: "" }; }
}
export async function must(binary, args, code, timeout) {
  const result = await command(binary, args, timeout); assert(result.code === 0, code); return result.stdout;
}
export function parseOptions(argv) {
  const input = {};
  for (const arg of argv) {
    const match = /^--(namespace|app-root|home|mode|ack-source|ack-lockfile)=(.+)$/.exec(arg);
    assert(match && !Object.hasOwn(input, match[1]), "arguments_invalid"); input[match[1]] = match[2];
  }
  assert(/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(input.namespace), "namespace_invalid");
  assert(["preflight", "run"].includes(input.mode), "mode_invalid");
  const base = `/var/lib/matrix-devstack/${input.namespace}`;
  assert(input["app-root"] === `${base}/app` && input.home === `${base}/home`, "paths_invalid");
  if (input.mode === "run") assert(/^[a-f0-9]{40}$/.test(input["ack-source"])
    && /^[a-f0-9]{64}$/.test(input["ack-lockfile"]), "ack_source_and_lockfile_required");
  return input;
}
export function resolveConfig(input, resolver) {
  return resolver({ env: { MATRIX_SCOPE_RUNTIME_NAMESPACE: input.namespace,
    MATRIX_SCOPE_RUNTIME_APP_ROOT: input["app-root"], MATRIX_HOME: input.home }, homePath: input.home });
}
export async function noSymlinkAncestors(path, protectedSource = false) {
  assert(resolve(path) === path, "path_noncanonical");
  let current = path;
  while (current !== "/") {
    const entry = await lstat(current);
    assert(!entry.isSymbolicLink(), "symlink_refused");
    if (protectedSource) assert(entry.uid === 0 && (entry.mode & 0o022) === 0, "source_not_root_protected");
    current = dirname(current);
  }
}
export function validateOwnerMarker(entry, raw, expected) {
  assert(entry.isFile() && entry.uid === 0 && (entry.mode & 0o7777) === 0o600
    && entry.nlink === 1 && entry.size > 0 && entry.size <= 4096, "marker_metadata_invalid");
  const marker = JSON.parse(raw);
  assert(Object.keys(marker).length === Object.keys(expected).length
    && Object.keys(expected).every(key => marker[key] === expected[key]), "marker_values_invalid");
  return marker;
}
export async function readOwnerMarker(path, expected) {
  await noSymlinkAncestors(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const entry = await handle.stat();
    assert(entry.isFile() && entry.size <= 4096, "marker_metadata_invalid");
    const buffer = Buffer.alloc(4097); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    assert(bytesRead <= 4096, "marker_oversized");
    return validateOwnerMarker(entry, buffer.subarray(0, bytesRead).toString("utf8"), expected);
  } finally { await handle.close(); }
}
export async function hash(path) {
  const digest = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(path)) { bytes += chunk.length; assert(bytes <= 512 * 1024 * 1024, "hash_capacity_exceeded"); digest.update(chunk); }
  return digest.digest("hex");
}
export async function sourceFacts(input) {
  const app = input["app-root"];
  await noSymlinkAncestors(app, true); await noSymlinkAncestors(input.home, true);
  const sourceSha = await must("/usr/bin/git", ["-C", app, "rev-parse", "HEAD"], "source_unavailable");
  assert(/^[a-f0-9]{40}$/.test(sourceSha), "source_invalid");
  const dirty = await must("/usr/bin/git", ["-C", app, "status", "--porcelain", "--untracked-files=normal"], "source_status_unavailable");
  assert(dirty === "", "source_dirty");
  await noSymlinkAncestors(`${app}/pnpm-lock.yaml`, true);
  const lockfileSha256 = await hash(`${app}/pnpm-lock.yaml`);
  if (input.mode === "run") assert(sourceSha === input["ack-source"] && lockfileSha256 === input["ack-lockfile"], "ack_mismatch");
  return { version: 1, purpose: "matrix-devstack-native-acceptance", namespace: input.namespace,
    appRoot: app, home: input.home, sourceSha, lockfileSha256 };
}
export async function assertNoUnits(config, run = command) {
  const shown = await run("/usr/bin/systemctl", ["show", config.supervisorUnit, "--property=LoadState"]);
  assert(shown.code === 0 && shown.stdout.trim() === "LoadState=not-found", "existing_or_unknown_supervisor_unit");
  const units = await run("/usr/bin/systemctl", ["list-units", "--all", "--no-legend", "--plain", `${config.workerUnitPrefix}*.service`]);
  assert(units.code === 0 && units.stdout.trim() === "", "existing_or_unknown_worker_unit");
  // An unmatched list-unit-files glob can exit 1. Inspect the complete bounded
  // service inventory with a known installed control instead of interpreting errors.
  const inventory = await run("/usr/bin/systemctl", ["list-unit-files", "--all", "--type=service", "--no-pager", "--plain", "--no-legend"]);
  assert(inventory.code === 0 && !inventory.stderrPresent && Buffer.byteLength(inventory.stdout) <= 256 * 1024, "unit_file_inventory_unavailable");
  const rows = inventory.stdout.trim().split("\n");
  assert(rows.length <= 4096, "unit_file_inventory_capacity");
  let control = false;
  for (const row of rows) {
    const match = /^([^\s]{1,255}\.service)\s+(enabled(?:-runtime)?|disabled|static|masked(?:-runtime)?|linked(?:-runtime)?|alias|indirect|generated|transient|bad)(?:\s+(enabled|disabled|ignored|-))?$/.exec(row.trim());
    assert(match, "unit_file_inventory_invalid");
    assert(match[1] !== config.supervisorUnit && !match[1].startsWith(config.workerUnitPrefix), "existing_or_unknown_worker_unit");
    if (match[1] === "matrix-gateway.service") control = true;
  }
  assert(control, "unit_file_inventory_control_missing");
}
export async function assertVacant(config, run = command, heldLock) {
  await assertNoUnits(config, run);
  for (const path of [config.runtimeDirectory, config.commandSocketRoot, config.stateRoot]) {
    assert(!await stat(path), "ambiguous_partial_state");
  }
  const lock = await stat(`${dirname(config.stateRoot)}/.native-acceptance-active`);
  assert(!lock || heldLock && lock.ino === heldLock.ino && lock.dev === heldLock.dev, "ambiguous_partial_state");
}
export async function preflight(config, run = command) {
  const blockers = [];
  if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() !== 0) blockers.push("linux_x64_root_required");
  const { preparePlacement } = await import("./placement.mjs");
  try { await preparePlacement(config, { readOnly: true }); await assertVacant(config, run); } catch (error) { blockers.push(safeCode(error)); }
  for (const path of [NODE, "/usr/bin/systemd-run", "/usr/bin/systemctl", "/usr/bin/nsenter", "/usr/bin/env", "/usr/bin/systemd-notify"]) {
    try { await access(path, constants.X_OK); } catch (error) {
      if (!["ENOENT", "EACCES"].includes(error.code)) throw error; blockers.push("native_dependency_missing");
    }
  }
  try {
    for (const name of ["main.js", "host-config.js", "systemd-unit-identity.js"]) assert((await lstat(`${config.appRoot}/packages/scope-runtime/dist/${name}`)).isFile(), "build_missing");
    const worker = await lstat(`${config.appRoot}/packages/scope-runtime/dist/worker.js`);
    assert(worker.isFile() && (worker.mode & 0o004) !== 0, "worker_not_world_readable");
    for (const name of ["claude-agent-sdk", "claude-agent-sdk-linux-x64"]) {
      const root = await realpath(`${config.appRoot}/node_modules/@anthropic-ai/${name}`);
      const directory = await lstat(root); assert(directory.isDirectory() && (directory.mode & 0o005) === 0o005, "sdk_not_world_readable");
      const file = await lstat(`${root}/${name === "claude-agent-sdk" ? "sdk.mjs" : "claude"}`);
      assert(file.isFile() && (file.mode & (name === "claude-agent-sdk" ? 0o004 : 0o005)) === (name === "claude-agent-sdk" ? 0o004 : 0o005), "sdk_not_world_readable");
    }
    assert((await stat("/sys/fs/cgroup/cgroup.controllers"))?.isFile(), "cgroup_v2_required");
  } catch (error) { blockers.push(["worker_not_world_readable", "sdk_not_world_readable", "cgroup_v2_required"].includes(error.message) ? error.message : "native_build_missing"); }
  return { mode: "preflight", ready: blockers.length === 0, blockers: [...new Set(blockers)], config };
}
export async function waitFor(check, code, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(code);
}
