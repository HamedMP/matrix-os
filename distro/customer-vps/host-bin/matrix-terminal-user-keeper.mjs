#!/opt/matrix/runtime/node/bin/node
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const RUNTIME_ID_PATTERN = /^rt_[0-9a-f]{32}$/;
const GENERATION_PATTERN = /^gen_[0-9a-f]{64}$/;
const runtimeId = process.argv[2] ?? "";
const homePath = resolve(process.env.MATRIX_HOME || process.env.HOME || "/home/matrix/home");
const runtimeRoot = resolve(process.env.MATRIX_TERMINAL_RUNTIME_ROOT || "/opt/matrix/terminal-runtime");

function fail(code) {
  process.stderr.write(`matrix-terminal-user-keeper: ${code}\n`);
  process.exit(1);
}

function isWithin(base, candidate) {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function requireOwnedPath(path, kind) {
  const lexical = resolve(path);
  const homeReal = realpathSync(homePath);
  const targetReal = realpathSync(lexical);
  const stats = lstatSync(lexical);
  if (!isWithin(homeReal, targetReal) || stats.isSymbolicLink()) fail("descriptor_path_invalid");
  if (kind === "directory" ? !stats.isDirectory() : !stats.isFile()) fail("descriptor_path_invalid");
  return lexical;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

if (!RUNTIME_ID_PATTERN.test(runtimeId)) fail("runtime_id_invalid");

const descriptorPath = join(homePath, "system", "terminal-runtimes", `${runtimeId}.json`);
let descriptor;
try {
  const stats = lstatSync(descriptorPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_DESCRIPTOR_BYTES) {
    fail("descriptor_invalid");
  }
  descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
} catch (error) {
  if (error instanceof SyntaxError) fail("descriptor_invalid");
  fail("descriptor_unavailable");
}

if (
  descriptor?.version !== 1
  || descriptor.runtimeId !== runtimeId
  || descriptor.sessionName !== `matrix-${runtimeId}`
  || (descriptor.scope !== "terminal" && descriptor.scope !== "workspace")
  || (descriptor.kind !== "shell" && descriptor.kind !== "agent")
  || typeof descriptor.cwd !== "string"
  || typeof descriptor.layoutPath !== "string"
  || (descriptor.environmentPath !== undefined && typeof descriptor.environmentPath !== "string")
  || !GENERATION_PATTERN.test(descriptor.generation ?? "")
) {
  fail("descriptor_invalid");
}

let cwd;
let layoutPath;
let zellijPath;
let launchEnvironment = {};
try {
  cwd = requireOwnedPath(descriptor.cwd, "directory");
  layoutPath = requireOwnedPath(descriptor.layoutPath, "file");
  const generationRoot = join(runtimeRoot, "generations", descriptor.generation);
  zellijPath = join(generationRoot, "zellij");
  const generationReal = realpathSync(generationRoot);
  const zellijReal = realpathSync(zellijPath);
  const zellijStats = lstatSync(zellijPath);
  if (!isWithin(realpathSync(runtimeRoot), generationReal) || !isWithin(generationReal, zellijReal)) {
    fail("generation_invalid");
  }
  if (!zellijStats.isFile() || zellijStats.isSymbolicLink() || (zellijStats.mode & 0o111) === 0) {
    fail("generation_invalid");
  }
  if (descriptor.environmentPath) {
    const environmentPath = requireOwnedPath(descriptor.environmentPath, "file");
    const environmentStats = lstatSync(environmentPath);
    if (environmentStats.size > MAX_DESCRIPTOR_BYTES) fail("environment_invalid");
    const parsedEnvironment = JSON.parse(readFileSync(environmentPath, "utf8"));
    if (!parsedEnvironment || Array.isArray(parsedEnvironment) || typeof parsedEnvironment !== "object") {
      fail("environment_invalid");
    }
    const entries = Object.entries(parsedEnvironment);
    if (entries.length > 64 || entries.some(([key, value]) => (
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(key)
      || typeof value !== "string"
      || value.length > 8192
      || value.includes("\0")
    ))) fail("environment_invalid");
    launchEnvironment = parsedEnvironment;
  }
} catch {
  fail("runtime_asset_unavailable");
}

const zellijArgs = [
  zellijPath,
  "--session",
  descriptor.sessionName,
  "--new-session-with-layout",
  layoutPath,
];
const command = zellijArgs.map(shellQuote).join(" ");
const configDir = join(homePath, "system", "zellij");
const child = spawn("/usr/bin/script", ["-qefc", command, "/dev/null"], {
  cwd,
  env: {
    ...process.env,
    ...launchEnvironment,
    HOME: homePath,
    MATRIX_HOME: homePath,
    ZELLIJ_CONFIG_DIR: configDir,
    ZELLIJ_CONFIG_FILE: join(configDir, "config.kdl"),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`,
    PATH: typeof launchEnvironment.PATH === "string"
      ? launchEnvironment.PATH
      : `${homePath}/.local/bin:/opt/matrix/bin:/opt/matrix/runtime/node/bin:/usr/local/bin:/usr/bin:/bin`,
  },
  stdio: "ignore",
});

let forcedKillTimer;
function forwardSignal(signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  if (!forcedKillTimer) {
    forcedKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    forcedKillTimer.unref();
  }
}

process.on("SIGTERM", () => forwardSignal("SIGTERM"));
process.on("SIGINT", () => forwardSignal("SIGINT"));
child.once("error", () => fail("pty_start_failed"));
child.once("exit", (code, signal) => {
  if (forcedKillTimer) clearTimeout(forcedKillTimer);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
