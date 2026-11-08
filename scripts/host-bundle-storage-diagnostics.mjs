// Best-effort build evidence only. No paths, mount sources or environment in output.
import { spawn } from "node:child_process";
import { Console } from "node:console";
import { lstat, statfs } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const kind = "host-bundle-storage";
const metricKeys = ["totalBytes", "freeBytes", "availableBytes", "totalInodes", "freeInodes"];
const filesystemTypes = new Map([[0xef53n, "ext"], [0x58465342n, "xfs"], [0x9123683en, "btrfs"], [0x794c7630n, "overlay"], [0x01021994n, "tmpfs"]]);
const rolesFor = scope => scope === "inner" ? ["source", "scratch", "output", "tmp"] : ["source", "scratch", "output"];
const unavailable = (scope, phase) => ({ kind, scope, phase, status: "unavailable" });

async function filesystem(path, role) {
  // Output may not exist yet. Inspect its nearest existing directory, never create it.
  for (let depth = 0; depth < 64; depth++, path = dirname(path)) {
    try {
      if (!(await lstat(path)).isDirectory()) throw new Error("Not a real directory");
      const value = await statfs(path, { bigint: true });
      return { role, filesystem: filesystemTypes.get(value.type) ?? "other", totalBytes: String(value.blocks * value.bsize),
        freeBytes: String(value.bfree * value.bsize), availableBytes: String(value.bavail * value.bsize),
        totalInodes: String(value.files), freeInodes: String(value.ffree) };
    } catch (error) { if (error.code !== "ENOENT" || role !== "output") throw error; }
  }
  throw new Error("No bounded filesystem ancestor");
}

function valid(record, scope, phase) {
  const roles = rolesFor(scope);
  return record?.kind === kind && record.scope === scope && record.phase === phase &&
    Object.keys(record).sort().join() === "filesystems,kind,phase,scope" &&
    Array.isArray(record.filesystems) && record.filesystems.length === roles.length &&
    record.filesystems.every((value, index) => value?.role === roles[index] &&
      Object.keys(value).sort().join() === ["role", "filesystem", ...metricKeys].sort().join() &&
      ["ext", "xfs", "btrfs", "overlay", "tmpfs", "other"].includes(value.filesystem) &&
      metricKeys.every(key => typeof value[key] === "string" && /^\d{1,30}$/.test(value[key])));
}

function probe(args) {
  // Own the deadline outside the statfs process: a stalled filesystem must not
  // hold up the original failure or container/temp cleanup. One child per snapshot.
  return new Promise(done => {
    let child, timer, finished = false, stdout = "";
    const finish = value => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      child?.stdout?.destroy(); child?.unref();
      done(value);
    };
    try {
      child = spawn(process.execPath, [script, "--collect", ...args], { env: {}, stdio: ["ignore", "pipe", "ignore"] });
      const stop = () => { child.kill("SIGKILL"); finish(undefined); };
      timer = setTimeout(stop, 3000);
      child.stdout.on("data", chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 8192) stop(); });
      child.once("error", () => finish(undefined));
      child.once("close", code => finish(code === 0 ? stdout : undefined));
    } catch (error) { finish(undefined); }
  });
}

export async function storageSnapshot(scope, phase, paths) {
  if (!["outer", "inner"].includes(scope) || !["before", "failure"].includes(phase)) return;
  let record = unavailable(scope, phase);
  try {
    const stdout = await probe([scope, phase, ...paths]);
    const value = JSON.parse(stdout);
    if (valid(value, scope, phase)) record = value;
  } catch (error) { record = unavailable(scope, phase); }
  // Keep Node's write-error handling local to diagnostics, even with a strict
  // global Console. An asynchronous broken pipe must not interrupt cleanup.
  try { new Console({ stdout: process.stdout, ignoreErrors: true }).log(JSON.stringify(record)); }
  catch (error) { return; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, scopeOrPhase, phase, ...paths] = process.argv.slice(2);
  if (mode === "--collect") {
    const scope = scopeOrPhase, roles = rolesFor(scope);
    // Also self-bound normal async filesystem stalls; the caller owns the hard deadline.
    const deadline = setTimeout(() => process.exit(1), 2000);
    try {
      if (!["outer", "inner"].includes(scope) || !["before", "failure"].includes(phase) || paths.length !== roles.length ||
        paths.some(path => !isAbsolute(path) || resolve(path) !== path)) throw new Error("Invalid diagnostic input");
      const filesystems = await Promise.all(paths.map((path, index) => filesystem(path, roles[index])));
      console.log(JSON.stringify({ kind, scope, phase, filesystems }));
    } catch (error) { process.exitCode = 1; }
    finally { clearTimeout(deadline); }
  } else if (mode === "inner" && ["before", "failure"].includes(scopeOrPhase) && process.argv.length === 5) {
    // A direct baseline build is outside this sandbox diagnostic's scope.
    if (phase === "/work") await storageSnapshot("inner", scopeOrPhase, ["/work", "/scratch", "/work/dist/host-bundle", "/tmp"]);
  } else { process.exitCode = 2; }
}
