import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * The local terminal-agent token (spec 2692, "Calls from inside a terminal"): lets
 * `matrix shell …` inside a Matrix terminal call this gateway over loopback without a
 * cloud login. Owner-only, replaced on every start, and accepted only on the routes
 * below from a direct loopback caller.
 */
export const LOCAL_TERMINAL_TOKEN_RELATIVE_PATH = join(".cache", "matrix", "terminal-agent.token");

const ID = "[A-Za-z0-9_]{1,64}";
const LOCAL_ROUTES: Array<{ methods: readonly string[]; path: RegExp }> = [
  { methods: ["GET"], path: /^\/api\/terminal\/workspaces$/ },
  // Workspace resolution: the project list and opening a project's workspace.
  { methods: ["GET"], path: /^\/api\/coding-agents\/summary$/ },
  { methods: ["POST"], path: /^\/api\/terminal\/workspaces\/ensure$/ },
  { methods: ["GET"], path: new RegExp(`^/api/terminal/workspaces/${ID}/tabs/${ID}$`) },
  { methods: ["GET"], path: new RegExp(`^/api/terminal/workspaces/${ID}/tabs/${ID}/(?:read|agent)$`) },
  { methods: ["POST"], path: new RegExp(`^/api/terminal/workspaces/${ID}/tabs/${ID}/(?:send|keys|interrupt|wait)$`) },
  { methods: ["PATCH"], path: new RegExp(`^/api/terminal/workspaces/${ID}/tabs/${ID}/labels$`) },
  { methods: ["POST"], path: /^\/api\/terminal\/agents\/(?:run|report|resolve|wait-children)$/ },
  { methods: ["GET"], path: /^\/api\/terminal\/templates$/ },
];

export function isLocalTerminalAgentRoute(method: string, path: string): boolean {
  return LOCAL_ROUTES.some((route) => route.methods.includes(method) && route.path.test(path));
}

const PROXY_HEADERS = ["x-real-ip", "x-forwarded-for", "forwarded", "cf-connecting-ip", "x-platform-user-id", "x-platform-verified"];
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** A caller on this machine that reached the gateway directly, not through nginx or the platform. */
export function isDirectLoopbackCaller(
  remoteAddress: string | undefined,
  header: (name: string) => string | undefined,
): boolean {
  return remoteAddress !== undefined && LOOPBACK.has(remoteAddress) && PROXY_HEADERS.every((name) => header(name) === undefined);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("local terminal token directory is not a directory");
  if ((info.mode & 0o777) !== 0o700) await chmod(path, 0o700);
}

/** Writes a fresh token atomically (exclusive temp file, then rename); close removes it. */
export interface LocalTerminalAgentToken {
  token: string;
  close(): Promise<void>;
}

export async function createLocalTerminalAgentToken(input: { homePath: string }): Promise<LocalTerminalAgentToken> {
  const cache = join(input.homePath, ".cache");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const cacheInfo = await lstat(cache);
  if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink()) throw new Error("local terminal token directory is not a directory");
  const directory = join(cache, "matrix");
  await ensurePrivateDirectory(directory);
  const token = randomBytes(32).toString("hex");
  const file = join(input.homePath, LOCAL_TERMINAL_TOKEN_RELATIVE_PATH);
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  let renamed = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${token}\n`); }
    finally { await handle.close(); }
    await rename(temporary, file);
    renamed = true;
  } finally {
    if (!renamed) {
      await unlink(temporary).catch((error: unknown) => {
        if ((error as { code?: unknown }).code !== "ENOENT") console.warn("[terminal-agent] local token cleanup failed");
      });
    }
  }
  return {
    token,
    async close() {
      try {
        // A newer gateway may have replaced it; remove only our own token.
        if ((await readFile(file, "utf8")).trim() !== token) return;
        await unlink(file);
      }
      catch (error) {
        if ((error as { code?: unknown }).code !== "ENOENT") console.warn("[terminal-agent] local token removal failed");
      }
    },
  };
}
