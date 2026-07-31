#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const [operation = "", displayName = "", workloadKind = ""] = process.argv.slice(2);
const home = "/home/matrix/home";
const descriptorRoot = `${home}/system/terminal-runtimes`;
const uid = process.getuid?.() === 0
  ? Number((await execFileAsync("/usr/bin/id", ["-u", "matrix"])).stdout.trim())
  : process.getuid?.();

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exit(1);
}

if (
  operation !== "snapshot"
  || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(displayName)
  || (workloadKind !== "shell" && workloadKind !== "agent")
  || !Number.isInteger(uid)
) {
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
if (!processes.some((entry) => entry.pid === mainPid) || zellij.length < 2 || !workload) {
  fail("production_probe_roles_invalid");
}

process.stdout.write(`${JSON.stringify({
  runtimeId: descriptor.runtimeId,
  sessionName: descriptor.sessionName,
  generation: descriptor.generation,
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
