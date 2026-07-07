import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { SHELL_ATTACH_LIVE_TAIL_FROM_SEQ } from "../protocol/shell.js";

export interface ShellClientOptions {
  gatewayUrl: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ShellClient {
  listSessions(): Promise<unknown[]>;
  runCommand(input: {
    command: string[];
    cwd?: string;
    timeoutMs?: number;
  }): Promise<ShellRunResult>;
  createSession(input: {
    name: string;
    cwd?: string;
    layout?: string;
    cmd?: string;
  }): Promise<Record<string, unknown>>;
  deleteSession(name: string, options?: { force?: boolean }): Promise<void>;
  listTabs(name: string): Promise<unknown[]>;
  createTab(name: string, input: { name?: string; cwd?: string; cmd?: string }): Promise<Record<string, unknown>>;
  switchTab(name: string, tab: number): Promise<Record<string, unknown>>;
  closeTab(name: string, tab: number): Promise<Record<string, unknown>>;
  splitPane(name: string, input: { direction: "right" | "down"; cwd?: string; cmd?: string }): Promise<Record<string, unknown>>;
  closePane(name: string, pane: string): Promise<Record<string, unknown>>;
  listLayouts(): Promise<unknown[]>;
  showLayout(name: string): Promise<Record<string, unknown>>;
  saveLayout(name: string, kdl: string): Promise<Record<string, unknown>>;
  deleteLayout(name: string): Promise<Record<string, unknown>>;
  applyLayout(session: string, layout: string): Promise<Record<string, unknown>>;
  dumpLayout(session: string): Promise<Record<string, unknown>>;
  sendInput(name: string, data: string): Promise<void>;
  createAttachUrl(name: string, options?: { fromSeq?: number; token?: string }): string;
  attachSession(name: string, options?: ShellAttachOptions): Promise<{ detached: boolean }>;
}

export interface ShellClientError extends Error {
  code: string;
}

export interface ShellRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

interface AttachWebSocket {
  send(data: string): void;
  close(): void;
  on(event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void): AttachWebSocket;
  off?(event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void): AttachWebSocket;
}

export interface ShellAttachOptions {
  fromSeq?: number;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  errorOutput?: NodeJS.WriteStream;
  detachSequence?: string;
  mouse?: boolean;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  heartbeatMissesBeforeReconnect?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  WebSocketImpl?: new (url: string, options?: { headers?: Record<string, string> }) => AttachWebSocket;
  noRichPaste?: boolean;
  cwd?: string;
}

export const SHELL_ATTACH_MAX_QUEUED_BYTES = 65_536;
export { SHELL_ATTACH_LIVE_TAIL_FROM_SEQ };
const BRACKETED_PASTE_OPEN = "\u001b[200~";
const BRACKETED_PASTE_CLOSE = "\u001b[201~";
const BRACKETED_PASTE_OVERHEAD = BRACKETED_PASTE_OPEN.length + BRACKETED_PASTE_CLOSE.length;
const SHELL_INPUT_FRAME_MAX_BYTES = 60_000;
const TERMINAL_PASTE_ASSET_BODY_LIMIT = 10 * 1024 * 1024;
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const RUN_RESPONSE_GRACE_MS = 30_000;
const SHELL_ATTACH_HEARTBEAT_INTERVAL_MS = 20_000;
const SHELL_ATTACH_HEARTBEAT_TIMEOUT_MS = 60_000;
const SHELL_ATTACH_RECONNECT_BASE_DELAY_MS = 500;
const SHELL_ATTACH_RECONNECT_MAX_DELAY_MS = 5_000;
const SHELL_ATTACH_HEARTBEAT_MISSES_BEFORE_RECONNECT = 2;
const SHELL_ATTACH_RECONNECT_NOTICE = "\r\n\u001b[7m Matrix shell disconnected. Waiting for the gateway to come back; this session will reconnect automatically. \u001b[0m\r\n";
const SHELL_ATTACH_RECONNECT_NOTICE_CLEAR = "\r\u001b[2K\u001b[1A\r\u001b[2K\u001b[1A\r\u001b[2K";
const LOCAL_TERMINAL_INPUT_RESET = [
  "\u001b[?1000l",
  "\u001b[?1002l",
  "\u001b[?1003l",
  "\u001b[?1006l",
  "\u001b[?1015l",
  "\u001b[?1004l",
  "\u001b[?2004l",
  "\u001b[>4;0m",
  "\u001b[<1u",
].join("");
const MAX_PENDING_ESCAPE_SEQUENCE_CHARS = 128;
const STALE_MOUSE_FOCUS_GUARD_MS = 5_000;
const FOCUS_MOUSE_SUPPRESS_MS = 1_000;
const SAFE_SHELL_SERVER_ERROR_CODES = new Set([
  "auth_expired",
  "session_not_found",
  "zellij_failed",
]);
const LOCAL_IMAGE_MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

type MaybeTtyStream = NodeJS.ReadStream & {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  setRawMode?: (enabled: boolean) => unknown;
  resume?: () => unknown;
  pause?: () => unknown;
};

function terminalSize(input: MaybeTtyStream, output: NodeJS.WriteStream): {
  cols: number;
  rows: number;
} | null {
  const maybeOutput = output as NodeJS.WriteStream & { columns?: number; rows?: number };
  const rawCols = typeof maybeOutput.columns === "number" ? maybeOutput.columns : input.columns;
  const rawRows = typeof maybeOutput.rows === "number" ? maybeOutput.rows : input.rows;
  if (!Number.isInteger(rawCols) || !Number.isInteger(rawRows)) {
    return null;
  }
  const cols = rawCols as number;
  const rows = rawRows as number;
  if (cols < 1 || rows < 1 || cols > 500 || rows > 200) {
    return null;
  }
  return { cols, rows };
}

function createTerminalInputFilter(options: {
  dropMouse: boolean;
  resetLocalInputModes?: () => void;
  now?: () => number;
}) {
  let focused = true;
  let pendingEscapeSequence = "";
  let lastRemoteOutputAt = options.now?.() ?? Date.now();
  let suppressMouseUntil = 0;

  const now = () => options.now?.() ?? Date.now();
  const shouldForwardMouse = () => !options.dropMouse && focused && now() >= suppressMouseUntil;
  const shouldForwardEnhancedKeyboard = () => focused && now() >= suppressMouseUntil;
  const isCsiUParamChar = (char: string | undefined) => char !== undefined && (
    (char >= "0" && char <= "9") ||
    char === ";" ||
    char === ":"
  );

  return {
    noteRemoteOutput() {
      lastRemoteOutputAt = now();
    },
    filter(chunk: string): string {
      const input = pendingEscapeSequence + chunk;
      pendingEscapeSequence = "";
      let output = "";
      for (let i = 0; i < input.length;) {
        if (input[i] !== "\u001b" || input[i + 1] !== "[") {
          output += input[i] ?? "";
          i += 1;
          continue;
        }

        const third = input[i + 2];
        if (third === undefined) {
          pendingEscapeSequence = input.slice(i);
          break;
        }

        if (third === "I" || third === "O") {
          const nextFocused = third === "I";
          focused = nextFocused;
          if (nextFocused && now() - lastRemoteOutputAt >= STALE_MOUSE_FOCUS_GUARD_MS) {
            suppressMouseUntil = now() + FOCUS_MOUSE_SUPPRESS_MS;
            options.resetLocalInputModes?.();
          }
          i += 3;
          continue;
        }

        if (third >= "0" && third <= "9") {
          let end = i + 2;
          while (end < input.length && isCsiUParamChar(input[end])) {
            end += 1;
          }
          if (end >= input.length) {
            pendingEscapeSequence = input.slice(i, Math.min(input.length, i + MAX_PENDING_ESCAPE_SEQUENCE_CHARS));
            break;
          }
          if (input[end] === "u") {
            if (shouldForwardEnhancedKeyboard()) {
              output += input.slice(i, end + 1);
            }
            i = end + 1;
            continue;
          }
        }

        if (third === "<") {
          let end = i + 3;
          while (end < input.length && input[end] !== "M" && input[end] !== "m") {
            end += 1;
          }
          if (end >= input.length) {
            pendingEscapeSequence = input.slice(i, Math.min(input.length, i + MAX_PENDING_ESCAPE_SEQUENCE_CHARS));
            break;
          }
          if (shouldForwardMouse()) {
            output += input.slice(i, end + 1);
          }
          i = end + 1;
          continue;
        }

        if (third === "M") {
          if (i + 6 > input.length) {
            pendingEscapeSequence = input.slice(i, Math.min(input.length, i + MAX_PENDING_ESCAPE_SEQUENCE_CHARS));
            break;
          }
          if (shouldForwardMouse()) {
            output += input.slice(i, i + 6);
          }
          i += 6;
          continue;
        }

        output += input[i] ?? "";
        i += 1;
      }
      return output;
    },
    reset() {
      focused = true;
      pendingEscapeSequence = "";
      suppressMouseUntil = 0;
    },
  };
}

function createUnsupportedTerminalControlDropper() {
  let dropping: "osc" | "string" | null = null;
  let pendingEsc = false;

  return {
    filter(chunk: string): string {
      let output = "";
      for (let i = 0; i < chunk.length; i += 1) {
        const char = chunk[i] ?? "";
        const next = chunk[i + 1];

        if (dropping) {
          if (dropping === "osc" && char === "\u0007") {
            dropping = null;
            continue;
          }
          if (char === "\u001b" && next === "\\") {
            dropping = null;
            i += 1;
          }
          continue;
        }

        if (pendingEsc) {
          pendingEsc = false;
          if (startsUnsupportedStringControl(char)) {
            dropping = char === "]" ? "osc" : "string";
            continue;
          }
          output += `\u001b${char}`;
          continue;
        }

        if (char !== "\u001b") {
          output += char;
          continue;
        }

        if (next === undefined) {
          pendingEsc = true;
          continue;
        }
        if (startsUnsupportedStringControl(next)) {
          dropping = next === "]" ? "osc" : "string";
          i += 1;
          continue;
        }
        output += char;
      }
      return output;
    },
    reset() {
      dropping = null;
      pendingEsc = false;
    },
  };
}

function startsUnsupportedStringControl(char: string | undefined): boolean {
  return char === "]" || char === "P" || char === "_" || char === "^" || char === "X";
}

function splitTerminalInputFrames(data: string): string[] {
  const frames: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of Array.from(data)) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (current && currentBytes + charBytes > SHELL_INPUT_FRAME_MAX_BYTES) {
      frames.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) {
    frames.push(current);
  }
  return frames;
}

