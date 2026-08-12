#!/opt/matrix/runtime/node/bin/node
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const RUNTIME_ID_PATTERN = /^rt_[0-9a-f]{32}$/;
const GENERATION_PATTERN = /^gen_[0-9a-f]{64}$/;
const DESCRIPTOR_KEYS = new Set([
  "version", "runtimeId", "sessionName", "scope", "kind", "displayName",
  "cwd", "layoutPath", "environmentPath", "generation", "createdAt",
]);
const runtimeId = process.argv[2] ?? "";
const remainingArgs = process.argv.slice(3);
const homePath = resolve(process.env.MATRIX_HOME || process.env.HOME || "/home/matrix/home");
const runtimeRoot = resolve(process.env.MATRIX_TERMINAL_RUNTIME_ROOT || "/opt/matrix/terminal-runtime");

function fail(code) {
  process.stderr.write(`matrix-terminal-attach: ${code}\n`);
  process.exit(1);
}

function isWithin(base, candidate) {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function hasExactDescriptorKeys(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const keys = Object.keys(value);
  return keys.every((key) => DESCRIPTOR_KEYS.has(key))
    && keys.length === (value.environmentPath === undefined ? 10 : 11);
}

if (!RUNTIME_ID_PATTERN.test(runtimeId)) fail("runtime_id_invalid");
if (!(remainingArgs.length === 0 || (
  remainingArgs.length === 2 && remainingArgs[0] === "--index" && remainingArgs[1] === "0"
))) fail("attach_mode_invalid");

const descriptorPath = join(homePath, "system", "terminal-runtimes", `${runtimeId}.json`);
let descriptor;
try {
  const stats = lstatSync(descriptorPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_DESCRIPTOR_BYTES) fail("descriptor_invalid");
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
) fail("descriptor_invalid");

let zellijPath;
try {
  const runtimeReal = realpathSync(runtimeRoot);
  const generationRoot = join(runtimeRoot, "generations", descriptor.generation);
  const generationStats = lstatSync(generationRoot);
  const generationReal = realpathSync(generationRoot);
  zellijPath = join(generationRoot, "zellij");
  const zellijStats = lstatSync(zellijPath);
  const zellijReal = realpathSync(zellijPath);
  if (
    !generationStats.isDirectory()
    || generationStats.isSymbolicLink()
    || !isWithin(runtimeReal, generationReal)
    || !isWithin(generationReal, zellijReal)
    || !zellijStats.isFile()
    || zellijStats.isSymbolicLink()
    || (zellijStats.mode & 0o111) === 0
  ) fail("generation_invalid");
} catch (error) {
  if (!(error instanceof Error)) fail("runtime_asset_unavailable");
  fail("runtime_asset_unavailable");
}

const configDir = join(homePath, "system", "zellij");
const child = spawn(zellijPath, ["attach", descriptor.sessionName, ...remainingArgs], {
  cwd: homePath,
  env: {
    ...process.env,
    HOME: homePath,
    MATRIX_HOME: homePath,
    ZELLIJ_CONFIG_DIR: configDir,
    ZELLIJ_CONFIG_FILE: join(configDir, "config.kdl"),
    TERM: process.env.TERM || "xterm-256color",
    COLORTERM: process.env.COLORTERM || "truecolor",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`,
  },
  stdio: "inherit",
});

const forward = (signal) => {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
};
process.on("SIGTERM", () => forward("SIGTERM"));
process.on("SIGINT", () => forward("SIGINT"));
child.once("error", () => fail("attach_start_failed"));
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
