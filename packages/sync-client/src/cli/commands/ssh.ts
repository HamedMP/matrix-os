import { spawn } from "node:child_process";

const DEFAULT_SSH_HOST = "ssh.matrix-os.com";
const DEFAULT_SSH_PORT = 2222;

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

  const data = (await response.json()) as { host: string; port: number; user: string };
  return { host: data.host, port: data.port, user: data.user };
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
