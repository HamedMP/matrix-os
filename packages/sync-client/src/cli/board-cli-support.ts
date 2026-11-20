import { homedir } from "node:os";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { BoardMessageIdSchema, ChannelPathSchema, ChannelScopeSchema, LabelKeySchema, LabelValueSchema, ProfileNameSchema } from "@matrix-os/contracts/message-board";
import { requireCliAuthToken } from "./auth-state.js";
import { BoardClaimStore } from "./board-claims.js";
import { BoardCliError, createBoardClient, type BoardClient } from "./board-client.js";
import { resolveLocalTerminalConnection } from "./local-terminal-connection.js";
import { CLI_OUTPUT_VERSION, formatCliErrorMessage } from "./output.js";
import { resolveCliProfile } from "./profiles.js";
import { terminalCallerFromEnv } from "./terminal-agent-client.js";

export interface BoardIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

/** The parts of a child process `tasks run` uses. */
export interface BoardChild {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface BoardSignals {
  on(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
  off(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
}

export interface BoardSpawnOptions {
  env: NodeJS.ProcessEnv;
  /** `inherit`, or under --json the child's stdout sent to our stderr. */
  stdio: "inherit" | ["inherit", 2, "inherit"];
  /** Its own process group, so stopping it reaches everything it started. */
  detached: true;
}

export interface BoardConnection { gatewayUrl: string; token: string; local: boolean }

export interface BoardDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  fetch?: typeof fetch;
  io: BoardIo;
  resolveConnection(flags: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<BoardConnection>;
  spawn?: (command: string, args: string[], options: BoardSpawnOptions) => BoardChild;
  /** Signals a process or, with a negative pid, a process group (`process.kill`). */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  signals: BoardSignals;
  now(): number;
}

/** Inside a Matrix pane the machine's own gateway with the loopback token; elsewhere the signed-in profile. */
export async function defaultBoardConnection(flags: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<BoardConnection> {
  const local = await resolveLocalTerminalConnection(flags, env);
  if (local) return { ...local, local: true };
  const profile = await resolveCliProfile(flags);
  return { gatewayUrl: profile.gatewayUrl, token: await requireCliAuthToken(profile), local: false };
}

export function defaultBoardDeps(): BoardDeps {
  return {
    env: process.env,
    home: process.env.HOME || homedir(),
    io: { stdout: (line) => console.log(line), stderr: (line) => console.error(line) },
    resolveConnection: defaultBoardConnection,
    signals: { on: (name, fn) => void process.on(name, fn), off: (name, fn) => void process.off(name, fn) },
    now: Date.now,
  };
}

/* ---------- errors and exit codes ---------- */

export class BoardUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardUsageError";
  }
}

export const usage = (message: string): never => {
  throw new BoardUsageError(message);
};

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_INTERRUPT = 130;

/** Codes thrown by the shared profile/connection helpers that are safe to show. */
const CONNECTION_CODES = new Set([
  "local_gateway_unavailable", "not_authenticated", "auth_expired", "gateway_unreachable", "request_timeout", "platform_unreachable",
]);

function failure(error: unknown): { reason: string; message: string; next?: string; extra?: Record<string, unknown>; exit: number } {
  if (error instanceof BoardUsageError) return { reason: "usage", message: error.message, exit: EXIT_USAGE };
  if (error instanceof BoardCliError) {
    return {
      reason: error.reason, message: error.message, exit: error.reason === "interrupted" ? EXIT_INTERRUPT : EXIT_FAILURE,
      ...(error.next ? { next: error.next } : {}), ...(error.extra ? { extra: error.extra } : {}),
    };
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && CONNECTION_CODES.has(code)) return { reason: code, message: formatCliErrorMessage(code), exit: EXIT_FAILURE };
  console.error("[matrix] board command failed:", error instanceof Error ? error.name : "UnknownError");
  return { reason: "request_failed", message: "The message board request failed.", exit: EXIT_FAILURE };
}

/** Prints a failure (one JSON document with `reason` and `next` under --json) and returns its exit code. */
export function reportFailure(io: BoardIo, json: boolean, error: unknown): number {
  const { exit, extra, ...shown } = failure(error);
  if (json) {
    io.stdout(JSON.stringify({ v: CLI_OUTPUT_VERSION, ok: false, reason: shown.reason, error: shown.message, ...(shown.next ? { next: shown.next } : {}), ...extra }));
  } else {
    io.stderr(`error: ${shown.message} (${shown.reason})`);
    if (shown.next) io.stderr(`next: ${shown.next}`);
    if (extra && typeof extra.cursor === "string") io.stderr(`cursor: ${extra.cursor}`);
  }
  return exit;
}

export function printSuccess(io: BoardIo, json: boolean, data: Record<string, unknown>, text: string): void {
  io.stdout(json ? JSON.stringify({ v: CLI_OUTPUT_VERSION, ok: true, data }) : text);
}

/* ---------- argument parsing ---------- */

export type OptionSpec = NonNullable<ParseArgsConfig["options"]>;

export const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  board: { type: "string" },
  as: { type: "string" },
  profile: { type: "string" },
  dev: { type: "boolean" },
  gateway: { type: "string" },
  token: { type: "string" },
} as const satisfies OptionSpec;

export type ParsedValues = Record<string, string | boolean | string[] | undefined>;

export function parseVerbArgs(argv: string[], options: OptionSpec): { positionals: string[]; values: ParsedValues } {
  try {
    const parsed = parseArgs({ args: argv, options: { ...GLOBAL_OPTIONS, ...options }, allowPositionals: true, strict: true });
    return { positionals: parsed.positionals, values: parsed.values as ParsedValues };
  } catch (error: unknown) {
    if (error instanceof TypeError) throw new BoardUsageError(error.message.split("\n")[0]!.slice(0, 200));
    throw error;
  }
}

export function messageId(value: string | undefined, what = "message ID"): string {
  if (!value || !BoardMessageIdSchema.safeParse(value).success) usage(`A ${what} like msg_… is required`);
  return value!;
}

export const isMessageId = (value: string | undefined): value is string => Boolean(value && BoardMessageIdSchema.safeParse(value).success);

export function channelPath(value: string | undefined): string {
  if (!value || !ChannelPathSchema.safeParse(value).success) usage("A channel like build or security/scan is required");
  return value!;
}

export function channelScope(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!ChannelScopeSchema.safeParse(value).success) usage("Channel must be a path like build, a subtree like security/, or *");
  return value;
}

