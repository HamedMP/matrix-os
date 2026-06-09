export type TerminalConnectionStatus =
  | "idle"
  | "connecting"
  | "attached"
  | "detached"
  | "ended"
  | "error";

export interface MobileTerminalSession {
  sessionId: string;
  cwd: string;
  state: "running" | "exited" | "destroyed" | string;
  createdAt?: string;
  lastAttachedAt?: string;
  attachedClients?: number;
  exitCode?: number | null;
}

export interface TerminalState {
  status: TerminalConnectionStatus;
  sessions: MobileTerminalSession[];
  activeSessionId: string | null;
  cwd: string;
  output: string;
  input: string;
  error: string | null;
  fontScale: number;
}

export type TerminalControlKey =
  | "escape"
  | "tab"
  | "enter"
  | "arrow-up"
  | "arrow-down"
  | "arrow-left"
  | "arrow-right"
  | "ctrl-c"
  | "ctrl-d"
  | "ctrl-l";

export type TerminalAction =
  | { type: "connection.changed"; status: TerminalConnectionStatus }
  | { type: "sessions.loaded"; sessions: MobileTerminalSession[] }
  | { type: "terminal.attached"; sessionId: string; cwd?: string; replay?: string }
  | { type: "terminal.output"; data: string }
  | { type: "terminal.input"; input: string }
  | { type: "terminal.clearInput" }
  | { type: "terminal.error"; message: string }
  | { type: "terminal.ended"; exitCode?: number | null }
  | { type: "font.scale"; delta: number }
  | { type: "reset.output" };

export const MAX_TERMINAL_OUTPUT_CHARS = 80_000;
export const MAX_TERMINAL_INPUT_CHARS = 64_000;
const MIN_TERMINAL_FONT_SCALE = 0.85;
const MAX_TERMINAL_FONT_SCALE = 1.3;
const SAFE_TERMINAL_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ZELLIJ_SESSION_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

export const initialTerminalState: TerminalState = {
  status: "idle",
  sessions: [],
  activeSessionId: null,
  cwd: "~",
  output: "",
  input: "",
  error: null,
  fontScale: 1,
};

export function terminalReducer(
  state: TerminalState,
  action: TerminalAction,
): TerminalState {
  switch (action.type) {
    case "connection.changed":
      return {
        ...state,
        status: action.status,
        error: action.status === "error" || (action.status === "detached" && state.status === "error")
          ? state.error
          : null,
      };
    case "sessions.loaded": {
      const activeSessionStillExists = state.activeSessionId
        ? action.sessions.some((session) => session.sessionId === state.activeSessionId)
        : false;
      return {
        ...state,
        sessions: action.sessions,
        activeSessionId: activeSessionStillExists ? state.activeSessionId : null,
      };
    }
    case "terminal.attached":
      return {
        ...state,
        status: "attached",
        activeSessionId: action.sessionId,
        cwd: formatTerminalCwd(action.cwd ?? state.cwd),
        output: action.replay ? trimTerminalOutput(action.replay) : state.output,
        error: null,
      };
    case "terminal.output":
      return {
        ...state,
        output: trimTerminalOutput(`${state.output}${action.data}`),
      };
    case "terminal.input":
      return { ...state, input: action.input.slice(0, MAX_TERMINAL_INPUT_CHARS) };
    case "terminal.clearInput":
      return { ...state, input: "" };
    case "terminal.error":
      return { ...state, status: "error", error: safeTerminalError(action.message) };
    case "terminal.ended":
      return { ...state, status: "ended", error: null };
    case "font.scale":
      return {
        ...state,
        fontScale: clamp(
          Number((state.fontScale + action.delta).toFixed(2)),
          MIN_TERMINAL_FONT_SCALE,
          MAX_TERMINAL_FONT_SCALE,
        ),
      };
    case "reset.output":
      return { ...state, output: "" };
    default:
      return state;
  }
}

export function isSafeSessionId(value: string): boolean {
  return SAFE_TERMINAL_SESSION_ID.test(value) || SAFE_ZELLIJ_SESSION_NAME.test(value);
}

export function parseTerminalSessions(value: unknown): MobileTerminalSession[] {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { sessions?: unknown }).sessions)
      ? (value as { sessions: unknown[] }).sessions
      : [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    const sessionId = typeof candidate.sessionId === "string"
      ? candidate.sessionId
      : typeof candidate.name === "string"
        ? candidate.name
        : null;
    if (!sessionId || !isSafeSessionId(sessionId)) {
      return [];
    }
    const session: MobileTerminalSession = {
      sessionId,
      cwd: typeof candidate.cwd === "string" ? candidate.cwd : "~",
      state: typeof candidate.state === "string" ? candidate.state : "running",
    };
    if (typeof candidate.createdAt === "string") session.createdAt = candidate.createdAt;
    if (typeof candidate.lastAttachedAt === "string") session.lastAttachedAt = candidate.lastAttachedAt;
    if (typeof candidate.attachedClients === "number") session.attachedClients = candidate.attachedClients;
    if (typeof candidate.exitCode === "number" || candidate.exitCode === null) session.exitCode = candidate.exitCode;
    return [session];
  });
}

export function buildTerminalControlSequence(key: TerminalControlKey): string {
  switch (key) {
    case "escape":
      return "\x1b";
    case "tab":
      return "\t";
    case "enter":
      return "\r";
    case "arrow-up":
      return "\x1b[A";
    case "arrow-down":
      return "\x1b[B";
    case "arrow-right":
      return "\x1b[C";
    case "arrow-left":
      return "\x1b[D";
    case "ctrl-c":
      return "\x03";
    case "ctrl-d":
      return "\x04";
    case "ctrl-l":
      return "\x0c";
    default:
      return "";
  }
}

export function formatTerminalCwd(cwd: string | null | undefined): string {
  if (!cwd || cwd === "/") return "~";
  return cwd
    .replace(/^\/home\/matrix\/home(?=\/|$)/, "~")
    .replace(/^\/home\/matrix(?=\/|$)/, "~")
    .replace(/^\/home\/deploy(?=\/|$)/, "~");
}

function trimTerminalOutput(output: string): string {
  if (output.length <= MAX_TERMINAL_OUTPUT_CHARS) return output;
  return output.slice(output.length - MAX_TERMINAL_OUTPUT_CHARS);
}

function safeTerminalError(message: string): string {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 180) return "Terminal unavailable";
  if (/\/home\/|postgres|secret|token|provider/i.test(trimmed)) return "Terminal unavailable";
  return trimmed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
