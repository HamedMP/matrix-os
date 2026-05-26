import { defineCommand } from "citty";
import { randomUUID } from "node:crypto";
import { isExpired, loadProfileAuth } from "../../auth/token-store.js";
import { resolveCliProfile } from "../profiles.js";
import { formatCliError, formatCliSuccess } from "../output.js";
import { createShellClient, type ShellClient } from "../shell-client.js";

const RUN_USAGE = "Usage: matrix run -it [--session <name>] [-C <dir>] -- <command>";
const RUN_VALUE_OPTIONS = new Set(["--gateway", "--profile", "--token", "--session", "-C", "--cwd"]);

async function clientFromArgs(args: Record<string, unknown>) {
  const profile = await resolveCliProfile(args);
  const auth = profile.token ? null : await loadProfileAuth(profile.name);
  const token = profile.token ?? (auth && !isExpired(auth) ? auth.accessToken : undefined);
  if (!token) {
    throw Object.assign(
      new Error(`Not logged in for profile "${profile.name}". Run \`matrix login\` first.`),
      { code: "not_authenticated" },
    );
  }
  return createShellClient({ gatewayUrl: profile.gatewayUrl, token });
}

export function parseRunCommand(rawArgs: string[] | undefined): string[] {
  if (!Array.isArray(rawArgs)) {
    return [];
  }
  const separator = rawArgs.indexOf("--");
  if (separator >= 0) {
    return rawArgs.slice(separator + 1);
  }
  const command: string[] = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "-i" || arg === "-t" || arg === "-it" || arg === "--interactive") {
      continue;
    }
    const [option] = arg.split("=", 1);
    if (RUN_VALUE_OPTIONS.has(option)) {
      if (!arg.includes("=")) {
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--")) {
      continue;
    }
    command.push(arg);
  }
  return command;
}

export function quoteCommandArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function createEphemeralSessionName(): string {
  return `run-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function isSessionExistsError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code?: unknown }).code === "session_exists";
}

export async function createOrAttachRunSession(
  client: Pick<ShellClient, "createSession" | "attachSession">,
  input: {
    name: string;
    command: string[];
    cwd?: string;
    sessionProvided: boolean;
  },
): Promise<{ detached: boolean }> {
  try {
    await client.createSession({
      name: input.name,
      cwd: input.cwd,
      cmd: input.command.map(quoteCommandArg).join(" "),
    });
  } catch (err) {
    if (!input.sessionProvided || !isSessionExistsError(err)) {
      throw err;
    }
  }
  return await client.attachSession(input.name);
}

function isInteractive(args: Record<string, unknown>, rawArgs: string[] | undefined): boolean {
  if (args.interactive === true || args.i === true || args.t === true) {
    return true;
  }
  return Array.isArray(rawArgs) && rawArgs.some((arg) => arg === "-it" || arg === "-ti");
}

function writeError(err: unknown, json: boolean): void {
  const code =
    err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "request_failed";
  const safeMessage =
    code === "not_authenticated" || code === "invalid_request" || code === "not_implemented"
      ? err instanceof Error ? err.message : undefined
      : undefined;
  console.error(json ? formatCliError(code, safeMessage) : safeMessage ?? `Error: Request failed (${code})`);
}

export const runCommand = defineCommand({
  meta: {
    name: "run",
    description: "Run a command on your Matrix computer",
  },
  args: {
    interactive: {
      type: "boolean",
      alias: "i",
      required: false,
      default: false,
      description: "Attach an interactive terminal to the remote command",
    },
    t: {
      type: "boolean",
      required: false,
      default: false,
      description: "Request a TTY; combine with -i as -it",
    },
    session: {
      type: "string",
      required: false,
      description: "Named shell session to create or attach",
    },
    cwd: {
      type: "string",
      alias: "C",
      required: false,
      description: "Working directory inside the Matrix home",
    },
    profile: { type: "string", required: false },
    dev: { type: "boolean", required: false, default: false },
    gateway: { type: "string", required: false },
    token: { type: "string", required: false },
    json: { type: "boolean", required: false, default: false },
  },
  run: async ({ args, rawArgs }) => {
    const json = args.json === true;
    try {
      const command = parseRunCommand(rawArgs);
      if (command.length === 0) {
        throw Object.assign(new Error(RUN_USAGE), { code: "invalid_request" });
      }
      if (!isInteractive(args, rawArgs)) {
        throw Object.assign(
          new Error("Non-interactive matrix run will use the same zellij session primitive, but this gateway does not expose remote exit status yet. Use `matrix run -it -- <command>` for now."),
          { code: "not_implemented" },
        );
      }

      const sessionProvided = typeof args.session === "string";
      const name = sessionProvided ? args.session as string : createEphemeralSessionName();
      const client = await clientFromArgs(args);
      const result = await createOrAttachRunSession(client, {
        name,
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        command,
        sessionProvided,
      });
      console.log(
        json
          ? formatCliSuccess({ detached: result.detached, session: name })
          : `Detached. Reattach: matrix shell attach ${name}`,
      );
    } catch (err) {
      writeError(err, json);
      process.exitCode = 1;
    }
  },
});
