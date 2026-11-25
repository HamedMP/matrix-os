// `matrix shell machine …`: terminals on the owner's linked desktops (spec 2716).
// From inside one of the computer's own terminals it uses the local terminal
// token, so an agent there can start, read and type into a terminal on the
// desktop; elsewhere it uses the signed-in profile.
import { defineCommand } from "citty";
import { DESKTOP_LINK_CLIENT_TIMEOUT_MS } from "@matrix-os/contracts/desktop-link";
import { formatCliSuccess } from "../output.js";
import { resolveTerminalAgentCliConnection } from "../local-terminal-connection.js";
import { codedError, commonArgs, writeError } from "./shell.js";

// Starting, reading or typing into a desktop terminal may wait for the owner's approval there (spec 2716, D2).
const TIMEOUT_MS = DESKTOP_LINK_CLIENT_TIMEOUT_MS;
// A wait returns within 90 s (a check-in); the request allows for that and the round trip.
const WAIT_TIMEOUT_MS = 100_000;
const WAIT_MAX_MS = 90_000;
const SAFE_CODES = new Set(["desktop_offline", "busy", "denied", "not_found", "invalid_request", "forbidden", "blocked", "finished"]);
const AGENTS = new Set(["claude", "codex", "opencode", "pi"]);
const TERMINAL_ID = /^t[0-9]{1,6}[a-z]{0,2}$/;

interface Machine { deviceId: string; name: string; state: string }

export function createMachineClient(options: { gatewayUrl: string; token: string; fetch?: typeof fetch }) {
  const fetchImpl = options.fetch ?? fetch;
  const base = options.gatewayUrl.replace(/\/+$/, "");
  async function request(path: string, init: { method?: string; body?: unknown } = {}, timeoutMs = TIMEOUT_MS): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}/api/desktop-link${path}`, {
        method: init.method ?? "GET",
        headers: { Authorization: `Bearer ${options.token}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error: unknown) {
      const timedOut = error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
      throw Object.assign(new Error("Request failed"), { code: timedOut ? "request_timeout" : "gateway_unreachable" });
    }
    let payload: unknown = {};
    try { payload = await response.json(); } catch (error: unknown) { if (!(error instanceof SyntaxError)) throw error; }
    if (!response.ok) {
      const server = (payload as { error?: unknown } | null)?.error;
      const code = typeof server === "string" && SAFE_CODES.has(server) ? server
        : response.status === 401 ? "auth_expired" : response.status === 404 ? "not_found" : "request_failed";
      throw Object.assign(new Error("Request failed"), { code });
    }
    if (typeof payload !== "object" || payload === null) throw Object.assign(new Error("Request failed"), { code: "invalid_response" });
    return payload as Record<string, unknown>;
  }

  async function machines(): Promise<Machine[]> {
    const payload = await request("/machines");
    return Array.isArray(payload.machines) ? payload.machines as Machine[] : [];
  }

  /** A desktop by its name (case-insensitive) or the start of its device id (at least 8 characters). */
  async function resolve(name: string): Promise<Machine> {
    const all = await machines();
    const wanted = name.trim().toLowerCase();
    const matches = all.filter((machine) => machine.name.toLowerCase() === wanted
      || (wanted.length >= 8 && machine.deviceId.startsWith(wanted)));
    if (matches.length !== 1) throw codedError(matches.length === 0 ? `No linked desktop named ${name}` : `More than one desktop matches ${name}`);
    return matches[0]!;
  }

  const terminals = (deviceId: string) => `/machines/${deviceId}/terminals`;
  return {
    machines,
    resolve,
    list: (deviceId: string) => request(terminals(deviceId)),
    run: (deviceId: string, body: Record<string, unknown>) => request(terminals(deviceId), { method: "POST", body }),
    read: (deviceId: string, id: string, lines: number) => request(`${terminals(deviceId)}/${id}/screen?lines=${lines}`),
    input: (deviceId: string, id: string, data: string) => request(`${terminals(deviceId)}/${id}/input`, { method: "POST", body: { data } }),
    kill: (deviceId: string, id: string) => request(`${terminals(deviceId)}/${id}`, { method: "DELETE" }),
    keys: (deviceId: string, id: string, keys: string[]) => request(`${terminals(deviceId)}/${id}/keys`, { method: "POST", body: { keys } }),
    interrupt: (deviceId: string, id: string) => request(`${terminals(deviceId)}/${id}/interrupt`, { method: "POST", body: {} }),
    wait: (deviceId: string, id: string, body: { output?: string; timeoutMs?: number }) =>
      request(`${terminals(deviceId)}/${id}/wait`, { method: "POST", body }, WAIT_TIMEOUT_MS),
  };
}

