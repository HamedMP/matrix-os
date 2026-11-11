import { defineCommand } from "citty";
import { requireCliAuthToken } from "../auth-state.js";
import { formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";
import { createShellClient } from "../shell-client.js";
import { createTerminalAgentClient, type TerminalAgentClient } from "../terminal-agent-client.js";
import { codedError, commonArgs, refFor, resolveTab, resolveWorkspace, writeError } from "./shell.js";

const tabArgs = {
  project: { type: "string", required: false },
  tab: { type: "string", required: true },
  ...commonArgs,
} as const;

async function target(args: Record<string, unknown>) {
  const profile = await resolveCliProfile(args);
  const token = await requireCliAuthToken(profile);
  const shell = createShellClient({ gatewayUrl: profile.gatewayUrl, token });
  const { workspace } = await resolveWorkspace(shell, args.project);
  const tab = resolveTab(workspace, args.tab);
  return { ref: refFor(workspace, tab), tab, client: createTerminalAgentClient({ gatewayUrl: profile.gatewayUrl, token }) };
}

function positionals(args: Record<string, unknown>): string[] {
  return Array.isArray(args._) ? args._.filter((value): value is string => typeof value === "string") : [];
}

function verb<T extends Record<string, unknown>>(
  meta: { name: string; description: string },
  extraArgs: Record<string, { type: "string" | "boolean"; required: false; default?: unknown }>,
  run: (input: {
    args: Record<string, unknown>;
    client: TerminalAgentClient;
    ref: { workspaceId: string; tabId: string };
  }) => Promise<{ data: T; text: string }>,
) {
  return defineCommand({
    meta,
    args: { ...tabArgs, ...extraArgs } as typeof tabArgs,
    run: async ({ args }) => {
      const json = args.json === true;
      try {
        const { client, ref } = await target(args);
        const result = await run({ args, client, ref });
        console.log(json ? formatCliSuccess({ terminalRef: ref, ...result.data }) : result.text);
      } catch (err) {
        writeError(err, json);
        process.exitCode = 1;
      }
    },
  });
}

export const shellGetCommand = verb(
  { name: "get", description: "Show one terminal's state, agent status and exit code" },
  {},
  async ({ client, ref }) => {
    const facts = await client.get(ref);
    const tab = (facts.tab ?? {}) as Record<string, unknown>;
    const status = typeof facts.agentStatus === "string" ? ` ${facts.agentStatus}` : "";
    const exit = typeof tab.exitCode === "number" ? ` exit ${tab.exitCode}` : "";
    return { data: facts, text: `${String(tab.name ?? ref.tabId)} ${String(facts.state ?? "")}${status}${exit}`.trim() };
  },
);

export const shellReadCommand = verb(
  { name: "read", description: "Print a terminal's screen and history without attaching" },
  { lines: { type: "string", required: false, default: "0" } },
  async ({ args, client, ref }) => {
    const raw = String(args.lines ?? "0");
    if (!/^\d{1,5}$/.test(raw) || Number(raw) > 10_000) throw codedError("--lines must be 0 to 10000");
    const result = await client.read(ref, Number(raw));
    if (result.incomplete) throw codedError("Terminal screen is not available yet", "request_failed");
    return { data: { ...result }, text: [result.history, result.screen].filter(Boolean).join("\n") };
  },
);

export const shellSendCommand = verb(
  { name: "send", description: "Paste text into a terminal and press Enter" },
  { force: { type: "boolean", required: false, default: false } },
  async ({ args, client, ref }) => {
    const text = positionals(args).join(" ");
    if (!text.trim()) throw codedError("Text to send is required");
    const result = await client.send(ref, { text, ...(args.force === true ? { force: true } : {}) });
    return { data: result, text: result.heldMs > 0 ? `Sent after waiting ${Math.round(result.heldMs / 1000)}s for a draft.` : "Sent." };
  },
);

export const shellKeysCommand = verb(
  { name: "keys", description: "Press named keys in a terminal (enter, esc, up, ctrl+c, ...)" },
  {},
  async ({ args, client, ref }) => {
    const keys = positionals(args);
    if (keys.length === 0) throw codedError("At least one key is required");
    const result = await client.keys(ref, keys);
    return { data: result, text: `Pressed ${result.pressed} key${result.pressed === 1 ? "" : "s"}.` };
  },
);

export const shellInterruptCommand = verb(
  { name: "interrupt", description: "Press the stop key: Esc for an agent, Ctrl+C for a program" },
  {},
  async ({ client, ref }) => {
    const result = await client.interrupt(ref);
    return { data: result, text: `Pressed ${result.pressed}.` };
  },
);
