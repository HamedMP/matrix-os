export type TerminalConnectionStatus =
  | "idle"
  | "connecting"
  | "attached"
  | "detached"
  | "ended"
  | "error";

export type ShellVisualStatus = "running" | "waiting" | "finished" | "idle";

export interface MobileTerminalSession {
  /** The zellij session name (e.g. "matrix-7af3c2e"); the attach identifier. */
  sessionId: string;
  cwd: string;
  state: "running" | "exited" | "destroyed" | string;
  createdAt?: string;
  lastAttachedAt?: string;
  attachedClients?: number;
  exitCode?: number | null;
  // Shell-sessions model (aligned with desktop, so tabs are continuable across clients).
  /** Live UI status from the gateway: running | waiting (needs input) | finished | idle. */
  visualStatus?: ShellVisualStatus;
  updatedAt?: string;
  unread?: boolean;
  tabs?: Array<{ idx: number; name?: string; focused?: boolean }>;
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
  | `ctrl-${LowercaseLetter}`;

type LowercaseLetter =
  | "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m"
  | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z";

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

/* eslint-disable no-control-regex */
const ANSI_OSC = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
const ANSI_CSI = /[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]/g;
const ANSI_ESC = /\u001B[@-_()][0-9A-Za-z]?/g;
const C0_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function stripTerminalControlSequences(input: string): string {
  return input
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_ESC, "")
    .replace(/\r(?!\n)/g, "")
    .replace(C0_CONTROL, "");
}

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
        output: action.replay ? trimTerminalOutput(stripTerminalControlSequences(action.replay)) : state.output,
        error: null,
      };
    case "terminal.output":
      return {
        ...state,
        output: trimTerminalOutput(`${state.output}${stripTerminalControlSequences(action.data)}`),
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
  return SAFE_TERMINAL_SESSION_ID.test(value);
}

export function parseTerminalSessions(value: unknown): MobileTerminalSession[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.sessionId !== "string" || !isSafeSessionId(candidate.sessionId)) {
      return [];
    }
    const session: MobileTerminalSession = {
      sessionId: candidate.sessionId,
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

// Gateway shell-session names: lowercase, digits, hyphens, 1-31 chars (e.g. "matrix-7af3c2e", "main").
const SAFE_SHELL_SESSION_NAME = /^[a-z0-9]([a-z0-9-]{0,29}[a-z0-9])?$/;

export function isSafeShellSessionName(value: string): boolean {
  return SAFE_SHELL_SESSION_NAME.test(value);
}

function mapShellState(status: unknown, visual: unknown): MobileTerminalSession["state"] {
  if (visual === "finished" || status === "exited") return "exited";
  return "running";
}

/**
 * Parse the gateway's shell-sessions response (`GET /api/terminal/sessions`,
 * `ShellSessionSummary[]`). The session `name` is the attach identifier and is
 * carried in `sessionId` so existing consumers keep working during migration.
 */
export function parseShellSessions(value: unknown): MobileTerminalSession[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const c = entry as Record<string, unknown>;
    if (typeof c.name !== "string" || !isSafeShellSessionName(c.name)) return [];
    const session: MobileTerminalSession = {
      sessionId: c.name,
      cwd: typeof c.cwd === "string" ? c.cwd : "~",
      state: mapShellState(c.status, c.visualStatus),
    };
    if (
      c.visualStatus === "running" ||
      c.visualStatus === "waiting" ||
      c.visualStatus === "finished" ||
      c.visualStatus === "idle"
    ) {
      session.visualStatus = c.visualStatus;
    }
    if (typeof c.attachedClients === "number" && Number.isFinite(c.attachedClients)) {
      session.attachedClients = c.attachedClients;
    }
    if (typeof c.updatedAt === "string") session.updatedAt = c.updatedAt;
    if (typeof c.unread === "boolean") session.unread = c.unread;
    if (Array.isArray(c.tabs)) {
      const tabs: NonNullable<MobileTerminalSession["tabs"]> = [];
      for (const tab of c.tabs) {
        if (!tab || typeof tab !== "object") continue;
        const t = tab as Record<string, unknown>;
        if (!Number.isInteger(t.idx)) continue;
        tabs.push({
          idx: t.idx as number,
          ...(typeof t.name === "string" ? { name: t.name } : {}),
          ...(typeof t.focused === "boolean" ? { focused: t.focused } : {}),
        });
      }
      if (tabs.length > 0) session.tabs = tabs;
    }
    return [session];
  });
}

export function buildTerminalControlSequence(key: TerminalControlKey): string {
  if (key.startsWith("ctrl-")) {
    const letter = key.slice(5);
    if (/^[a-z]$/.test(letter)) {
      return String.fromCharCode(letter.charCodeAt(0) - 96);
    }
  }

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
