import { defineCommand } from "citty";
import { requireCliAuthToken } from "../auth-state.js";
import { formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";
import { createShellClient } from "../shell-client.js";
import {
  createTerminalAgentClient,
  terminalCallerFromEnv,
  TERMINAL_WAIT_REQUEST_MAX_MS,
  type TerminalAgentClient,
} from "../terminal-agent-client.js";
import { codedError, commonArgs, refFor, resolveTab, resolveWorkspace, writeError } from "./shell.js";

const LABEL = /^([a-z][a-z0-9_.-]{0,62})=(.{0,256})$/s;

async function clients(args: Record<string, unknown>) {
  const profile = await resolveCliProfile(args);
  const token = await requireCliAuthToken(profile);
  return {
    shell: createShellClient({ gatewayUrl: profile.gatewayUrl, token }),
    agents: createTerminalAgentClient({ gatewayUrl: profile.gatewayUrl, token }),
  };
}

function positionals(args: Record<string, unknown>): string[] {
  return Array.isArray(args._) ? args._.filter((value): value is string => typeof value === "string") : [];
}

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return typeof value === "string" ? [value] : [];
}

function parseLabels(values: string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const value of values) {
    const match = LABEL.exec(value);
    if (!match) throw codedError(`Invalid label ${JSON.stringify(value.slice(0, 40))}; use key=value`);
    labels[match[1]!] = match[2]!;
  }
  return labels;
}

function requireCaller() {
  const caller = terminalCallerFromEnv();
  if (!caller) throw codedError("Run this inside a Matrix terminal");
  return caller;
}

function command(
  meta: { name: string; description: string },
  args: Record<string, unknown>,
  run: (input: { args: Record<string, unknown>; json: boolean; rawArgs: string[] }) => Promise<string>,
) {
  return defineCommand({
    meta,
    args: { ...commonArgs, ...args } as typeof commonArgs,
    run: async ({ args: parsed, rawArgs }) => {
      const json = parsed.json === true;
      try {
        const text = await run({ args: parsed, json, rawArgs: Array.isArray(rawArgs) ? rawArgs : [] });
        if (text) console.log(text);
      } catch (err) {
        writeError(err, json);
        process.exitCode = 1;
      }
    },
  });
}

export const shellTemplatesCommand = command(
  { name: "templates", description: "List agent templates (roles you can run with a task)" },
  {},
  async ({ args, json }) => {
    const templates = await (await clients(args)).agents.templates();
    if (json) return formatCliSuccess({ templates });
    return templates.length === 0
      ? "No templates. Add Markdown files to ~/agents/templates/."
      : templates.map((template) => `${template.name}\t${template.description}`).join("\n");
  },
);

/**
 * `matrix shell run [--name n] [--cwd dir] <template> [task...]` or `-- <command...>`.
 * Started from inside a Matrix terminal, the new terminal records it as parent.
 */
export const shellRunCommand = command(
  { name: "run", description: "Run a program or agent template in a new terminal tab" },
  {
    project: { type: "string", required: false },
    name: { type: "string", required: false },
    cwd: { type: "string", required: false },
    label: { type: "string", required: false },
    "outlive-parent": { type: "boolean", required: false, default: false },
    "no-parent": { type: "boolean", required: false, default: false },
  },
  async ({ args, json, rawArgs }) => {
    const words = positionals(args);
    if (words.length === 0) throw codedError("A template or command is required");
    // `-- <command...>` is always a command, even if a template shares its first word.
    const explicitCommand = rawArgs.includes("--");
    const { shell, agents } = await clients(args);
    const { project } = await resolveWorkspace(shell, args.project);
    const template = explicitCommand ? undefined : (await agents.templates()).find((candidate) => candidate.name === words[0]);
    const caller = args["no-parent"] === true ? undefined : terminalCallerFromEnv();
    const task = template ? words.slice(1).join(" ") : undefined;
    const result = await agents.run({
      ...(project ? { projectId: project.id } : {}),
      name: typeof args.name === "string" && args.name ? args.name : template?.name ?? words[0]!.slice(0, 64),
      // As `matrix shell new`: a project's terminals start in its folder unless --cwd says otherwise.
      cwd: typeof args.cwd === "string" ? args.cwd : project ? `projects/${project.label}` : "",
      ...(template ? { template: template.name } : { argv: words }),
      ...(task ? { task } : {}),
      ...(caller ? { caller } : {}),
      ...(args["no-parent"] === true ? { noParent: true } : {}),
      ...(args["outlive-parent"] === true ? { outliveParent: true } : {}),
      ...(listOf(args.label).length ? { labels: parseLabels(listOf(args.label)) } : {}),
    });
    if (json) return formatCliSuccess(result);
    const tab = (result.tab ?? {}) as Record<string, unknown>;
    const firstMessage = result.firstMessage as { sent?: boolean; reason?: string } | undefined;
    const delivery = firstMessage && !firstMessage.sent
      ? ` Task NOT sent (${firstMessage.reason ?? "unknown"}): read it with matrix shell read --tab ${String(tab.id)} before sending.`
      : "";
    return `Started ${String(tab.name ?? "")} (${String(tab.id ?? "")}).${delivery}`;
  },
);

