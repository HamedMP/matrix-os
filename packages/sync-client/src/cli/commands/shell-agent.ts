import { defineCommand } from "citty";
import { requireCliAuthToken } from "../auth-state.js";
import { formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";
import { createShellClient } from "../shell-client.js";
import {
  createTerminalAgentClient,
  TERMINAL_WAIT_REQUEST_MAX_MS,
  type TerminalAgentClient,
  type TerminalWaitOutput,
} from "../terminal-agent-client.js";
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
    const observed = result.observed;
    const seen = observed === null ? "nothing changed within 5 s"
      : "exited" in observed ? `the program exited${observed.exitCode === undefined ? "" : ` (code ${observed.exitCode})`}`
      : `status is now ${observed.status}`;
    return { data: result, text: `Pressed ${result.pressed}; ${seen}.` };
  },
);

/** Total wait limit for one `matrix shell wait`, like `hc wait`'s default. */
const DEFAULT_WAIT_SECONDS = 180;
const MAX_WAIT_SECONDS = 24 * 60 * 60;

export async function waitUntil(
  client: TerminalAgentClient,
  ref: { workspaceId: string; tabId: string },
  input: { output?: string; totalMs: number; now?: () => number },
): Promise<TerminalWaitOutput> {
  const now = input.now ?? Date.now;
  const deadline = now() + input.totalMs;
  for (;;) {
    const remaining = deadline - now();
    const result = await client.wait(ref, {
      timeoutMs: Math.max(0, Math.min(remaining, TERMINAL_WAIT_REQUEST_MAX_MS)),
      ...(input.output ? { output: input.output } : {}),
    });
    // A server check-in is not the caller's timeout: keep waiting until ours runs out.
    if (result.reason !== "timeout" || deadline - now() <= 0) return result;
  }
}

export const shellWaitCommand = verb(
  { name: "wait", description: "Wait until a terminal stops working, exits, or prints --output text" },
  {
    output: { type: "string", required: false },
    timeout: { type: "string", required: false, default: String(DEFAULT_WAIT_SECONDS) },
  },
  async ({ args, client, ref }) => {
    const rawTimeout = String(args.timeout ?? DEFAULT_WAIT_SECONDS);
    if (!/^\d{1,6}$/.test(rawTimeout) || Number(rawTimeout) > MAX_WAIT_SECONDS) {
      throw codedError(`--timeout must be 0 to ${MAX_WAIT_SECONDS} seconds`);
    }
    const output = typeof args.output === "string" && args.output ? args.output : undefined;
    if (output && output.length > 256) throw codedError("--output must be at most 256 characters");
    const result = await waitUntil(client, ref, { totalMs: Number(rawTimeout) * 1000, ...(output ? { output } : {}) });
    // Like `hc wait`: a timeout exits 124 so scripts can tell it from "stopped".
    if (result.reason === "timeout") process.exitCode = 124;
    const detail = result.reason === "exited" ? ` (exit ${result.exitCode ?? "unknown"})`
      : result.status ? ` (${result.status})` : "";
    return { data: { ...result }, text: `${result.reason}${detail}` };
  },
);
