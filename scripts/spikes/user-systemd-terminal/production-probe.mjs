#!/usr/bin/env node
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const [operation = "", displayName = "", workloadKind = "", readyPath = ""] = process.argv.slice(2);
const home = "/home/matrix/home";
const descriptorRoot = `${home}/system/terminal-runtimes`;
const attachReadyPrefix = `${home}/system/terminal-acceptance/`;
const attachStatusPath = operation === "attach"
  && readyPath.startsWith(attachReadyPrefix)
  && !readyPath.includes("..")
  && readyPath.length <= 4096
  ? `${readyPath}.status`
  : "";
const uid = process.getuid?.() === 0
  ? Number((await execFileAsync("/usr/bin/id", ["-u", "matrix"])).stdout.trim())
  : process.getuid?.();

function recordAttachStatus(code) {
  const safeCode = code.replaceAll("_", "-");
  if (!attachStatusPath || !/^[a-z][a-z0-9-]{0,63}$/.test(safeCode)) return;
  try {
    writeFileSync(attachStatusPath, `${safeCode}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return;
    if (!(error instanceof Error)) process.stderr.write("production_probe_status_write_non_error\n");
    process.stderr.write("production_probe_status_write_failed\n");
  }
}

function fail(code) {
  recordAttachStatus(code);
  process.stderr.write(`${code}\n`);
  process.exit(1);
}

process.on("uncaughtException", (error) => {
  if (!(error instanceof Error)) process.stderr.write("production_probe_uncaught_non_error\n");
  fail("production_probe_runtime_unavailable");
});
process.on("unhandledRejection", (reason) => {
  if (!(reason instanceof Error)) process.stderr.write("production_probe_rejection_non_error\n");
  fail("production_probe_runtime_unavailable");
});

if (!Number.isInteger(uid) || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(displayName)) {
  fail("production_probe_invalid_request");
}

if (operation === "attach") {
  const token = process.env.MATRIX_AUTH_TOKEN ?? "";
  if (
    !/^[A-Za-z0-9._~+/=-]{16,512}$/.test(token)
    || !readyPath.startsWith(attachReadyPrefix)
    || readyPath.includes("..")
    || readyPath.length > 4096
  ) fail("production_probe_invalid_request");
  const url = new URL("ws://127.0.0.1:4000/ws/terminal");
  url.searchParams.set("session", displayName);
  url.searchParams.set("fromSeq", "0");
  url.searchParams.set("token", token);
  const socket = new WebSocket(url);
  const outcome = await new Promise((resolve) => {
    let attached = false;
    let failureStarted = false;
    let closeTimer;
    const finish = (result) => {
      clearTimeout(timeout);
      if (closeTimer) clearTimeout(closeTimer);
      resolve(result);
    };
    const failAttach = (code) => {
      if (failureStarted || attached) return;
      failureStarted = true;
      recordAttachStatus(code);
      socket.close();
      finish(code);
    };
    const timeout = setTimeout(() => failAttach("timeout"), 15_000);
    socket.addEventListener("message", (event) => {
      if (attached || failureStarted || typeof event.data !== "string" || event.data.length > 4096) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        if (!(error instanceof SyntaxError)) process.stderr.write("production_probe_message_parse_non_syntax_error\n");
        failAttach("message-invalid");
        return;
      }
      if (message?.type === "attached") {
        attached = true;
        void writeFile(readyPath, "ready\n", { flag: "wx", mode: 0o600 })
          .then(() => {
            closeTimer = setTimeout(() => socket.close(), 8_000);
          })
          .catch((error) => {
            if (!(error instanceof Error)) process.stderr.write("production_probe_ready_write_non_error\n");
            process.stderr.write("production_probe_ready_write_failed\n");
            socket.close();
            finish("ready-write-failed");
          });
      } else if (message?.type === "error") {
        const safeCode = typeof message.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(message.code)
          ? message.code.replaceAll("_", "-")
          : "unknown";
        failAttach(`server-${safeCode}`);
      }
    });
    socket.addEventListener("error", () => failAttach("socket-failed"));
    socket.addEventListener("close", () => {
      if (attached) finish("closed");
      else failAttach("closed-before-attached");
    });
  });
  if (outcome !== "closed") fail("production_probe_attach_failed");
  process.exit(0);
}

if (operation !== "snapshot" || (workloadKind !== "shell" && workloadKind !== "agent")) {
  fail("production_probe_invalid_request");
}

async function userSystemctl(args) {
  const command = process.getuid?.() === 0 ? "/usr/sbin/runuser" : "/usr/bin/env";
  const prefix = process.getuid?.() === 0
    ? ["-u", "matrix", "--", "/usr/bin/env"]
    : [];
  const { stdout } = await execFileAsync(command, [
    ...prefix,
    `HOME=${home}`,
    `MATRIX_HOME=${home}`,
    `XDG_RUNTIME_DIR=/run/user/${uid}`,
    `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`,
    "/usr/bin/systemctl",
    "--user",
    ...args,
  ], { timeout: 5_000, maxBuffer: 64 * 1024 });
  return stdout.trim();
}

async function descriptorByDisplayName() {
  const matches = [];
  for (const entry of await readdir(descriptorRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isFile() || !/^rt_[0-9a-f]{32}\.json$/.test(entry.name)) continue;
    const path = `${descriptorRoot}/${entry.name}`;
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 64 * 1024) continue;
    try {
      const descriptor = JSON.parse(await readFile(path, "utf8"));
      if (
        descriptor?.version === 1
        && descriptor.displayName === displayName
        && /^rt_[0-9a-f]{32}$/.test(descriptor.runtimeId ?? "")
        && descriptor.sessionName === `matrix-${descriptor.runtimeId}`
        && /^gen_[0-9a-f]{64}$/.test(descriptor.generation ?? "")
      ) {
        matches.push(descriptor);
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  if (matches.length !== 1) fail("production_probe_descriptor_unavailable");
  return matches[0];
}

function parseProperties(raw) {
  return Object.fromEntries(raw.split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    if (separator < 1) fail("production_probe_property_invalid");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function processEntry(pid) {
  try {
    const [comm, raw] = await Promise.all([
      readFile(`/proc/${pid}/comm`, "utf8"),
      readFile(`/proc/${pid}/cmdline`),
    ]);
    return { pid, comm: comm.trim(), args: raw.toString().split("\0").filter(Boolean) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

const descriptor = await descriptorByDisplayName();
const unit = `matrix-zellij@${descriptor.runtimeId}.service`;
const properties = parseProperties(await userSystemctl([
  "show",
  unit,
  "--property=ActiveState,ControlGroup,MainPID,MemoryHigh,MemoryMax,TasksMax",
]));
const slice = parseProperties(await userSystemctl([
  "show",
  "matrix-terminal.slice",
  "--property=ControlGroup,MemoryHigh,MemoryMax,TasksMax",
]));
if (
  properties.ActiveState !== "active"
  || !properties.ControlGroup?.endsWith(`/${unit}`)
  || properties.ControlGroup.includes("..")
  || !/^[1-9][0-9]*$/.test(properties.MainPID ?? "")
  || !/^[1-9][0-9]*$/.test(properties.MemoryMax ?? "")
  || !/^[1-9][0-9]*$/.test(properties.TasksMax ?? "")
  || !/^[1-9][0-9]*$/.test(slice.MemoryMax ?? "")
  || !/^[1-9][0-9]*$/.test(slice.TasksMax ?? "")
) {
  fail("production_probe_unit_invalid");
}

const pids = (await readFile(`/sys/fs/cgroup${properties.ControlGroup}/cgroup.procs`, "utf8"))
  .trim()
  .split(/\s+/)
  .filter(Boolean)
  .map(Number);
const processes = (await Promise.all(pids.map(processEntry))).filter(Boolean);
const zellij = processes
  .filter((entry) => entry.comm === "zellij" && !entry.args.includes("list-sessions"))
  .sort((left, right) => left.pid - right.pid);
const workload = workloadKind === "shell"
  ? processes.find((entry) => entry.args.some((argument) => argument.endsWith("/production-loop.mjs")))
  : processes.find((entry) => (
      /^codex(?:-|$)/.test(entry.comm)
      || entry.args.some((argument) => /(?:^|\/)codex(?:-|$)/.test(argument))
    ));
const mainPid = Number(properties.MainPID);
if (!processes.some((entry) => entry.pid === mainPid)) fail("production_probe_roles_main_missing");
if (zellij.length === 0) fail("production_probe_roles_zellij_0");
if (zellij.length === 1) fail("production_probe_roles_zellij_1");
if (!workload) fail("production_probe_roles_workload_missing");

process.stdout.write(`${JSON.stringify({
  runtimeId: descriptor.runtimeId,
  workloadKind,
  sessionName: descriptor.sessionName,
  generation: descriptor.generation,
  layoutPath: descriptor.layoutPath,
  environmentPath: descriptor.environmentPath ?? null,
  unit,
  cgroup: properties.ControlGroup,
  mainPid,
  zellijServerPid: zellij.at(-1).pid,
  workloadPid: workload.pid,
  memoryMax: properties.MemoryMax,
  tasksMax: properties.TasksMax,
  sliceCgroup: slice.ControlGroup,
  sliceMemoryMax: slice.MemoryMax,
  sliceTasksMax: slice.TasksMax,
})}\n`);
