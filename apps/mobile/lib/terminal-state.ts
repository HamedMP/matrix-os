export type TerminalConnectionStatus =
  | "idle"
  | "connecting"
  | "attached"
  | "detached"
  | "ended"
  | "error";

export type ShellVisualStatus = "running" | "waiting" | "finished" | "idle";

export interface MobileTerminalSession {
  /** Local serialized TerminalRef key; never an internal Zellij name. */
  sessionId: string;
  workspaceId: string;
  tabId: string;
  revision: number;
  workspaceRevision: number;
  projectId?: string;
  name: string;
  cwd: string;
  state: "running" | "exited" | "destroyed" | string;
  createdAt?: string;
  lastAttachedAt?: string;
  attachedClients?: number;
  exitCode?: number | null;
  // Shell-sessions model (aligned with desktop, so tabs are continuable across clients).
  /** Live UI status from the gateway: running | waiting (needs input) | finished | idle. */
  visualStatus?: ShellVisualStatus;
  agent?: "claude" | "codex" | "opencode" | "pi";
  subtitle?: string;
  lastAction?: string;
  agentUpdatedAt?: string;
  model?: string;
  strength?: string;
  project?: string;
  repository?: string;
  branch?: string;
  pullRequest?: { number: number; url?: string };
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
const SAFE_TERMINAL_REF_KEY = /^tws_[0-9a-f]{32}:tt_[0-9a-f]{32}$/;

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
      const activeSession = state.activeSessionId
        ? action.sessions.find((session) => session.sessionId === state.activeSessionId)
        : undefined;
      return {
        ...state,
        sessions: action.sessions,
        activeSessionId: activeSession ? state.activeSessionId : null,
        cwd: activeSession ? formatTerminalCwd(activeSession.cwd) : state.cwd,
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
  return SAFE_TERMINAL_REF_KEY.test(value);
}

export function parseTerminalSessions(value: unknown): MobileTerminalSession[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const workspace = entry as Record<string, unknown>;
    if (typeof workspace.id !== "string" || !/^tws_[0-9a-f]{32}$/.test(workspace.id) || !Array.isArray(workspace.tabs)) return [];
    const workspaceRevision = typeof workspace.revision === "number" ? workspace.revision : 0;
    const projectId = typeof workspace.projectId === "string" ? workspace.projectId : undefined;
    return workspace.tabs.flatMap((tab) => {
      if (!tab || typeof tab !== "object") return [];
      const c = tab as Record<string, unknown>;
      if (typeof c.id !== "string" || !/^tt_[0-9a-f]{32}$/.test(c.id) || typeof c.name !== "string") return [];
      const session: MobileTerminalSession = {
        sessionId: `${workspace.id}:${c.id}`,
        workspaceId: workspace.id as string,
        tabId: c.id,
        revision: typeof c.revision === "number" ? c.revision : 0,
        workspaceRevision,
        ...(projectId ? { projectId } : {}),
        name: c.name,
        cwd: typeof c.cwd === "string" ? c.cwd : "",
        state: c.status === "exited" || c.status === "failed" ? "exited" : "running",
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
    const agent = c.agent && typeof c.agent === "object" ? (c.agent as Record<string, unknown>).providerId : undefined;
    if (agent === "claude" || agent === "codex" || agent === "opencode" || agent === "pi") {
      session.agent = agent;
    }
    if (typeof c.subtitle === "string") session.subtitle = c.subtitle;
    if (typeof c.lastAction === "string") session.lastAction = c.lastAction;
    if (typeof c.agentUpdatedAt === "string") session.agentUpdatedAt = c.agentUpdatedAt;
    if (typeof c.model === "string") session.model = c.model;
    if (typeof c.strength === "string") session.strength = c.strength;
    if (typeof c.project === "string") session.project = c.project;
    if (typeof c.repository === "string") session.repository = c.repository;
    if (typeof c.branch === "string") session.branch = c.branch;
    if (c.pullRequest && typeof c.pullRequest === "object") {
      const pullRequest = c.pullRequest as Record<string, unknown>;
      if (Number.isSafeInteger(pullRequest.number) && (pullRequest.number as number) > 0) {
        session.pullRequest = {
          number: pullRequest.number as number,
          ...(typeof pullRequest.url === "string" ? { url: pullRequest.url } : {}),
        };
      }
    }
      return [session];
    });
  });
}

export const parseShellSessions = parseTerminalSessions;

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

/**
 * Keyboard lift that keeps the cursor visible instead of always lifting by
 * the full keyboard height. A fresh session with the prompt on the first row
 * needs no lift at all; a full-screen TUI with the cursor at the bottom needs
 * the whole keyboard height. Unknown cursor position falls back to the full
 * lift so text entry is never hidden.
 */
export function computeCursorKeyboardLift(options: {
  /** Cursor bottom edge in window coordinates (unlifted), or null if unknown. */
  cursorBottomY: number | null;
  /** Top edge of the keyboard (plus any bars above it) in window coordinates. */
  keyboardTopY: number;
  /** The full lift (keyboard height minus safe-area inset). */
  maxLift: number;
  /** Breathing room kept between cursor and keyboard. */
  padding?: number;
}): number {
  const { cursorBottomY, keyboardTopY, maxLift } = options;
  const padding = options.padding ?? 16;
  if (maxLift <= 0) return 0;
  if (cursorBottomY === null || !Number.isFinite(cursorBottomY)) return maxLift;
  return clamp(cursorBottomY + padding - keyboardTopY, 0, maxLift);
}