function positionals(args: Record<string, unknown>): string[] {
  return Array.isArray(args._) ? args._.filter((value): value is string => typeof value === "string") : [];
}

function terminalArg(value: unknown): string {
  if (typeof value !== "string" || !TERMINAL_ID.test(value)) throw codedError("Give a terminal id like t3");
  return value;
}

function command(
  meta: { name: string; description: string },
  extraArgs: Record<string, { type: "string" | "boolean" | "positional"; required: boolean; default?: unknown; description?: string }>,
  run: (input: { args: Record<string, unknown>; client: ReturnType<typeof createMachineClient> }) => Promise<{ data: Record<string, unknown>; text: string }>,
) {
  return defineCommand({
    meta,
    args: { ...commonArgs, ...extraArgs } as typeof commonArgs,
    run: async ({ args }) => {
      const json = args.json === true;
      try {
        const client = createMachineClient(await resolveTerminalAgentCliConnection(args));
        const result = await run({ args, client });
        console.log(json ? formatCliSuccess(result.data) : result.text);
      } catch (error: unknown) {
        writeError(error, json);
        process.exitCode = 1;
      }
    },
  });
}

const machineArg = { machine: { type: "positional" as const, required: true, description: "The desktop's name" } };
const terminalArgs = { ...machineArg, terminal: { type: "positional" as const, required: true, description: "Terminal id, like t3" } };

const machineList = command({ name: "ls", description: "List the desktops linked to this computer" }, {}, async ({ client }) => {
  const machines = await client.machines();
  return {
    data: { machines },
    text: machines.length === 0 ? "No desktops are linked to this computer."
      : machines.map((machine) => `${machine.name}  ${machine.state}  ${machine.deviceId.slice(0, 12)}`).join("\n"),
  };
});

const machineTerminals = command({ name: "terminals", description: "List the terminals on a linked desktop" }, machineArg, async ({ args, client }) => {
  const machine = await client.resolve(String(args.machine));
  const payload = await client.list(machine.deviceId);
  const sessions = Array.isArray(payload.sessions) ? payload.sessions as Array<{ id: string; title: string; status?: string | null }> : [];
  return {
    data: { machine: machine.name, sessions },
    text: sessions.map((session) => `${session.id}  ${session.title}${session.status ? `  ${session.status}` : ""}`).join("\n") || "No terminals.",
  };
});

const machineRun = command({ name: "run", description: "Start a terminal on a linked desktop: its shell, an agent, or a program after --" }, {
  ...machineArg,
  agent: { type: "string", required: false, description: "claude, codex, opencode or pi" },
  cwd: { type: "string", required: false, description: "A folder in the desktop user's home" },
  name: { type: "string", required: false },
}, async ({ args, client }) => {
  const argv = positionals(args).slice(1);
  if (typeof args.agent === "string" && !AGENTS.has(args.agent)) throw codedError("Agent must be claude, codex, opencode or pi");
  if (typeof args.agent === "string" && argv.length > 0) throw codedError("Give an agent or a program, not both");
  const machine = await client.resolve(String(args.machine));
  const payload = await client.run(machine.deviceId, {
    ...(typeof args.agent === "string" ? { agent: args.agent } : {}),
    ...(argv.length > 0 ? { argv } : {}),
    ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
    ...(typeof args.name === "string" ? { name: args.name } : {}),
  });
  return { data: { machine: machine.name, id: payload.id }, text: `Started ${String(payload.id)} on ${machine.name}.` };
});

const machineRead = command({ name: "read", description: "Print a terminal's screen and recent history" }, {
  ...terminalArgs,
  lines: { type: "string", required: false, default: "200" },
}, async ({ args, client }) => {
  const machine = await client.resolve(String(args.machine));
  const lines = Number(args.lines);
  if (!Number.isInteger(lines) || lines < 0 || lines > 2_000) throw codedError("--lines must be 0 to 2000");
  const screen = await client.read(machine.deviceId, terminalArg(args.terminal), lines);
  const text = [...(Array.isArray(screen.scrollback) ? screen.scrollback : []), ...(Array.isArray(screen.viewport) ? screen.viewport : [])].join("\n");
  return { data: { machine: machine.name, ...screen }, text };
});

