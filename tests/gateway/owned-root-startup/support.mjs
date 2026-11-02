/* Required isolated Linux fixture primitives. Synthetic observations are not
 * protected image/current source/account policy or production keeper proof. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const ROOT_SHA = "0c61fea8def5ef81a50144c2dc7339c5b798f77133132ed2901ad4a6e9125dfb";
export const sha = bytes => createHash("sha256").update(bytes).digest("hex");
export const now = () => process.hrtime.bigint();
export function recordRealPairs(native) {
  const pairs = [], api = Object.create(null);
  for (const name of ["controlPair", "controlChildFd", "receive", "send", "close", "retainChild", "childAlive", "controlSendChildBirth"]) {
    api[name] = (...args) => native[name](...args); // Transparent real NAPI calls, never mocked IO/results.
  }
  api.controlPair = (...args) => {
    const pair = native.controlPair(...args);
    if (pairs.length >= 2) { native.close(pair.channel); native.close(pair.child); assert.fail("bounded actual pair recorder"); }
    pairs.push(pair); return pair;
  };
  return { api, pairs };
}
export async function until(predicate, end, label) {
  while (!await predicate()) { assert.ok(now() < end, label); await delay(2); }
  assert.ok(now() < end, label);
}
export async function bounded(promise, end, label) {
  const ms = Number((end - now()) / 1_000_000n); assert.ok(ms > 0, label);
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}

export function track(child, birthLife, role, owners) {
  // The caller stores this row BEFORE querying the borrowed view. Even a
  // failed proof must not erase ownership of an actually returned child.
  const row = { child, birthLife, role, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), overflow: false, closed: false };
  owners.push(row);
  row.wait = new Promise(resolve => {
    child.once("error", error => { row.error = error; });
    child.once("close", (code, signal) => { row.closed = true; row.result = { code, signal }; resolve(row.result); });
  });
  for (const name of ["stdout", "stderr"]) child[name]?.on("data", chunk => {
    if (row[name].length + chunk.length > 16384) {
      row.overflow = true; child.kill("SIGKILL"); return;
    }
    row[name] = Buffer.concat([row[name], chunk]);
  });
  return row;
}
export async function waited(row, end) {
  const result = await bounded(row.wait, end, "actual owned close/wait");
  assert.equal(row.birthLife.alive(), false, "same retained actual child birth dead after wait");
  assert.equal(row.overflow, false, "bounded fixture stdout/stderr"); assert.equal(row.error, undefined);
  return result;
}
export async function cleanup(rows, evidence) {
  const end = now() + 5_000_000_000n, facts = [], errors = [];
  for (const row of [...rows].reverse()) {
    try {
      if (!row.closed) row.child.kill("SIGKILL"); // Actual returned Child, never a supplied PID.
      const result = await waited(row, end);
      await writeFile(join(evidence, row.role + ".stdout"), row.stdout);
      await writeFile(join(evidence, row.role + ".stderr"), row.stderr);
      facts.push({ role: row.role, ...result, actualWait: true, retainedBirthDead: true });
    } catch (error) {
      errors.push(String(error.stack ?? error).slice(0, 2048));
      facts.push({ role: row.role, ...(row.result ?? {}), actualWait: row.closed, retainedBirthDead: false });
    }
  }
  return { facts, errors, pending: rows.filter(row => !row.closed).length };
}

export async function command(binary, args, env, cwd, end) {
  const child = spawn(binary, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), error;
  const completion = new Promise(resolve => { child.once("error", caught => { error = caught; }); child.once("close", (code, signal) => resolve({ code, signal })); });
  for (const name of ["stdout", "stderr"]) child[name].on("data", chunk => {
    if ((name === "stdout" ? stdout : stderr).length + chunk.length > 65536) { error = new Error("bounded actual CLI output"); child.kill("SIGKILL"); return; }
    if (name === "stdout") stdout = Buffer.concat([stdout, chunk]); else stderr = Buffer.concat([stderr, chunk]);
  });
  try { const result = await bounded(completion, end, "actual canonical CLI wait"); if (error) throw error; return { ...result, stdout, stderr }; }
  finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await bounded(completion, now() + 3_000_000_000n, "actual CLI cleanup"); } }
}

const WORKLOAD = `import errno, fcntl, json, os, resource, struct, sys, termios
from pathlib import Path
resource.setrlimit(resource.RLIMIT_CPU,(2,2)); resource.setrlimit(resource.RLIMIT_FSIZE,(65536,65536))
target,marker=Path(sys.argv[1]),sys.argv[2]
fds=[]
for item in os.listdir('/proc/self/fd'):
 try: os.fstat(int(item)); fds.append(int(item))
 except OSError as e: assert e.errno in (errno.EBADF,errno.ENOENT)
rows,cols,_,_=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,bytes(8)))
mask=next(line.split()[1] for line in Path('/proc/self/status').read_text().splitlines() if line.startswith('Umask:'))
body={'environment':dict(os.environ),'cwd':os.getcwd(),'isatty':[os.isatty(i) for i in range(3)],'fds':sorted(fds),'rows':rows,'cols':cols,'foregroundPgrp':os.tcgetpgrp(0)==os.getpgrp(),'umask':mask}
data=json.dumps(body,ensure_ascii=False).encode(); assert len(data)<=65536
print(marker,flush=True)
fd=os.open(target,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
try:
 offset=0
 while offset<len(data):
  count=os.write(fd,data[offset:]); assert count>0; offset+=count
finally: os.close(fd)
`;

export async function fixture(evidence) {
  const work = await mkdtemp("/tmp/mxkr-");
  for (const name of ["home", "cwd", "pane-cwd", "final-home", "owner-config", "sockets"]) await mkdir(join(work, name));
  await mkdir(join(work, "sockets/contract_version_1"));
  const environment = { HOME: join(work, "home"), XDG_CONFIG_HOME: join(work, "xdg"), XDG_CACHE_HOME: join(work, "cache"),
    PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "xterm-256color",
    ZELLIJ_CONFIG_DIR: join(work, "owner-config"), ZELLIJ_CONFIG_FILE: join(work, "owner-config/selected.kdl"),
    ZELLIJ_SOCKET_DIR: join(work, "sockets"), ZELLIJ: "inherited-zellij", ZELLIJ_SESSION_NAME: "inherited-session",
    MATRIX_INPUT_SNAPSHOT_SENTINEL: "original-input" };
  const overrides = { ZELLIJ: "configured-zellij", ZELLIJ_SESSION_NAME: "config-session-must-lose", HOME: join(work, "final-home"),
    PATH: "/fixture/prepared-path", ZELLIJ_CONFIG_DIR: join(work, "never-reparse-dir"), ZELLIJ_CONFIG_FILE: join(work, "never-reparse-file"),
    MATRIX_CONFIG_MARKER: "prepared-雪-value", MATRIX_CONFIG_LARGE: "x".repeat(9000) };
  const sessionName = "matrix-rt_" + randomBytes(16).toString("hex"), layoutPath = join(work, "chosen.kdl");
  const witness = join(work, "workload.json"), script = join(work, "workload.py"), marker = "MXKEEPER_" + randomBytes(8).toString("hex");
  await writeFile(script, WORKLOAD);
  await writeFile(layoutPath, `layout {\n tab name="owned-producer" {\n pane command="/usr/bin/python3" name="owned-workload" close_on_exit=false {\n args ${[script,witness,marker].map(v => JSON.stringify(v)).join(" ")}\n }\n }\n}\n`);
  await writeFile(environment.ZELLIJ_CONFIG_FILE, `web_server false\npane_frames false\ndefault_cwd ${JSON.stringify(join(work,"pane-cwd"))}\nenv {\n${Object.entries(overrides).map(([k,v])=>` ${k} ${JSON.stringify(v)}\n`).join("")} }\n`);
  await writeFile(join(work, "owner-config/config.kdl"), "fallback-must-not-be-loaded {\n");
  const expected = Object.assign(Object.create(null), environment, overrides, { ZELLIJ_SESSION_NAME: sessionName });
  return { work, cwd: join(work, "cwd"), evidence, environment, expected, sessionName, layoutPath, witness, marker,
    socketPath: join(work, "sockets/contract_version_1", sessionName), generation: randomBytes(32),
    async remove() { await rm(work, { recursive: true }); } };
}

export async function execEnvironment(row) {
  assert.equal(row.birthLife.alive(), true);
  const raw = await readFile(`/proc/${row.child.pid}/environ`); assert.ok(raw.length <= 65536 && raw.at(-1) === 0);
  const map = Object.create(null);
  for (const entry of raw.subarray(0, -1).toString("utf8").split("\0")) { const split = entry.indexOf("="); assert.ok(split > 0); const key = entry.slice(0, split); assert.equal(Object.hasOwn(map, key), false); map[key] = entry.slice(split + 1); }
  assert.equal(row.birthLife.alive(), true); return map;
}
