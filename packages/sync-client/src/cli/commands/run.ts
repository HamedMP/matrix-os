import { basename } from "node:path";
import { defineCommand } from "citty";
import { resolveCliProfile } from "../profiles.js";
import { formatCliError, formatCliErrorMessage, formatCliSuccess } from "../output.js";
import { createShellClient, type ShellAttachOptions, type ShellClient, type TerminalRef } from "../shell-client.js";
import { requireCliAuthToken } from "../auth-state.js";

const RUN_USAGE = "Usage: matrix run [-it] [--project <project>] [-C <dir>] -- <command>";
const RUN_VALUE_OPTIONS = new Set(["--gateway", "--profile", "--token", "--project", "-C", "--cwd"]);

async function clientFromArgs(args: Record<string, unknown>) {
  const profile = await resolveCliProfile(args);
  const token = await requireCliAuthToken(profile);
  return createShellClient({ gatewayUrl: profile.gatewayUrl, token });
}

export function hasUnsupportedLongTtySpelling(rawArgs: string[] | undefined): boolean {
  if (!Array.isArray(rawArgs)) return false;
  const separator = rawArgs.indexOf("--");
  return (separator >= 0 ? rawArgs.slice(0, separator) : rawArgs).some((arg) => arg === "--t" || arg.startsWith("--t="));
}

function hasRemovedSessionOption(rawArgs: string[] | undefined): boolean {
  if (!Array.isArray(rawArgs)) return false;
  const separator = rawArgs.indexOf("--");
  return (separator >= 0 ? rawArgs.slice(0, separator) : rawArgs)
    .some((arg) => arg === "--session" || arg.startsWith("--session="));
}

export function parseRunCommand(rawArgs: string[] | undefined): string[] {
  if (!Array.isArray(rawArgs)) return [];
  const separator = rawArgs.indexOf("--");
  if (separator >= 0) return rawArgs.slice(separator + 1);
  const command: string[] = [];
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]!;
    if (["-i", "-t", "-it", "-ti", "--interactive", "--tty"].includes(arg)) continue;
    const [option] = arg.split("=", 1);
    if (RUN_VALUE_OPTIONS.has(option!)) {
      if (!arg.includes("=")) index += 1;
      continue;
    }
    if (!arg.startsWith("--")) command.push(arg);
  }
  return command;
}

export function quoteCommandArg(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

export function inferRunAgent(command: string[]): "claude" | "codex" | "opencode" | "pi" | undefined {
  let index = command[0]?.split("/").pop() === "env" ? 1 : 0;
  while (index < command.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command[index]!) || command[index]!.startsWith("-"))) index += 1;
  const executable = command[index]?.split("/").pop();
  return executable === "claude" || executable === "codex" || executable === "opencode" || executable === "pi" ? executable : undefined;
}

export function exitCodeFromRunResult(result: { exitCode: number | null; timedOut?: boolean }): number {
  if (result.timedOut) return 124;
  return result.exitCode !== null && Number.isInteger(result.exitCode) ? Math.min(Math.max(result.exitCode, 0), 255) : 1;
}

async function resolveWorkspaceId(client: ShellClient, requested: unknown): Promise<{ workspaceId: string; cwd: string }> {
  const [projectsRaw, workspacesRaw] = await Promise.all([client.listProjects(), client.listWorkspaces()]);
  const projects = projectsRaw.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    return typeof record.id === "string" && typeof record.label === "string" ? [{ id: record.id, label: record.label }] : [];
  });
  const requestedName = typeof requested === "string" ? requested : basename(process.cwd());
  const project = requestedName === "main" ? null : projects.find((item) => item.id === requestedName || item.label === requestedName);
  if (typeof requested === "string" && requested !== "main" && !project) throw Object.assign(new Error("Project not found"), { code: "invalid_request" });
  for (const value of workspacesRaw) {
    if (!value || typeof value !== "object") continue;
    const workspace = value as Record<string, unknown>;
    const matches = project ? workspace.projectId === project.id : workspace.scope === "main";
    if (matches && typeof workspace.id === "string") return { workspaceId: workspace.id, cwd: project ? `projects/${project.label}` : "" };
  }
  const ensured = await client.ensureWorkspace(project ? { projectId: project.id } : {});
  const workspace = (ensured.workspace ?? ensured) as Record<string, unknown>;
  if (typeof workspace.id !== "string") throw Object.assign(new Error("Terminal workspace unavailable"), { code: "request_failed" });
  return { workspaceId: workspace.id, cwd: project ? `projects/${project.label}` : "" };
}

