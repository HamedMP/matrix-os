import { defineCommand } from "citty";
import { randomUUID } from "node:crypto";
import { resolveCliProfile } from "../profiles.js";
import { formatCliError, formatCliErrorMessage, formatCliSuccess } from "../output.js";
import { createShellClient, type ShellAttachOptions, type ShellClient } from "../shell-client.js";
import { requireCliAuthToken } from "../auth-state.js";

const RUN_USAGE = "Usage: matrix run [-it] [--session <name>] [-C <dir>] -- <command>";
const RUN_VALUE_OPTIONS = new Set(["--gateway", "--profile", "--token", "--session", "-C", "--cwd"]);

async function clientFromArgs(args: Record<string, unknown>) {
  const profile = await resolveCliProfile(args);
  const token = await requireCliAuthToken(profile);
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
    mouse?: boolean;
    attachOptions?: ShellAttachOptions;
  },
): Promise<{ detached: boolean }> {
  try {
    const agent = inferRunAgent(input.command);
    await client.createSession({
      name: input.name,
      cwd: input.cwd,
      cmd: input.command.map(quoteCommandArg).join(" "),
      ...(agent ? { agent } : {}),
    });
  } catch (err) {
    if (!input.sessionProvided || !isSessionExistsError(err)) {
      throw err;
    }
  }
  const attachOptions: ShellAttachOptions = { ...input.attachOptions };
  if (input.mouse !== undefined) {
    attachOptions.mouse = input.mouse;
  }
  return await client.attachSession(input.name, attachOptions);
}

export function inferRunAgent(command: string[]): "claude" | "codex" | "opencode" | "pi" | undefined {
  const executable = command[0]?.split("/").pop();
  return executable === "claude" || executable === "codex" || executable === "opencode" || executable === "pi"
    ? executable
    : undefined;
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
  const canShowErrorMessage =
    code === "not_authenticated" ||
    (code === "auth_expired" && err instanceof Error && err.message !== "Request failed") ||
    code === "invalid_request" ||
    code === "not_implemented";
  const safeMessage =
    canShowErrorMessage
      ? err instanceof Error ? err.message : undefined
      : undefined;
  console.error(
    json
      ? formatCliError(code, safeMessage)
      : code === "auth_expired"
        ? formatCliErrorMessage(code, safeMessage)
        : safeMessage ?? `Error: Request failed (${code})`,
  );
}

export function exitCodeFromRunResult(result: { exitCode: number | null; timedOut: boolean }): number {
  if (result.timedOut) {
    return 124;
  }
  if (result.exitCode !== null && Number.isInteger(result.exitCode)) {
    return Math.min(Math.max(result.exitCode, 0), 255);
  }
  return 1;
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
    noMouse: {
      type: "boolean",
      required: false,
      default: false,
      description: "Drop local terminal mouse escape sequences before forwarding input",
    },
    noRichPaste: {
      type: "boolean",
      required: false,
      default: false,
      description: "Forward pasted image paths as text instead of uploading them into the shell session",
    },
    json: { type: "boolean", required: false, default: false },
  },
  run: async ({ args, rawArgs }) => {
    const json = args.json === true;
    try {
      const command = parseRunCommand(rawArgs);
      if (command.length === 0) {
        throw Object.assign(new Error(RUN_USAGE), { code: "invalid_request" });
      }
      const sessionProvided = typeof args.session === "string";
      const name = sessionProvided ? args.session as string : createEphemeralSessionName();
      const client = await clientFromArgs(args);

      if (!isInteractive(args, rawArgs)) {
        if (sessionProvided) {
          throw Object.assign(new Error("--session is only supported with -it"), { code: "invalid_request" });
        }
        const result = await client.runCommand({
          command,
          cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        });
        if (json) {
          console.log(formatCliSuccess({ ...result }));
        } else {
          process.stdout.write(result.stdout);
          process.stderr.write(result.stderr);
          if (result.truncated) {
            process.stderr.write("matrix: output truncated (limit reached)\n");
          }
        }
        process.exitCode = exitCodeFromRunResult(result);
        return;
      }

      const result = await createOrAttachRunSession(client, {
        name,
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        command,
        sessionProvided,
        mouse: args.noMouse === true ? false : undefined,
        attachOptions: {
          ...(json ? { output: process.stderr } : {}),
          ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
          ...(args.noRichPaste === true ? { noRichPaste: true } : {}),
        },
      });
      console.log(
        json
          ? formatCliSuccess({ detached: result.detached, session: name })
          : `Detached. Reattach: mos shell attach ${name}`,
      );
    } catch (err) {
      writeError(err, json);
      process.exitCode = 1;
    }
  },
});
