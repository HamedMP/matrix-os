import { spawn } from "node:child_process";
import { defineCommand } from "citty";
import { z } from "zod/v4";
import { loadAuth } from "../../auth/token-store.js";
import { loadConfig } from "../../lib/config.js";

const DEFAULT_SSH_HOST = "ssh.matrix-os.com";
const DEFAULT_SSH_PORT = 2222;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?!-)(?:[A-Za-z0-9-]{1,63}\.)*[A-Za-z0-9-]{1,63}$/;
const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_PATTERN = /^[A-Fa-f0-9:]+$/;
const SSH_USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,31}$/;

const SshTargetSchema = z.object({
  host: z.string().refine((value) =>
    HOSTNAME_PATTERN.test(value) || IPV4_PATTERN.test(value) || IPV6_PATTERN.test(value),
  "Invalid SSH host"),
  port: z.number().int().min(1).max(65_535),
  user: z.string().regex(SSH_USER_PATTERN, "Invalid SSH user"),
});

export interface SshOptions {
  handle?: string;
  gatewayUrl: string;
  token: string;
}

export interface SshTarget {
  host: string;
  port: number;
  user: string;
}

export async function resolveTarget(options: SshOptions): Promise<SshTarget> {
  const { handle, gatewayUrl, token } = options;

  if (!handle) {
    return { host: DEFAULT_SSH_HOST, port: DEFAULT_SSH_PORT, user: "matrixos" };
  }

  const cleanHandle = handle.replace(/^@/, "");
  const url = new URL("/api/ssh/resolve", gatewayUrl);
  url.searchParams.set("handle", cleanHandle);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to resolve SSH target for ${handle}: ${response.status}`);
  }

  const parsed = SshTargetSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Platform returned an invalid SSH target");
  }
  return parsed.data;
}

export function spawnSsh(target: SshTarget): ReturnType<typeof spawn> {
  const args = [
    "-p", String(target.port),
    "-o", "StrictHostKeyChecking=accept-new",
    `${target.user}@${target.host}`,
    // Auto-attach to tmux session if available
    "-t", "tmux attach -t main 2>/dev/null || tmux new-session -s main",
  ];

  return spawn("ssh", args, {
    stdio: "inherit",
  });
}

export const sshCommand = defineCommand({
  meta: { name: "ssh", description: "SSH into a Matrix OS instance" },
  args: {
    handle: {
      type: "positional",
      description: "User handle to connect to (default: your own instance)",
      required: false,
    },
  },
  run: async ({ args }) => {
    const auth = await loadAuth();
    if (!auth) {
      console.error("Not logged in. Run `matrixos login` first.");
      process.exitCode = 1;
      return;
    }

    const config = await loadConfig();
    const gatewayUrl = config?.gatewayUrl ?? "https://matrix-os.com";

    const target = await resolveTarget({
      handle: args.handle as string | undefined,
      gatewayUrl,
      token: auth.accessToken,
    });

    console.log(`Connecting to ${target.user}@${target.host}:${target.port}...`);
    const child = spawnSsh(target);

    child.on("exit", (code) => {
      process.exitCode = code ?? 0;
    });
  },
});
