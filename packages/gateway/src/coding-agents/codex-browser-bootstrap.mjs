import { createCodexLeaseBootstrap } from "./codex-lease-bootstrap.mjs";
import { z } from "zod/v4";
import { lstat, mkdtemp, opendir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CodexBrowserLeaseSchema = z.object({
  attemptId: z.uuid(),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  gatewayPort: z.number().int().min(1).max(65535),
}).strict();
export const CodexBrowserBindSchema = CodexBrowserLeaseSchema.extend({
  type: z.literal("browser_bind"),
  clientRequestId: z.string().min(1).max(128),
});
export const CodexBrowserStartSchema = z.object({
  type: z.literal("browser_start"),
  attemptId: z.uuid(),
  clientRequestId: z.string().min(1).max(128),
}).strict();
export { MATRIX_SHARED_BROWSER_LAUNCH_POINTER as CODEX_BROWSER_INSTRUCTIONS } from "../../../contracts/matrix-agent-orientation.mjs";

export function codexBrowserThreadConfig(lease, options) {
  const transport = {
    command: "/opt/matrix/runtime/node/bin/node",
    args: ["/opt/matrix/app/packages/integrations-mcp/dist/shared-browser-cli.js"],
  };
  // Codex validates transport fields even when the server is disabled.
  return { "mcp_servers.matrix_shared_browser": lease ? {
    ...transport,
    env_vars: [options?.tokenFile ? "MATRIX_SHARED_BROWSER_TOKEN_FILE" : "MATRIX_SHARED_BROWSER_TOKEN", "MATRIX_SHARED_BROWSER_GATEWAY_PORT"],
    required: true,
    enabled_tools: ["shared_browser"],
    // This fixed broker tool owns its separate owner authorization gate.
    tools: { shared_browser: { approval_mode: "approve" } },
    startup_timeout_sec: 20,
    tool_timeout_sec: 390,
  } : { ...transport, enabled: false } };
}

export function codexBrowserChildEnvironment(environment, lease, tokenFilePath) {
  const env = { ...environment };
  delete env.MATRIX_SHARED_BROWSER_TOKEN;
  delete env.MATRIX_SHARED_BROWSER_TOKEN_FILE;
  delete env.MATRIX_SHARED_BROWSER_GATEWAY_PORT;
  if (lease) Object.assign(env, {
    // With a token file the raw bearer never enters the app-server environment.
    ...(tokenFilePath ? { MATRIX_SHARED_BROWSER_TOKEN_FILE: tokenFilePath } : { MATRIX_SHARED_BROWSER_TOKEN: lease.token }),
    MATRIX_SHARED_BROWSER_GATEWAY_PORT: String(lease.gatewayPort),
  });
  return env;
}

/**
 * Runner-owned private bearer file for the Codex Browser MCP server. The runner
 * writes each admitted run's bearer before its turn and removes it after, so a
 * follow-up renews per-run authority without restarting the native app-server.
 * Cleanup: `clear()` after every turn, `close()` removes the directory at exit.
 */
export async function createCodexBrowserTokenFile(enabled) {
  if (!enabled) return undefined;
  // Created 0700. The runner pid lets the gateway sweep a SIGKILLed runner's leftovers.
  const dir = await mkdtemp(join(tmpdir(), `matrix-codex-browser-${process.pid}-`));
  const path = join(dir, "token");
  let sequence = 0;
  return {
    path,
    async write(token) {
      const parsed = CodexBrowserLeaseSchema.shape.token.parse(token);
      const temp = join(dir, `token.${++sequence}`);
      await writeFile(temp, parsed, { mode: 0o600, flag: "wx" });
      await rename(temp, path);
    },
    async clear() { await rm(path, { force: true }); },
    async close() { await rm(dir, { recursive: true, force: true }); },
  };
}

/** Same gateway and an existing Browser server: rewrite the bearer instead of restarting. */
export function canRenewCodexBrowserInPlace(current, next, tokenFile) {
  return Boolean(tokenFile && current && next && current.gatewayPort === next.gatewayPort);
}

export function createCodexBrowserBootstrap(attemptId) {
  return createCodexLeaseBootstrap(attemptId, CodexBrowserLeaseSchema, "Browser startup unavailable");
}

const TOKEN_DIR_PATTERN = /^matrix-codex-browser-(\d{1,10})-[A-Za-z0-9]{6}$/;
const MAX_SWEEP_ENTRIES = 10_000;

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: a live process of another user. Only ESRCH proves it is gone.
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

/**
 * Remove Browser bearer directories left by runners that died without their
 * own cleanup (SIGKILL). Only this user's real directories (lstat, never a
 * symlink) older than minAgeMs whose runner pid is gone. Their bearers were
 * already revoked by the broker when the run's lease closed.
 */
export async function sweepCodexBrowserTokenDirs(options = {}) {
  const root = options.root ?? tmpdir();
  const now = options.now ?? Date.now();
  const minAgeMs = options.minAgeMs ?? 60_000;
  const isAlive = options.isAlive ?? processAlive;
  const uid = process.getuid?.();
  if (uid === undefined) return 0;
  let removed = 0;
  let scanned = 0;
  const directory = await opendir(root);
  for await (const entry of directory) {
    if (++scanned > MAX_SWEEP_ENTRIES) break;
    const match = TOKEN_DIR_PATTERN.exec(entry.name);
    if (!match) continue;
    const path = join(root, entry.name);
    let info;
    try { info = await lstat(path); } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || now - info.mtimeMs < minAgeMs) continue;
    if (isAlive(Number(match[1]))) continue;
    await rm(path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