const machineSend = command({ name: "send", description: "Type text into a terminal, then Enter" }, {
  ...terminalArgs,
  text: { type: "positional", required: true },
  "no-enter": { type: "boolean", required: false, default: false },
}, async ({ args, client }) => {
  const machine = await client.resolve(String(args.machine));
  const id = terminalArg(args.terminal);
  await client.input(machine.deviceId, id, `${String(args.text)}${args["no-enter"] === true ? "" : "\r"}`);
  return { data: { machine: machine.name, id, sent: true }, text: `Sent to ${id} on ${machine.name}.` };
});

const machineKill = command({ name: "kill", description: "End a terminal on a linked desktop" }, terminalArgs, async ({ args, client }) => {
  const machine = await client.resolve(String(args.machine));
  const id = terminalArg(args.terminal);
  await client.kill(machine.deviceId, id);
  return { data: { machine: machine.name, id, ended: true }, text: `Ended ${id} on ${machine.name}.` };
});

const machineKeys = command({ name: "keys", description: "Press named keys in a terminal: enter, esc, tab, up, ctrl+c, …" }, {
  ...terminalArgs,
}, async ({ args, client }) => {
  const keys = positionals(args).slice(2);
  if (keys.length === 0 || keys.length > 64 || keys.some((key) => key.length > 16)) throw codedError("Name 1 to 64 keys, like: enter ctrl+c");
  const machine = await client.resolve(String(args.machine));
  const id = terminalArg(args.terminal);
  const result = await client.keys(machine.deviceId, id, keys);
  return { data: { machine: machine.name, id, ...result }, text: `Pressed ${keys.join(" ")} in ${id} on ${machine.name}.` };
});

const machineInterrupt = command({ name: "interrupt", description: "Stop a terminal's current turn: Esc for an agent, otherwise Ctrl+C" }, terminalArgs, async ({ args, client }) => {
  const machine = await client.resolve(String(args.machine));
  const id = terminalArg(args.terminal);
  const result = await client.interrupt(machine.deviceId, id);
  return { data: { machine: machine.name, id, ...result }, text: `Interrupted ${id} on ${machine.name}.` };
});

const machineWait = command({ name: "wait", description: "Wait until a terminal stops working, exits or prints --output (a check-in after at most 90 s)" }, {
  ...terminalArgs,
  output: { type: "string", required: false },
  timeout: { type: "string", required: false, description: "Seconds, at most 90" },
}, async ({ args, client }) => {
  const seconds = args.timeout === undefined ? undefined : Number(args.timeout);
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0 || seconds * 1000 > WAIT_MAX_MS)) throw codedError("--timeout must be 0 to 90 seconds");
  const machine = await client.resolve(String(args.machine));
  const id = terminalArg(args.terminal);
  const result = await client.wait(machine.deviceId, id, {
    ...(typeof args.output === "string" ? { output: args.output } : {}),
    ...(seconds !== undefined ? { timeoutMs: Math.round(seconds * 1000) } : {}),
  });
  return { data: { machine: machine.name, id, ...result }, text: `${id} on ${machine.name}: ${String(result.reason ?? "done")}` };
});

const machineOpen = command({ name: "open", description: "Open a web page in the desktop's default browser" }, {
  ...machineArg,
  url: { type: "positional", required: true },
}, async ({ args, client }) => {
  let url: URL;
  try { url = new URL(String(args.url)); } catch (error: unknown) {
    if (error instanceof TypeError) throw codedError("Give a full http or https address");
    throw error;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw codedError("Give a full http or https address");
  const machine = await client.resolve(String(args.machine));
  const payload = await client.run(machine.deviceId, { argv: ["/usr/bin/open", url.toString()], name: "open" });
  return { data: { machine: machine.name, id: payload.id, url: url.toString() }, text: `Opened ${url.toString()} on ${machine.name}.` };
});

export const shellMachineCommand = defineCommand({
  meta: { name: "machine", description: "Terminals on the desktops linked to this computer" },
  args: commonArgs,
  subCommands: {
    ls: machineList, list: machineList, terminals: machineTerminals, run: machineRun, read: machineRead, send: machineSend,
    keys: machineKeys, interrupt: machineInterrupt, wait: machineWait, open: machineOpen, kill: machineKill,
  },
  run: ({ rawArgs }) => {
    if (!rawArgs?.length) console.log("Usage: matrix shell machine ls|terminals|run|read|send|keys|interrupt|wait|open|kill <desktop> [terminal]");
  },
});