export const shellLabelCommand = command(
  { name: "label", description: "Set labels on a terminal: key=value, or -k key to remove" },
  { project: { type: "string", required: false }, tab: { type: "string", required: true }, k: { type: "string", required: false } },
  async ({ args, json }) => {
    const { shell, agents } = await clients(args);
    const { workspace } = await resolveWorkspace(shell, args.project);
    const ref = refFor(workspace, resolveTab(workspace, args.tab));
    const set = parseLabels(positionals(args));
    const remove = listOf(args.k);
    if (Object.keys(set).length === 0 && remove.length === 0) throw codedError("Give key=value labels or -k key");
    const result = await agents.label(ref, { ...(Object.keys(set).length ? { set } : {}), ...(remove.length ? { remove } : {}) });
    return json ? formatCliSuccess({ terminalRef: ref, ...result }) : "Labels updated.";
  },
);

/** A child agent's report to the terminal that started it. */
export const shellReportCommand = command(
  { name: "report", description: "Send a result or blocker to the terminal that started this one" },
  {},
  async ({ args, json }) => {
    const text = positionals(args).join(" ");
    if (!text.trim()) throw codedError("Report text is required");
    const result = await (await clients(args)).agents.report({ caller: requireCaller(), text });
    return json ? formatCliSuccess(result) : "Reported.";
  },
);

export async function waitChildrenUntil(
  agents: TerminalAgentClient,
  input: { caller: { sessionName: string; paneId: string }; mode: "any" | "all"; totalMs: number; now?: () => number },
) {
  const now = input.now ?? Date.now;
  const deadline = now() + input.totalMs;
  for (;;) {
    const remaining = Math.max(0, deadline - now());
    const result = await agents.waitChildren({
      caller: input.caller, mode: input.mode, timeoutMs: Math.min(remaining, TERMINAL_WAIT_REQUEST_MAX_MS),
    });
    if (result.reason !== "timeout" || deadline - now() <= 0) return result;
  }
}

export const shellWaitChildrenCommand = command(
  { name: "wait-children", description: "Wait for this terminal's helpers: any (next news) or all (none working)" },
  { timeout: { type: "string", required: false, default: "180" } },
  async ({ args, json }) => {
    const mode = positionals(args)[0] ?? "all";
    if (mode !== "any" && mode !== "all") throw codedError("Mode must be any or all");
    const rawTimeout = String(args.timeout ?? "180");
    if (!/^\d{1,6}$/.test(rawTimeout)) throw codedError("--timeout must be seconds");
    const result = await waitChildrenUntil((await clients(args)).agents, {
      caller: requireCaller(), mode, totalMs: Number(rawTimeout) * 1000,
    });
    if (result.reason === "timeout") process.exitCode = 124;
    return json ? formatCliSuccess({ ...result }) : `${result.reason}${result.status ? ` (${result.status})` : ""}`;
  },
);