export async function createOrAttachRunSession(
  client: Pick<ShellClient, "createTab" | "attachTab">,
  input: { workspaceId: string; name: string; command: string[]; cwd?: string; mouse?: boolean; attachOptions?: ShellAttachOptions },
): Promise<{ detached: boolean; exitCode: number | null; terminalRef: TerminalRef }> {
  const response = await client.createTab(input.workspaceId, { name: input.name, cwd: input.cwd ?? "", command: input.command });
  const tab = response.tab as { id?: unknown } | undefined;
  if (typeof tab?.id !== "string" || !/^tt_[0-9a-f]{32}$/.test(tab.id)) throw Object.assign(new Error("Invalid terminal tab response"), { code: "invalid_response" });
  const terminalRef = { workspaceId: input.workspaceId, tabId: tab.id };
  const result = await client.attachTab(terminalRef, {
    ...input.attachOptions,
    ...(input.mouse !== undefined ? { mouse: input.mouse } : {}),
  });
  return { ...result, terminalRef };
}

function isInteractive(args: Record<string, unknown>, rawArgs: string[] | undefined): boolean {
  return args.interactive === true || args.i === true || args.tty === true || args.t === true
    || Boolean(rawArgs?.some((arg) => arg === "-it" || arg === "-ti"));
}

function writeError(err: unknown, json: boolean): void {
  const code = err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "request_failed";
  const safe = code === "invalid_request" || code === "not_authenticated" ? (err instanceof Error ? err.message : undefined) : undefined;
  console.error(json ? formatCliError(code, safe) : safe ?? formatCliErrorMessage(code));
}

export const runCommand = defineCommand({
  meta: { name: "run", description: "Run a command in a project-scoped terminal tab" },
  args: {
    interactive: { type: "boolean", alias: "i", required: false, default: false },
    tty: { type: "boolean", alias: "t", required: false, default: false, description: "Request a TTY; combine with -i as -it" },
    project: { type: "string", required: false },
    cwd: { type: "string", alias: "C", required: false },
    profile: { type: "string", required: false },
    dev: { type: "boolean", required: false, default: false },
    gateway: { type: "string", required: false },
    token: { type: "string", required: false },
    noMouse: { type: "boolean", required: false, default: false },
    noRichPaste: { type: "boolean", required: false, default: false },
    json: { type: "boolean", required: false, default: false },
  },
  run: async ({ args, rawArgs }) => {
    const json = args.json === true;
    try {
      if (hasUnsupportedLongTtySpelling(rawArgs)) throw Object.assign(new Error("`--t` is not supported; use `-t` or `--tty`"), { code: "invalid_request" });
      if (hasRemovedSessionOption(rawArgs)) throw Object.assign(new Error("`--session` was removed; use `--project` and connect with `--tab`"), { code: "invalid_request" });
      const command = parseRunCommand(rawArgs);
      if (command.length === 0) throw Object.assign(new Error(RUN_USAGE), { code: "invalid_request" });
      const client = await clientFromArgs(args);
      const resolved = await resolveWorkspaceId(client, args.project);
      const cwd = typeof args.cwd === "string" ? args.cwd : resolved.cwd;
      if (!isInteractive(args, rawArgs)) {
        const result = await client.runCommand({ command, cwd });
        if (json) {
          console.log(formatCliSuccess({ ...result }));
        } else {
          if (result.stdout) process.stdout.write(result.stdout);
          if (result.stderr) process.stderr.write(result.stderr);
          if (result.truncated) process.stderr.write("matrix: output truncated (limit reached)\n");
        }
        process.exitCode = exitCodeFromRunResult(result);
        return;
      }
      const result = await createOrAttachRunSession(client, {
        workspaceId: resolved.workspaceId,
        name: `Run ${command[0]!.split("/").pop()}`,
        command,
        cwd,
        mouse: args.noMouse === true ? false : undefined,
        attachOptions: {
          ...(json ? { output: process.stderr, errorOutput: process.stderr } : {}),
          ...(args.noRichPaste === true ? { noRichPaste: true } : {}),
          cwd,
        },
      });
      if (json) console.log(formatCliSuccess(result));
      else if (result.detached) console.log(`Detached. Reconnect: matrix shell connect --tab ${result.terminalRef.tabId}`);
      if (!result.detached) process.exitCode = result.exitCode ?? 0;
    } catch (err) {
      writeError(err, json);
      process.exitCode = 1;
    }
  },
});
