import { join } from "node:path";
import {
  GithubDeveloperStatusSchema,
  type GithubDeveloperStatus,
  type GithubDeveloperStatusErrorCode,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

const COMMAND_TIMEOUT_MS = 10_000;
const SSH_TIMEOUT_MS = 15_000;
const STATUS_OUTPUT_BYTES = 64 * 1024;

const GithubLoginSchema = z.string().trim().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);
const GitIdentityNameSchema = z.string().trim().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
const GitIdentityEmailSchema = z.email().max(320);

export type GithubStatusCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

function commandErrorCode(error: unknown): string | number | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? code : null;
}

function boundedCommandOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const record = error as { stdout?: unknown; stderr?: unknown };
  return `${typeof record.stdout === "string" ? record.stdout : ""}\n${typeof record.stderr === "string" ? record.stderr : ""}`
    .slice(0, STATUS_OUTPUT_BYTES);
}

function isGithubSshGreeting(value: string): boolean {
  return /^Hi [A-Za-z0-9](?:[A-Za-z0-9-]{0,38})! You've successfully authenticated, but GitHub does not provide shell access\.$/m
    .test(value.slice(0, STATUS_OUTPUT_BYTES));
}

export async function getGithubDeveloperStatus(input: {
  homePath: string;
  runCommand: GithubStatusCommandRunner;
}): Promise<GithubDeveloperStatus> {
  const { homePath, runCommand } = input;
  let installed = false;
  let authenticated = false;
  let user: string | null = null;
  let gitProtocol: "ssh" | "https" | null = null;

  try {
    await runCommand("gh", ["--version"], {
      cwd: homePath,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: STATUS_OUTPUT_BYTES,
    });
    installed = true;
  } catch (error: unknown) {
    console.warn("[github-developer-status] gh not available", error instanceof Error ? error.name : "UnknownError");
  }

  if (installed) {
    try {
      await runCommand("gh", ["auth", "status", "--hostname", "github.com"], {
        cwd: homePath,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: STATUS_OUTPUT_BYTES,
      });
      authenticated = true;
    } catch (error: unknown) {
      console.warn("[github-developer-status] gh auth unavailable", error instanceof Error ? error.name : "UnknownError");
    }
  }

  if (authenticated) {
    try {
      const [protocolResult, userResult] = await Promise.all([
        runCommand("gh", ["config", "get", "git_protocol", "--host", "github.com"], {
          cwd: homePath,
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: STATUS_OUTPUT_BYTES,
        }),
        runCommand("gh", ["api", "user", "--jq", ".login"], {
          cwd: homePath,
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: STATUS_OUTPUT_BYTES,
        }),
      ]);
      const protocol = protocolResult.stdout.trim();
      gitProtocol = protocol === "ssh" || protocol === "https" ? protocol : null;
      const parsedUser = GithubLoginSchema.safeParse(userResult.stdout);
      user = parsedUser.success ? parsedUser.data : null;
    } catch (error: unknown) {
      console.warn(
        "[github-developer-status] GitHub account status unavailable",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
  }

  let sshStatus: GithubDeveloperStatus["sshStatus"] = "setup_required";
  const knownHostsPath = join(homePath, ".ssh", "matrix-github-known-hosts");
  try {
    const result = await runCommand("ssh", [
      "-T",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${knownHostsPath}`,
      "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=10",
      "-o", "ConnectionAttempts=1",
      "git@github.com",
    ], {
      cwd: homePath,
      timeout: SSH_TIMEOUT_MS,
      maxBuffer: STATUS_OUTPUT_BYTES,
    });
    sshStatus = isGithubSshGreeting(`${result.stdout}\n${result.stderr}`) ? "verified" : "setup_required";
  } catch (error: unknown) {
    if (isGithubSshGreeting(boundedCommandOutput(error))) {
      sshStatus = "verified";
    } else {
      sshStatus = commandErrorCode(error) === "ENOENT" ? "unavailable" : "setup_required";
    }
  }

  async function globalIdentityValue(key: "user.name" | "user.email"): Promise<
    { kind: "value"; value: string } | { kind: "missing" } | { kind: "unavailable" }
  > {
    try {
      const result = await runCommand("git", ["config", "--global", "--get", key], {
        cwd: homePath,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: STATUS_OUTPUT_BYTES,
      });
      return { kind: "value", value: result.stdout.trim() };
    } catch (error: unknown) {
      return commandErrorCode(error) === 1 ? { kind: "missing" } : { kind: "unavailable" };
    }
  }

  const [nameResult, emailResult] = await Promise.all([
    globalIdentityValue("user.name"),
    globalIdentityValue("user.email"),
  ]);
  let commitIdentity: GithubDeveloperStatus["commitIdentity"];
  if (nameResult.kind === "unavailable" || emailResult.kind === "unavailable") {
    commitIdentity = { status: "unavailable", label: null };
  } else if (
    nameResult.kind === "missing"
    || emailResult.kind === "missing"
    || !GitIdentityNameSchema.safeParse(nameResult.value).success
    || !GitIdentityEmailSchema.safeParse(emailResult.value).success
  ) {
    commitIdentity = { status: "missing", label: null };
  } else {
    commitIdentity = {
      status: "ready",
      label: `${nameResult.value} <${emailResult.value}>`,
    };
  }

  const ready = installed
    && authenticated
    && user !== null
    && gitProtocol === "ssh"
    && sshStatus === "verified"
    && commitIdentity.status === "ready";
  let errorCode: GithubDeveloperStatusErrorCode | null = null;
  if (!installed) errorCode = "gh_missing";
  else if (!authenticated) errorCode = "github_auth_required";
  else if (user === null || gitProtocol === null) errorCode = "github_status_unavailable";
  else if (gitProtocol !== "ssh") errorCode = "github_ssh_protocol_required";
  else if (sshStatus === "unavailable") errorCode = "github_ssh_unavailable";
  else if (sshStatus !== "verified") errorCode = "github_ssh_setup_required";
  else if (commitIdentity.status === "unavailable") errorCode = "git_identity_unavailable";
  else if (commitIdentity.status !== "ready") errorCode = "git_identity_missing";

  return GithubDeveloperStatusSchema.parse({
    installed,
    authenticated,
    user,
    gitProtocol,
    sshStatus,
    commitIdentity,
    ready,
    errorCode,
  });
}
