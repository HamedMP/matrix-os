import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const TEST_GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: { ...process.env, ...TEST_GIT_ENV } });
  return stdout.trim();
}

/**
 * Mirrors the gateway's POST /api/terminal/run limits (RunBodySchema plus the
 * 16 KB body limit) so fakes reject what production rejects.
 */
export function assertGatewayRunBody(body: { command: string[]; cwd?: string; timeoutMs?: number }): void {
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json) > 16_384) throw new Error(`run body too large: ${Buffer.byteLength(json)}`);
  if (body.command.length < 1 || body.command.length > 64) throw new Error("run command must have 1-64 items");
  for (const [index, item] of body.command.entries()) {
    if (item.length < 1 || item.length > 4096) throw new Error(`run command item ${index} must be 1-4096 chars (got ${item.length})`);
  }
  if (body.cwd !== undefined) {
    if (body.cwd.length < 1 || body.cwd.length > 1024 || body.cwd.startsWith("/") || body.cwd.split(/[\\/]+/).includes("..")) {
      throw new Error("run cwd is invalid");
    }
  }
  if (body.timeoutMs !== undefined && (!Number.isInteger(body.timeoutMs) || body.timeoutMs < 1 || body.timeoutMs > 30 * 60_000)) {
    throw new Error("run timeout is invalid");
  }
}