function parseSingleLocalImagePath(raw: string): string | null {
  let text = raw.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "").trim();
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  text = text.trim();
  if (!text || !isAbsolute(text) || text.includes("\0")) {
    return null;
  }
  const ext = extname(text).toLowerCase();
  return LOCAL_IMAGE_MIME_BY_EXTENSION.has(ext) ? text : null;
}

function detectLocalImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.slice(0, 6));
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(...bytes.slice(0, 4));
    const webp = String.fromCharCode(...bytes.slice(8, 12));
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  }
  return null;
}

function isLocalFileAccessMiss(err: unknown): boolean {
  const code = err instanceof Error && "code" in err ? (err as { code?: unknown }).code : undefined;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM";
}

function bracketPasteData(data: string): string {
  const capped = data.slice(0, SHELL_INPUT_FRAME_MAX_BYTES - BRACKETED_PASTE_OVERHEAD);
  return `${BRACKETED_PASTE_OPEN}${capped}${BRACKETED_PASTE_CLOSE}`;
}

export function createShellClient(options: ShellClientOptions): ShellClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.gatewayUrl.replace(/\/+$/, "");
  const terminalSessionsPath = "/api/terminal/sessions";
  const terminalLayoutsPath = "/api/terminal/layouts";

  function createAttachUrl(name: string, attachOptions: { fromSeq?: number; token?: string } = {}): string {
    const url = new URL(`${base}/ws/terminal/session`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("session", name);
    if (typeof attachOptions.fromSeq === "number") {
      url.searchParams.set("fromSeq", String(attachOptions.fromSeq));
    }
    if (attachOptions.token) {
      url.searchParams.set("token", attachOptions.token);
    }
    return url.toString();
  }

  async function request(path: string, init: RequestInit = {}, requestTimeoutMs = timeoutMs): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) {
        headers[key] = value;
      }
    } else if (init.headers) {
      Object.assign(headers, init.headers);
    }
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    if (init.body && !headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }

    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err: unknown) {
      throw Object.assign(new Error("Request failed"), {
        code: err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError")
          ? "request_timeout"
          : "gateway_unreachable",
      });
    }
    let payload: unknown = {};
    try {
      payload = await res.json();
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) {
        throw err;
      }
    }

    if (!res.ok) {
      const payloadCode =
        typeof payload === "object" &&
        payload !== null &&
        "error" in payload &&
        typeof (payload as { error?: { code?: unknown } }).error?.code === "string"
          ? (payload as { error: { code: string } }).error.code
          : undefined;
      const code = payloadCode && SAFE_SHELL_SERVER_ERROR_CODES.has(payloadCode)
        ? payloadCode
        : res.status === 401
          ? "auth_expired"
          : "request_failed";
      throw Object.assign(new Error("Request failed"), { code });
    }

    return payload;
  }

  return {
    async listSessions() {
      const payload = await request(terminalSessionsPath);
      if (
        typeof payload === "object" &&
        payload !== null &&
        "sessions" in payload &&
        Array.isArray((payload as { sessions: unknown }).sessions)
      ) {
        return (payload as { sessions: unknown[] }).sessions;
      }
      return [];
    },
    async runCommand(input) {
      const payload = await request("/api/terminal/run", {
        method: "POST",
        body: JSON.stringify(input),
      }, (input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS) + RUN_RESPONSE_GRACE_MS);
      if (typeof payload !== "object" || payload === null) {
        throw Object.assign(new Error("Request failed"), { code: "invalid_response" });
      }
      const result = payload as Partial<ShellRunResult>;
      return {
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" ? result.stderr : "",
        exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
        signal: typeof result.signal === "string" ? result.signal : null,
        timedOut: result.timedOut === true,
        truncated: result.truncated === true,
        durationMs: typeof result.durationMs === "number" ? result.durationMs : 0,
      };
    },
    async createSession(input) {
      return (await request(terminalSessionsPath, {
        method: "POST",
        body: JSON.stringify(input),
      })) as Record<string, unknown>;
    },
    async deleteSession(name, options = {}) {
      const suffix = options.force ? "?force=1" : "";
      await request(`${terminalSessionsPath}/${encodeURIComponent(name)}${suffix}`, {
        method: "DELETE",
      });
    },
    async listTabs(name) {
      const payload = await request(`${terminalSessionsPath}/${encodeURIComponent(name)}/tabs`);
      return typeof payload === "object" && payload !== null && "tabs" in payload && Array.isArray((payload as { tabs: unknown }).tabs)
        ? (payload as { tabs: unknown[] }).tabs
        : [];
    },
    async createTab(name, input) {
      return (await request(`${terminalSessionsPath}/${encodeURIComponent(name)}/tabs`, {
        method: "POST",
        body: JSON.stringify(input),
      })) as Record<string, unknown>;
    },
    async switchTab(name, tab) {
      return (await request(`${terminalSessionsPath}/${encodeURIComponent(name)}/tabs/${tab}/go`, {
        method: "POST",
      })) as Record<string, unknown>;
    },
    async closeTab(name, tab) {
      return (await request(`${terminalSessionsPath}/${encodeURIComponent(name)}/tabs/${tab}`, {
        method: "DELETE",
      })) as Record<string, unknown>;
    },
    async splitPane(name, input) {
      return (await request(`${terminalSessionsPath}/${encodeURIComponent(name)}/panes`, {
        method: "POST",
        body: JSON.stringify(input),
      })) as Record<string, unknown>;
    },
    async closePane(name, pane) {
      return (await request(`${terminalSessionsPath}/${encodeURIComponent(name)}/panes/${encodeURIComponent(pane)}`, {
        method: "DELETE",
      })) as Record<string, unknown>;
    },
    async listLayouts() {
      const payload = await request(terminalLayoutsPath);
      return typeof payload === "object" && payload !== null && "layouts" in payload && Array.isArray((payload as { layouts: unknown }).layouts)
        ? (payload as { layouts: unknown[] }).layouts
        : [];
    },
    async showLayout(name) {
      return (await request(`${terminalLayoutsPath}/${encodeURIComponent(name)}`)) as Record<string, unknown>;
    },
    async saveLayout(name, kdl) {
      return (await request(`${terminalLayoutsPath}/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify({ kdl }),
      })) as Record<string, unknown>;
    },
    async deleteLayout(name) {
      return (await request(`${terminalLayoutsPath}/${encodeURIComponent(name)}`, {
        method: "DELETE",
      })) as Record<string, unknown>;
    },
    async applyLayout(session, layout) {
      return (await request(`${terminalSessionsPath}/${encodeURIComponent(session)}/layouts/${encodeURIComponent(layout)}/apply`, {
        method: "POST",
      })) as Record<string, unknown>;
    },
    async dumpLayout(session) {
      return (await request(`${terminalSessionsPath}/${encodeURIComponent(session)}/layout`)) as Record<string, unknown>;
    },
    async sendInput(name, data) {
      await request(`${terminalSessionsPath}/${encodeURIComponent(name)}/input`, {
        method: "POST",
        body: JSON.stringify({ data }),
      });
    },
    createAttachUrl,
    async attachSession(name, attachOptions = {}) {
      const WebSocketImpl =
        attachOptions.WebSocketImpl ??
        (await import("ws").then((mod) => mod.WebSocket as unknown as ShellAttachOptions["WebSocketImpl"]));
      if (!WebSocketImpl) {
        throw Object.assign(new Error("Request failed"), { code: "websocket_unavailable" });
      }

      const headers = options.token ? { Authorization: `Bearer ${options.token}` } : undefined;
      const output = attachOptions.output ?? process.stdout;
      const errorOutput = attachOptions.errorOutput ?? process.stderr;
      const input = (attachOptions.input ?? process.stdin) as MaybeTtyStream;
      const detachSequence = attachOptions.detachSequence ?? "\u001c\u001c";
      const dropMouse = attachOptions.mouse === false;
      const resetLocalInputModes = () => {
        output.write(LOCAL_TERMINAL_INPUT_RESET);
      };
      const inputFilter = createTerminalInputFilter({
        dropMouse,
        resetLocalInputModes,
      });
      const controlDropper = createUnsupportedTerminalControlDropper();
      const heartbeatIntervalMs = attachOptions.heartbeatIntervalMs ?? SHELL_ATTACH_HEARTBEAT_INTERVAL_MS;
      const heartbeatTimeoutMs = attachOptions.heartbeatTimeoutMs ?? SHELL_ATTACH_HEARTBEAT_TIMEOUT_MS;
      const heartbeatMissesBeforeReconnect =
        attachOptions.heartbeatMissesBeforeReconnect ?? SHELL_ATTACH_HEARTBEAT_MISSES_BEFORE_RECONNECT;
      const reconnectBaseDelayMs = attachOptions.reconnectBaseDelayMs ?? SHELL_ATTACH_RECONNECT_BASE_DELAY_MS;
      const reconnectMaxDelayMs = attachOptions.reconnectMaxDelayMs ?? SHELL_ATTACH_RECONNECT_MAX_DELAY_MS;
      let pendingInput = "";
      let inputQueue = Promise.resolve();
      let queuedAsyncInputs = 0;

      const uploadTerminalPasteAsset = async (filePath: string): Promise<string | null> => {
        const ext = extname(filePath).toLowerCase();
        const expectedMime = LOCAL_IMAGE_MIME_BY_EXTENSION.get(ext);
        if (!expectedMime) {
          return null;
        }
        let fileStat;
        try {
          fileStat = await stat(filePath);
        } catch (err: unknown) {
          if (isLocalFileAccessMiss(err)) {
            return null;
          }
          throw err;
        }
        if (!fileStat.isFile() || fileStat.size < 1 || fileStat.size > TERMINAL_PASTE_ASSET_BODY_LIMIT) {
          return null;
        }
        const bytes = await readFile(filePath);
        if (detectLocalImageMime(bytes) !== expectedMime) {
          return null;
        }
        const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const pasteAssetPath = `${terminalSessionsPath}/${encodeURIComponent(name)}/paste-assets${
          attachOptions.cwd ? `?${new URLSearchParams({ cwd: attachOptions.cwd }).toString()}` : ""
        }`;
        const payload = await request(pasteAssetPath, {
          method: "POST",
          headers: {
            "Content-Type": expectedMime,
            "X-Matrix-Filename": basename(filePath),
          },
          body,
        }, 30_000);
        if (
          typeof payload === "object" &&
          payload !== null &&
          "terminalPath" in payload &&
          typeof (payload as { terminalPath?: unknown }).terminalPath === "string"
        ) {
          return (payload as { terminalPath: string }).terminalPath;
        }
        throw Object.assign(new Error("Request failed"), { code: "invalid_response" });
      };

      return new Promise<{ detached: boolean }>((resolve, reject) => {
        let settled = false;
        let currentWs: AttachWebSocket | null = null;
        let socketOpen = false;
        let everAttached = false;
        let rawModeEnabled = false;
        let reconnecting = false;
        let reconnectAttempt = 0;
        let lastSeq: number | undefined;
        const queuedFrames: string[] = [];
        let queuedFrameBytes = 0;
        let attachTimeout: ReturnType<typeof setTimeout> | undefined;
        let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
        let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
        let heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;
        let heartbeatPending = false;
        let missedHeartbeats = 0;
        let reconnectNoticeVisible = false;
        const cleanup = () => {
          clearTimeout(attachTimeout);
          clearTimeout(reconnectTimer);
          stopHeartbeat();
          cleanupSocket();
          input.off?.("data", onInput);
          process.off("SIGWINCH", onResize);
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
          process.off("exit", onProcessExit);
          pendingInput = "";
          inputFilter.reset();
          controlDropper.reset();
          resetLocalInputModes();
          if (rawModeEnabled) {
            input.setRawMode?.(false);
            rawModeEnabled = false;
          }
          input.pause?.();
        };
        const settle = (fn: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          fn();
        };
        const currentFromSeq = () => {
          if (lastSeq !== undefined) {
            return Math.min(lastSeq + 1, Number.MAX_SAFE_INTEGER);
          }
          return attachOptions.fromSeq ?? SHELL_ATTACH_LIVE_TAIL_FROM_SEQ;
        };
        const stopHeartbeat = () => {
          clearInterval(heartbeatInterval);
          clearTimeout(heartbeatTimeout);
          heartbeatInterval = undefined;
          heartbeatTimeout = undefined;
          heartbeatPending = false;
          missedHeartbeats = 0;
        };
        const noteRemoteActivity = () => {
          clearTimeout(heartbeatTimeout);
          heartbeatTimeout = undefined;
          heartbeatPending = false;
          missedHeartbeats = 0;
        };
        const startHeartbeat = () => {
          if (heartbeatInterval || heartbeatIntervalMs < 1 || heartbeatTimeoutMs < 1) {
            return;
          }
          heartbeatInterval = setInterval(() => {
            if (settled || !currentWs || !socketOpen || heartbeatPending) {
              return;
            }
            try {
              currentWs.send(JSON.stringify({ type: "ping" }));
              heartbeatPending = true;
              heartbeatTimeout = setTimeout(() => {
                if (!settled && heartbeatPending) {
                  missedHeartbeats += 1;
                  heartbeatPending = false;
                  heartbeatTimeout = undefined;
                  if (missedHeartbeats >= heartbeatMissesBeforeReconnect) {
                    currentWs?.close();
                  }
                }
              }, heartbeatTimeoutMs);
              heartbeatTimeout.unref?.();
            } catch (err: unknown) {
              if (!everAttached) {
                settle(() => reject(Object.assign(new Error("Request failed"), {
                  code: err instanceof Error ? "attach_failed" : "request_failed",
                })));
                return;
              }
              currentWs?.close();
            }
          }, heartbeatIntervalMs);
          heartbeatInterval.unref?.();
        };
        const cleanupSocket = () => {
          if (!currentWs) {
            return;
          }
          clearTimeout(attachTimeout);
          stopHeartbeat();
          currentWs.off?.("open", onOpen);
          currentWs.off?.("message", onMessage);
          currentWs.off?.("close", onClose);
          currentWs.off?.("error", onError);
          currentWs = null;
          socketOpen = false;
        };
        const connect = () => {
          if (settled) {
            return;
          }
          cleanupSocket();
          currentWs = new WebSocketImpl(createAttachUrl(name, {
            ...attachOptions,
            fromSeq: currentFromSeq(),
          }), { headers });
          attachTimeout = setTimeout(() => {
            const timedOutWs = currentWs;
            timedOutWs?.close();
            if (everAttached) {
              if (currentWs === timedOutWs) {
                cleanupSocket();
              }
              scheduleReconnect();
              return;
            }
            settle(() => reject(Object.assign(new Error("Request failed"), { code: "attach_timeout" })));
          }, timeoutMs);
          attachTimeout.unref?.();
          currentWs.on("open", onOpen);
          currentWs.on("message", onMessage);
          currentWs.on("close", onClose);
          currentWs.on("error", onError);
        };
        const scheduleReconnect = () => {
          if (settled) {
            return;
          }
          if (reconnectTimer) {
            return;
          }
          if (!reconnecting) {
            errorOutput.write("\r\nConnection lost. Reconnecting...\r\n");
            output.write(SHELL_ATTACH_RECONNECT_NOTICE);
            reconnectNoticeVisible = true;
          }
          reconnecting = true;
          const backoffExponent = Math.min(reconnectAttempt, 31);
          const delay = Math.min(reconnectBaseDelayMs * (2 ** backoffExponent), reconnectMaxDelayMs);
          reconnectAttempt += 1;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            connect();
          }, delay);
          reconnectTimer.unref?.();
        };
        const markOpen = () => {
          if (socketOpen) {
            return;
          }
          socketOpen = true;
          clearTimeout(attachTimeout);
          sendResizeFrame();
          for (const frame of queuedFrames.splice(0)) {
            sendFrame(frame);
          }
          queuedFrameBytes = 0;
        };
        const sendFrame = (frame: string) => {
          if (settled) {
            return;
          }
          if (!socketOpen) {
            const nextQueuedBytes = queuedFrameBytes + Buffer.byteLength(frame, "utf8");
            if (nextQueuedBytes > SHELL_ATTACH_MAX_QUEUED_BYTES) {
              errorOutput.write("Shell attach failed\n");
              currentWs?.close();
              settle(() => reject(Object.assign(new Error("Request failed"), {
                code: "attach_failed",
              })));
              return;
            }
            queuedFrameBytes = nextQueuedBytes;
            queuedFrames.push(frame);
            return;
          }
          try {
            currentWs?.send(frame);
          } catch (err: unknown) {
            if (everAttached) {
              currentWs?.close();
              return;
            }
            errorOutput.write("Shell attach failed\n");
            settle(() => reject(Object.assign(new Error("Request failed"), {
              code: err instanceof Error ? "attach_failed" : "request_failed",
            })));
          }
        };
        const sendInputData = (data: string) => {
          for (const frameData of splitTerminalInputFrames(data)) {
            sendFrame(JSON.stringify({ type: "input", data: frameData }));
          }
        };
        const detachLocal = () => {
          const wsToClose = currentWs;
          sendFrame(JSON.stringify({ type: "detach" }));
          settle(() => resolve({ detached: true }));
          wsToClose?.close();
        };
        const handleInputFailure = (err: unknown) => {
          errorOutput.write("Shell attach failed\n");
          settle(() => reject(Object.assign(new Error("Request failed"), {
            code: err instanceof Error && "code" in err ? (err as { code?: string }).code ?? "attach_failed" : "attach_failed",
          })));
        };
        const processInput = (chunk: Buffer | string): Promise<void> | void => {
          const rawData = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
          if (rawModeEnabled && !everAttached && rawData.includes("\u0003")) {
            detachLocal();
            return;
          }
          const droppedControls = controlDropper.filter(rawData);
          if (!attachOptions.noRichPaste) {
            const localImagePath = parseSingleLocalImagePath(droppedControls);
            if (localImagePath) {
              return uploadTerminalPasteAsset(localImagePath).then((terminalPath) => {
                if (terminalPath) {
                  sendInputData(bracketPasteData(terminalPath));
                  return;
                }
                processPlainInput(droppedControls);
              });
            }
          }
          processPlainInput(droppedControls);
        };
        const processPlainInput = (inputData: string) => {
          const data = inputFilter.filter(inputData);
          let outbound = "";
          for (const char of data) {
            pendingInput += char;
            if (pendingInput === detachSequence) {
              pendingInput = "";
              if (outbound.length > 0) {
                sendInputData(outbound);
              }
              detachLocal();
              return;
            }
            if (detachSequence.startsWith(pendingInput)) {
              continue;
            }
            while (pendingInput.length > 0 && !detachSequence.startsWith(pendingInput)) {
              outbound += pendingInput[0];
              pendingInput = pendingInput.slice(1);
            }
          }
          if (outbound.length > 0) {
            sendInputData(outbound);
          }
        };
        const onInput = (chunk: Buffer | string) => {
          const run = () => {
            try {
              const result = processInput(chunk);
              return Promise.resolve(result);
            } catch (err: unknown) {
              return Promise.reject(err);
            }
          };
          if (queuedAsyncInputs > 0) {
            queuedAsyncInputs += 1;
            inputQueue = inputQueue
              .then(run)
              .catch(handleInputFailure)
              .finally(() => {
                queuedAsyncInputs -= 1;
              });
            return;
          }
          try {
            const result = processInput(chunk);
            if (result && typeof (result as Promise<void>).then === "function") {
              queuedAsyncInputs = 1;
              inputQueue = Promise.resolve(result)
                .catch(handleInputFailure)
                .finally(() => {
                  queuedAsyncInputs -= 1;
                });
            }
          } catch (err: unknown) {
            handleInputFailure(err);
          }
        };
        const sendResizeFrame = () => {
          const size = terminalSize(input, output);
          if (!size) {
            return;
          }
          sendFrame(JSON.stringify({ type: "resize", ...size }));
        };
        const schedulePostAttachResizeFrames = () => {
          setTimeout(sendResizeFrame, 50).unref?.();
          setTimeout(sendResizeFrame, 250).unref?.();
        };
        const onResize = () => {
          sendResizeFrame();
        };
        const onSignal = (signal?: NodeJS.Signals) => {
          if (signal === "SIGTERM" || !everAttached) {
            detachLocal();
            return;
          }
          sendFrame(JSON.stringify({ type: "input", data: "\u0003" }));
          process.once("SIGINT", onSignal);
        };
        const onProcessExit = () => {
          resetLocalInputModes();
          if (rawModeEnabled) {
            input.setRawMode?.(false);
            rawModeEnabled = false;
          }
          input.pause?.();
        };
        const onOpen = () => {
          markOpen();
        };
        const onMessage = (chunk: unknown) => {
          const raw = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (err: unknown) {
            if (!(err instanceof SyntaxError)) {
              reject(err);
            }
            return;
          }
          if (!parsed || typeof parsed !== "object") {
            return;
          }
          const msg = parsed as Record<string, unknown>;
          if (msg.type === "attached") {
            everAttached = true;
            reconnectAttempt = 0;
            markOpen();
            startHeartbeat();
            if (reconnecting) {
              reconnecting = false;
              errorOutput.write("\r\nConnection restored.\r\n");
              if (reconnectNoticeVisible) {
                output.write(SHELL_ATTACH_RECONNECT_NOTICE_CLEAR);
                reconnectNoticeVisible = false;
              }
            }
            schedulePostAttachResizeFrames();
          } else if (msg.type === "output" && typeof msg.data === "string") {
            if (Number.isSafeInteger(msg.seq) && (msg.seq as number) >= 0) {
              lastSeq = msg.seq as number;
            }
            noteRemoteActivity();
            inputFilter.noteRemoteOutput();
            output.write(msg.data);
          } else if (msg.type === "pong") {
            noteRemoteActivity();
          } else if (msg.type === "error") {
            const code = typeof msg.code === "string" && SAFE_SHELL_SERVER_ERROR_CODES.has(msg.code)
              ? msg.code
              : "attach_failed";
            if (everAttached && code === "attach_failed") {
              currentWs?.close();
              return;
            }
            settle(() => reject(Object.assign(new Error("Request failed"), { code })));
          } else if (msg.type === "exit") {
            settle(() => resolve({ detached: false }));
          }
        };
        const onClose = () => {
          const shouldReconnect = everAttached;
          cleanupSocket();
          if (!shouldReconnect) {
            settle(() => reject(Object.assign(new Error("Request failed"), { code: "attach_failed" })));
            return;
          }
          scheduleReconnect();
        };
        const onError = (err: unknown) => {
          if (everAttached) {
            currentWs?.close();
            return;
          }
          errorOutput.write("Shell attach failed\n");
          settle(() => reject(Object.assign(new Error("Request failed"), {
            code: err instanceof Error ? "attach_failed" : "request_failed",
          })));
        };

        if (input.isTTY && typeof input.setRawMode === "function") {
          resetLocalInputModes();
          input.setRawMode(true);
          rawModeEnabled = true;
          input.resume?.();
          process.on("SIGWINCH", onResize);
        }
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
        process.once("exit", onProcessExit);
        input.on?.("data", onInput);
        connect();
      });
    },
  };
}
