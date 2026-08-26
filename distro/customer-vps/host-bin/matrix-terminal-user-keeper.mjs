#!/opt/matrix/runtime/node/bin/node
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const SESSION_START_TIMEOUT_MS = 10_000;
const FORCED_KILL_DELAY_MS = 2_000;
const RUNTIME_ID_PATTERN = /^rt_[0-9a-f]{32}$/;
const GENERATION_PATTERN = /^gen_[0-9a-f]{64}$/;
const DESCRIPTOR_KEYS = new Set([
  "version", "runtimeId", "sessionName", "scope", "kind", "displayName",
  "cwd", "layoutPath", "environmentPath", "generation", "createdAt",
]);
const ENVIRONMENT_KEYS = new Set(["HOME", "MATRIX_HOME", "MATRIX_NODE_PREFIX", "PATH"]);
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

function hasExactDescriptorKeys(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const keys = Object.keys(value);
  return keys.every((key) => DESCRIPTOR_KEYS.has(key))
    && keys.length === (value.environmentPath === undefined ? 10 : 11);
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
  !hasExactDescriptorKeys(descriptor)
  || descriptor.version !== 1
  || descriptor.runtimeId !== runtimeId
  || descriptor.sessionName !== `matrix-${runtimeId}`
  || (descriptor.scope !== "terminal" && descriptor.scope !== "workspace")
  || (descriptor.kind !== "shell" && descriptor.kind !== "agent")
  || typeof descriptor.displayName !== "string"
  || typeof descriptor.cwd !== "string"
  || typeof descriptor.layoutPath !== "string"
  || (descriptor.environmentPath !== undefined && typeof descriptor.environmentPath !== "string")
  || !GENERATION_PATTERN.test(descriptor.generation ?? "")
  || typeof descriptor.createdAt !== "string"
) {
  fail("descriptor_invalid");
}

const pinnedKeeperPath = join(
  runtimeRoot,
  "generations", descriptor.generation, "matrix-terminal-user-keeper.mjs",
);
try {
  const currentKeeper = realpathSync(fileURLToPath(import.meta.url));
  const pinnedKeeper = realpathSync(pinnedKeeperPath);
  if (currentKeeper !== pinnedKeeper) {
    const pinned = spawn("/opt/matrix/runtime/node/bin/node", [pinnedKeeper, runtimeId], {
      env: process.env,
      stdio: "inherit",
    });
    const forwardPinnedSignal = (signal) => {
      if (pinned.exitCode === null && pinned.signalCode === null) pinned.kill(signal);
    };
    process.on("SIGTERM", () => forwardPinnedSignal("SIGTERM"));
    process.on("SIGINT", () => forwardPinnedSignal("SIGINT"));
    pinned.once("error", () => fail("keeper_generation_unavailable"));
    pinned.once("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 1);
    });
    await new Promise(() => undefined);
  }
} catch (error) {
  if (!(error instanceof Error)) fail("keeper_generation_unavailable");
  fail("keeper_generation_unavailable");
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
    if (entries.length > ENVIRONMENT_KEYS.size || entries.some(([key, value]) => (
      !ENVIRONMENT_KEYS.has(key)
      || typeof value !== "string"
      || value.length > 8192
      || value.includes("\0")
    ))) fail("environment_invalid");
    launchEnvironment = parsedEnvironment;
  }
} catch (error) {
  if (!(error instanceof Error)) fail("runtime_asset_unavailable");
  fail("runtime_asset_unavailable");
}

const configDir = join(homePath, "system", "zellij");
const childOptions = {
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
};

let child;
let forcedKillTimer;
let requestedSignal;
function forwardSignal(signal) {
  requestedSignal ??= signal;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  if (!forcedKillTimer) {
    forcedKillTimer = setTimeout(() => child?.kill("SIGKILL"), FORCED_KILL_DELAY_MS);
    forcedKillTimer.unref();
  }
}

function exitAfterChild(code, signal) {
  if (forcedKillTimer) clearTimeout(forcedKillTimer);
  const exitSignal = requestedSignal ?? signal;
  if (exitSignal) {
    process.off("SIGTERM", handleSigterm);
    process.off("SIGINT", handleSigint);
    process.kill(process.pid, exitSignal);
    return;
  }
  process.exit(code ?? 1);
}

function handleSigterm() {
  forwardSignal("SIGTERM");
}

function handleSigint() {
  forwardSignal("SIGINT");
}

process.on("SIGTERM", handleSigterm);
process.on("SIGINT", handleSigint);

// Start the server without a persistent interactive client. Zellij computes its
// shared grid as the component-wise minimum across interactive clients, so the
// old headless 80x24 client permanently constrained every browser attachment.
const starterArgs = [
  "--new-session-with-layout",
  layoutPath,
  "attach", "--create-background", descriptor.sessionName,
];
const starterCommand = [zellijPath, ...starterArgs].map(shellQuote).join(" ");
child = spawn("/usr/bin/script", ["-qefc", starterCommand, "/dev/null"], {
  ...childOptions,
  stdio: "ignore",
});

await new Promise((resolveStart) => {
  let startTimedOut = false;
  const startTimer = setTimeout(() => {
    startTimedOut = true;
    child.kill("SIGKILL");
  }, SESSION_START_TIMEOUT_MS);
  startTimer.unref();

  child.once("error", () => {
    clearTimeout(startTimer);
    fail("session_start_failed");
  });
  child.once("exit", (_code, signal) => {
    clearTimeout(startTimer);
    if (requestedSignal || signal) exitAfterChild(null, signal);
    if (startTimedOut) fail("session_start_timeout");
    resolveStart();
  });
});
if (requestedSignal) exitAfterChild(null, null);

// A watcher keeps the user unit active and the Zellij server in its cgroup,
// while remaining excluded from Zellij's interactive-client size arbitration.
const watcherCommand = [zellijPath, "watch", descriptor.sessionName]
  .map(shellQuote)
  .join(" ");
child = spawn("/usr/bin/script", ["-qefc", watcherCommand, "/dev/null"], {
  ...childOptions,
  // Keep the watcher's input open. `stdio: "ignore"` maps stdin to
  // `/dev/null`, so `script` forwards EOF to `zellij watch` and the user unit
  // exits immediately after the startup readiness probe succeeds.
  stdio: ["pipe", "ignore", "ignore"],
});
child.once("error", () => fail("pty_start_failed"));
child.once("exit", (code, signal) => exitAfterChild(code, signal));
