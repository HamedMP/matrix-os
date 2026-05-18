import { spawn } from "node:child_process";
import { defineCommand } from "citty";
import { z } from "zod/v4";
import { loadProfileAuth } from "../../auth/token-store.js";
import { resolveCliProfile } from "../profiles.js";

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?!-)(?:[A-Za-z0-9-]{1,63}\.)*[A-Za-z0-9-]{1,63}$/;
const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_PATTERN = /^[A-Fa-f0-9:]+$/;
const SSH_USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,31}$/;
const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_SESSION_NAME = "matrix-main";

const SshTargetSchema = z.object({
  host: z.string().refine((value) =>
    HOSTNAME_PATTERN.test(value) || IPV4_PATTERN.test(value) || IPV6_PATTERN.test(value),
  "Invalid SSH host"),
  port: z.number().int().min(1).max(65_535),
  user: z.string().regex(SSH_USER_PATTERN, "Invalid SSH user"),
  sessionName: z.string().regex(SESSION_NAME_PATTERN, "Invalid SSH session name").default(DEFAULT_SESSION_NAME),
});

export interface SshOptions {
  handle?: string;
  platformUrl: string;
  token: string;
}

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  sessionName: string;
}

export async function resolveTarget(options: SshOptions): Promise<SshTarget> {
  const { handle, platformUrl, token } = options;
  const cleanHandle = handle?.replace(/^@/, "") ?? "";
  const url = new URL("/api/ssh/resolve", platformUrl);
  if (cleanHandle) {
    url.searchParams.set("handle", cleanHandle);
  }

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error("ssh_target_unavailable");
  }

  const parsed = SshTargetSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Platform returned an invalid SSH target");
  }
  return parsed.data;
}

export function remoteAttachCommand(sessionName: string = DEFAULT_SESSION_NAME): string {
  return [
    "if command -v zellij >/dev/null 2>&1; then",
    `zellij attach ${sessionName} || exec zellij --session ${sessionName};`,
    "elif command -v tmux >/dev/null 2>&1; then",
    `tmux attach -t ${sessionName} 2>/dev/null || exec tmux new-session -s ${sessionName};`,
    "else",
    'exec "${SHELL:-/bin/bash}" -l;',
    "fi",
  ].join(" ");
}

export function spawnSsh(target: SshTarget, options: { raw?: boolean } = {}): ReturnType<typeof spawn> {
  const args = [
    "-p", String(target.port),
    "-o", "StrictHostKeyChecking=ask",
  ];

  if (!options.raw) {
    args.push("-t");
  }

  args.push(
    `${target.user}@${target.host}`,
  );

  if (!options.raw) {
    args.push(remoteAttachCommand(target.sessionName));
  }

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
    raw: {
      type: "boolean",
      description: "Open a plain SSH login shell instead of attaching Matrix's default session",
      required: false,
      default: false,
    },
    profile: { type: "string", required: false },
    dev: { type: "boolean", required: false, default: false },
    platform: { type: "string", required: false },
    gateway: { type: "string", required: false },
    token: { type: "string", required: false },
  },
  run: async ({ args }) => {
    const profile = await resolveCliProfile(args);
    const auth = profile.token ? null : await loadProfileAuth(profile.name);
    const token = profile.token ?? auth?.accessToken;
    if (!token) {
      console.error(`Not logged in for profile "${profile.name}". Run \`matrix login\` first.`);
      process.exitCode = 1;
      return;
    }

    let target: SshTarget;
    try {
      target = await resolveTarget({
        handle: args.handle as string | undefined,
        platformUrl: profile.platformUrl,
        token,
      });
    } catch (err) {
      console.error("Could not resolve SSH target for this profile.");
      process.exitCode = 1;
      return;
    }

    console.log(`Connecting to ${target.user}@${target.host}:${target.port}...`);
    const child = spawnSsh(target, { raw: args.raw === true });

    child.on("exit", (code) => {
      process.exitCode = code ?? 0;
    });
  },
});