export function requireText(parts: string[], what = "Text"): string {
  const text = parts.join(" ");
  if (!text.trim()) usage(`${what} is required`);
  return text;
}

export function profileName(value: unknown, flag = "--as"): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !ProfileNameSchema.safeParse(value).success) {
    usage(`${flag} must be a letter followed by up to 31 letters, digits or hyphens`);
  }
  return value as string;
}

export function strings(value: unknown): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : [];
}

/** `k=v` pairs into a label record. */
export function labelPairs(pairs: string[], flag = "--label"): Record<string, string> | undefined {
  if (pairs.length === 0) return undefined;
  const labels: Record<string, string> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    const key = separator > 0 ? pair.slice(0, separator) : "";
    const value = separator > 0 ? pair.slice(separator + 1) : "";
    if (!LabelKeySchema.safeParse(key).success || !LabelValueSchema.safeParse(value).success) usage(`${flag} takes key=value`);
    labels[key] = value;
  }
  return labels;
}

export function labelKeys(keys: string[], flag: string): string[] | undefined {
  if (keys.length === 0) return undefined;
  for (const key of keys) if (!LabelKeySchema.safeParse(key).success) usage(`${flag} takes a label key`);
  return keys;
}

const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/** `30s`, `5m`, `2h`, or bare seconds; at most 24 h. */
export function parseBoardDuration(value: string, flag = "duration"): number {
  const match = /^([0-9]{1,6})([smh]?)$/.exec(value);
  if (!match) throw new BoardUsageError(`${flag} must look like 30s, 5m or 2h`);
  const unit = match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : 1_000;
  const ms = Number(match[1]) * unit;
  if (ms > MAX_DURATION_MS) throw new BoardUsageError(`${flag} must be at most 24h`);
  return ms;
}

export function optionalDuration(value: unknown, flag: string): number | undefined {
  return typeof value === "string" ? parseBoardDuration(value, flag) : undefined;
}

/** A lease in whole seconds (10 s to 1 h). */
export function leaseSeconds(value: unknown): number | undefined {
  const ms = optionalDuration(value, "--lease");
  if (ms === undefined) return undefined;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 10 || seconds > 3_600) usage("--lease must be between 10s and 1h");
  return seconds;
}

/* ---------- per-invocation context ---------- */

export interface BoardContext {
  deps: BoardDeps;
  client: BoardClient;
  json: boolean;
  /** `--board`, when given. */
  board?: string;
  /** `--as`, when given. */
  profile?: string;
  claims: BoardClaimStore;
  /** Opens a client for another board (a remembered claim's board). */
  clientFor(board: string | undefined): BoardClient;
}

export async function openBoardContext(deps: BoardDeps, values: ParsedValues): Promise<BoardContext> {
  const board = typeof values.board === "string" ? values.board : undefined;
  if (board !== undefined && (board.trim().length === 0 || board.length > 64 || board.includes("/"))) usage("--board must be a board name");
  const profile = profileName(values.as);
  const connection = await deps.resolveConnection(values, deps.env);
  // The pane header names this terminal's agent; it only means something on the loopback path.
  const paneCaller = terminalCallerFromEnv(deps.env);
  const caller = connection.local ? paneCaller : undefined;
  const clientFor = (name: string | undefined) => createBoardClient({
    gatewayUrl: connection.gatewayUrl, token: connection.token,
    ...(name ? { board: name } : {}), ...(caller ? { caller } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  return {
    deps, json: values.json === true, client: clientFor(board), clientFor,
    ...(board ? { board } : {}), ...(profile ? { profile } : {}),
    // Claims are kept per pane even on the profile path, so panes never share a claim file.
    claims: new BoardClaimStore({ home: deps.home, ...(profile ? { profile } : {}), ...(paneCaller ? { caller: paneCaller } : {}), now: deps.now }),
  };
}

/**
 * One `matrix board` verb. `prepare` validates arguments before any connection is
 * made, so a usage error never reaches the gateway; its action returns an exit code.
 */
export interface BoardVerb {
  options?: OptionSpec;
  /** Keeps `--` and everything after it as positionals (`tasks run -- <command>`). */
  passthrough?: boolean;
  prepare(positionals: string[], values: ParsedValues): (ctx: BoardContext) => Promise<number | void>;
}

/** Ctrl-C and SIGTERM as an abort signal; `dispose` removes the handlers. */
export function interruptSignal(signals: BoardSignals): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signals.on("SIGINT", stop);
  signals.on("SIGTERM", stop);
  return {
    signal: controller.signal,
    dispose() {
      signals.off("SIGINT", stop);
      signals.off("SIGTERM", stop);
    },
  };
}
