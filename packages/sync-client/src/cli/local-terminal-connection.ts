import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { requireCliAuthToken } from "./auth-state.js";
import { resolveCliProfile } from "./profiles.js";
import { terminalCallerFromEnv } from "./terminal-agent-client.js";

const TOKEN = /^[a-f0-9]{64}$/;
const PORT = /^[1-9][0-9]{0,4}$/;

function unavailable(): Error {
  return Object.assign(new Error("local_gateway_unavailable"), { code: "local_gateway_unavailable" });
}

/**
 * Inside a Matrix terminal, terminal-agent commands call this machine's own gateway
 * with the owner-only local token the gateway writes at start (spec 2692, "Calls from
 * inside a terminal"). Returns null when a profile applies: an explicit profile,
 * gateway or token flag, or a caller outside a Matrix pane.
 */
export async function resolveLocalTerminalConnection(
  flags: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ gatewayUrl: string; token: string } | null> {
  if (flags.dev === true || ["profile", "gateway", "token"].some((name) => typeof flags[name] === "string")) return null;
  if (!terminalCallerFromEnv(env)) return null;
  const home = env.MATRIX_HOME || env.HOME || homedir();
  const path = join(home, ".cache", "matrix", "terminal-agent.token");
  let token: string;
  try {
    const info = await lstat(path);
    // Owner-only regular file: anything else was not written by the gateway.
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 128) throw unavailable();
    token = (await readFile(path, "utf8")).trim();
  } catch (error) {
    const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
    if (code !== "local_gateway_unavailable" && code !== "ENOENT") {
      console.warn("[matrix] local terminal token unreadable:", typeof code === "string" ? code : "unknown_error");
    }
    throw unavailable();
  }
  if (!TOKEN.test(token)) throw unavailable();
  const port = PORT.test(env.PORT ?? "") && Number(env.PORT) <= 65_535 ? env.PORT : "4000";
  return { gatewayUrl: `http://127.0.0.1:${port}`, token };
}

/** The gateway and token for terminal-agent commands: this machine's inside a Matrix pane, else the profile's. */
export async function resolveTerminalAgentCliConnection(flags: Record<string, unknown>): Promise<{ gatewayUrl: string; token: string }> {
  const local = await resolveLocalTerminalConnection(flags);
  if (local) return local;
  const profile = await resolveCliProfile(flags);
  return { gatewayUrl: profile.gatewayUrl, token: await requireCliAuthToken(profile) };
}
