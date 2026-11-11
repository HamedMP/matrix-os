import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { Writable } from "node:stream";
import { buildIsolatedProviderLaunch, spawnIsolatedProviderProcess } from "../coding-agents/provider-process-isolation.js";
import type { CanonicalCliProcess } from "./cli-process.js";
import { NATIVE_SHARED_BROWSER_TOOL } from "./native-shared-browser-run.js";

const PYTHON = "/usr/bin/python3";
const BUBBLEWRAP = "/usr/bin/bwrap";
const HELPER = "/usr/local/libexec/matrix-claude-native-recovery/launch.py";
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const ARGUMENT_FLAGS = new Set(["--strict-mcp-config", "--no-chrome", "--print", "--verbose", "--include-partial-messages"]);
const ARGUMENT_VALUES = new Set(["--setting-sources", "--settings", "--permission-mode", "--append-system-prompt",
  "--model", "--effort", "--output-format", "--input-format", "--permission-prompt-tool", "--allowedTools"]);
const FORBIDDEN_ENV = ["CLAUDE_CONFIG_DIR", "NODE_OPTIONS", "MATRIX_AUTH_TOKEN", "UPGRADE_TOKEN",
  "MATRIX_CODE_PROXY_TOKEN", "AI_RELAY_CONTROL_TOKEN", "MATRIX_AGENT_INTEGRATIONS_TOKEN", "MATRIX_SHARED_BROWSER_TOKEN",
  "MATRIX_SHARED_BROWSER_GATEWAY_PORT", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"];
const unavailable = () => new Error("Protected Claude recovery unavailable");

type ProtectedChild = CanonicalCliProcess & { stdio: readonly unknown[] };
type SpawnScoped = (command: string, args: string[], options: {
  cwd: string; env: Record<string, string>; stdio: ["pipe", "pipe", "pipe", "pipe"]; requireIsolation: true;
}) => ProtectedChild;

function protectedRegularFile(path: string): boolean {
  const file = lstatSync(path);
  if (!file.isFile() || file.uid !== 0 || (file.mode & 0o022) !== 0) return false;
  for (let parent = dirname(path); parent !== "/"; parent = dirname(parent)) {
    const directory = lstatSync(parent);
    if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o022) !== 0) return false;
  }
  return true;
}

export function canLaunchProtectedClaudeRecovery(): boolean {
  if (!buildIsolatedProviderLaunch({ command: PYTHON, args: [], env: {} }).isolated) return false;
  try {
    accessSync(PYTHON, constants.X_OK);
    accessSync(BUBBLEWRAP, constants.X_OK);
    return protectedRegularFile(HELPER) && protectedRegularFile(realpathSync(PYTHON)) && protectedRegularFile(realpathSync(BUBBLEWRAP));
  } catch (error: unknown) {
    console.warn("[claude-native] Protected recovery assets unavailable", typeof error);
    return false;
  }
}

/** An allowlist protects the private launch from accidentally inheriting a foreground prompt or Run grants. */
function validArguments(args: string[]): boolean {
  if (args.length > 32) return false;
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]!;
    if (parsed.has(name)) return false;
    if (ARGUMENT_FLAGS.has(name)) {
      parsed.set(name, "");
    } else {
      const value = args[index + 1];
      if (!ARGUMENT_VALUES.has(name) || value === undefined || value.startsWith("--")
        || value.includes("\0") || Buffer.byteLength(value) > 64_000) return false;
      // An admitted Run can install its own browser lease later. Idle MCP stays empty.
      if (name === "--allowedTools" && value !== NATIVE_SHARED_BROWSER_TOOL) return false;
      parsed.set(name, value);
      index += 1;
    }
  }
  return [...ARGUMENT_FLAGS].every(name => parsed.has(name)) && parsed.get("--setting-sources") === ""
    && parsed.get("--input-format") === "stream-json" && parsed.get("--output-format") === "stream-json"
    && parsed.get("--permission-prompt-tool") === "stdio" && parsed.has("--permission-mode") && parsed.has("--settings");
}

/** Transfer the in-memory replay on the owned descriptor. Only the helper can select the resume path. */
export function spawnProtectedClaudeRecovery(input: {
  command: string; args: string[]; cwd: string; env: Record<string, string>; transcript: Uint8Array;
}, dependencies: { spawnScoped?: SpawnScoped } = {}): CanonicalCliProcess {
  if (!isAbsolute(input.command) || !isAbsolute(input.cwd) || !isAbsolute(input.env.HOME ?? "")
    || [input.command, input.cwd, input.env.HOME].some(value => value?.includes("\0"))
    || FORBIDDEN_ENV.some(name => name in input.env) || !validArguments(input.args)
    || input.transcript.byteLength === 0 || input.transcript.byteLength > MAX_TRANSCRIPT_BYTES
    || (!dependencies.spawnScoped && !canLaunchProtectedClaudeRecovery())) throw unavailable();

  const spawnScoped = dependencies.spawnScoped ?? spawnIsolatedProviderProcess;
  const child = spawnScoped(PYTHON, ["-I", "-S", "-B", HELPER, input.command, ...input.args], {
    cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe", "pipe"], requireIsolation: true,
  });
  const descriptor = child.stdio[3];
  if (!(descriptor instanceof Writable)) {
    child.kill("SIGKILL");
    throw unavailable();
  }
  descriptor.on("error", () => child.kill("SIGKILL"));
  descriptor.end(Buffer.from(input.transcript));
  return child;
}
