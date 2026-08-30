import { SHELL_ATTACH_LIVE_TAIL_FROM_SEQ } from "../protocol/shell.js";
import { z } from "zod/v4";
import {
  createMacOsClipboardImageReader,
  type ClipboardImageReader,
} from "./clipboard-image.js";
import {
  createRichPasteRewriter,
  createRichPasteUploadClient,
  shouldProcessRichPasteText,
  type RichPasteInputSegment,
  type RichPasteRewriter,
  type RichPasteUploadClient,
} from "./rich-paste.js";

export interface ShellClientOptions {
  gatewayUrl: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ShellClient {
  listWorkspaces(): Promise<unknown[]>;
  listProjects(): Promise<unknown[]>;
  ensureWorkspace(input?: { projectId?: string }): Promise<Record<string, unknown>>;
  runCommand(input: {
    command: string[];
    cwd?: string;
    timeoutMs?: number;
  }): Promise<ShellRunResult>;
  createTab(workspaceId: string, input: {
    name: string;
    cwd?: string;
    command?: string[];
  }): Promise<Record<string, unknown>>;
  terminateTab(ref: TerminalRef): Promise<void>;
  createAttachUrl(ref: TerminalRef, options?: { fromSeq?: number; token?: string; size?: { cols: number; rows: number } | null }): string;
  sendInput(ref: TerminalRef, data: string): Promise<void>;
  attachTab(ref: TerminalRef, options?: ShellAttachOptions): Promise<{ detached: boolean; exitCode: number | null }>;
}

export interface TerminalRef { workspaceId: string; tabId: string }

const TerminalRefSchema = z.object({
  workspaceId: z.string().regex(/^tws_[0-9a-f]{32}$/),
  tabId: z.string().regex(/^tt_[0-9a-f]{32}$/),
}).strict();
const TerminalGridSizeSchema = z.object({
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
}).strict();
const TerminalServerEventBaseSchema = z.object({
  terminalRef: TerminalRefSchema,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
const TerminalServerFrameSchema = z.discriminatedUnion("type", [
  TerminalServerEventBaseSchema.extend({
    type: z.literal("attached"),
    canonicalSize: TerminalGridSizeSchema,
    nextSeq: z.number().int().min(0),
  }).strict(),
  TerminalServerEventBaseSchema.extend({
    type: z.literal("snapshot"),
    canonicalSize: TerminalGridSizeSchema,
    seq: z.number().int().min(0),
    ansi: z.string().max(4 * 1024 * 1024),
    viewport: z.object({
      top: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      rows: z.number().int().min(1).max(200),
    }).strict(),
  }).strict(),
  TerminalServerEventBaseSchema.extend({
    type: z.literal("output"),
    seq: z.number().int().min(0),
    data: z.string().min(1).max(64 * 1024),
  }).strict(),
  TerminalServerEventBaseSchema.extend({ type: z.literal("replay-start"), fromSeq: z.number().int().min(0) }).strict(),
  TerminalServerEventBaseSchema.extend({
    type: z.literal("replay-evicted"),
    fromSeq: z.number().int().min(0),
    nextSeq: z.number().int().min(0),
  }).strict(),
  TerminalServerEventBaseSchema.extend({
    type: z.literal("replay-gap"),
    fromSeq: z.number().int().min(0),
    nextSeq: z.number().int().min(0),
  }).strict(),
  TerminalServerEventBaseSchema.extend({
    type: z.literal("replay-end"),
    nextSeq: z.number().int().min(0),
    toSeq: z.number().int().min(0).nullable().optional(),
  }).strict(),
  TerminalServerEventBaseSchema.extend({ type: z.literal("canonical-size"), canonicalSize: TerminalGridSizeSchema }).strict(),
  TerminalServerEventBaseSchema.extend({ type: z.literal("pong") }).strict(),
  TerminalServerEventBaseSchema.extend({ type: z.literal("exit"), exitCode: z.number().int().nullable() }).strict(),
  z.object({
    type: z.literal("error"),
    terminalRef: TerminalRefSchema.optional(),
    code: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
    message: z.string().min(1).max(720),
  }).strict(),
  z.object({
    type: z.literal("safe-error"),
    terminalRef: TerminalRefSchema.optional(),
    error: z.object({
      code: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
      message: z.string().min(1).max(720),
    }).strict(),
  }).strict(),
]);

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
  showReconnectStatus?: boolean;
  WebSocketImpl?: new (url: string, options?: { headers?: Record<string, string> }) => AttachWebSocket;
  richPaste?: {
    enabled?: boolean;
    rewriter?: RichPasteRewriter;
    uploadClient?: RichPasteUploadClient;
    clipboardReader?: ClipboardImageReader;
    statusMinVisibleMs?: number;
  };
  noRichPaste?: boolean;
  cwd?: string;
}

export const SHELL_ATTACH_MAX_QUEUED_BYTES = 65_536;
export { SHELL_ATTACH_LIVE_TAIL_FROM_SEQ };
const BRACKETED_PASTE_OPEN = "\u001b[200~";
const BRACKETED_PASTE_CLOSE = "\u001b[201~";
const LOCAL_CLIPBOARD_IMAGE_PASTE_SUFFIX = "v";
const SHELL_ATTACH_MAX_PENDING_BRACKETED_PASTE_CHARS = 1024 * 1024;
const BRACKETED_PASTE_INCOMPLETE_TIMEOUT_MS = 250;
const SHELL_INPUT_FRAME_MAX_BYTES = 60_000;
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
const RICH_PASTE_UPLOAD_FAILED_MESSAGE = "Image paste failed: upload did not complete.";
const INCOMPLETE_BRACKETED_PASTE_MESSAGE = "Image paste failed: paste did not complete.";
const RICH_PASTE_PROGRESS_MESSAGE = "Image paste: reading/uploading...";
const RICH_PASTE_INSERTED_MESSAGE = "Image paste: inserted.";
const RICH_PASTE_STATUS_MIN_VISIBLE_MS = 1_200;

type MaybeTtyStream = NodeJS.ReadStream & {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  setRawMode?: (enabled: boolean) => unknown;
  resume?: () => unknown;
  pause?: () => unknown;
};

type AttachWriter = (data: string, options?: { allowAfterSettled?: boolean }) => boolean;

function isEpipeError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code?: unknown }).code === "EPIPE";
}

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

function createBracketedPasteStreamParser(options: {
  onIncompletePaste?: () => void;
  incompletePasteTimeoutMs?: number;
} = {}) {
  let pending = "";
  let suppressedCloseMarkerTail = "";
  let incompletePasteTimer: ReturnType<typeof setTimeout> | undefined;

  const clearIncompletePasteTimer = () => {
    clearTimeout(incompletePasteTimer);
    incompletePasteTimer = undefined;
  };

  const discardIncompletePaste = () => {
    if (pending.startsWith(BRACKETED_PASTE_OPEN)) {
      const closePrefixLength = longestSuffixPrefixLength(pending, BRACKETED_PASTE_CLOSE);
      suppressedCloseMarkerTail = closePrefixLength > 0
        ? BRACKETED_PASTE_CLOSE.slice(closePrefixLength)
        : "";
      options.onIncompletePaste?.();
    }
    pending = "";
    clearIncompletePasteTimer();
  };

  const setPending = (value: string) => {
    pending = value;
    clearIncompletePasteTimer();
    if (!pending.startsWith(BRACKETED_PASTE_OPEN)) {
      return;
    }
    const timeoutMs = options.incompletePasteTimeoutMs ?? BRACKETED_PASTE_INCOMPLETE_TIMEOUT_MS;
    if (timeoutMs < 1) {
      return;
    }
    incompletePasteTimer = setTimeout(discardIncompletePaste, timeoutMs);
    incompletePasteTimer.unref?.();
  };

  return {
    push(chunk: string): RichPasteInputSegment[] {
      let nextChunk = chunk;
      if (suppressedCloseMarkerTail) {
        if (suppressedCloseMarkerTail.startsWith(nextChunk)) {
          suppressedCloseMarkerTail = suppressedCloseMarkerTail.slice(nextChunk.length);
          return [];
        }
        if (nextChunk.startsWith(suppressedCloseMarkerTail)) {
          nextChunk = nextChunk.slice(suppressedCloseMarkerTail.length);
        }
        suppressedCloseMarkerTail = "";
      }

      const input = pending + nextChunk;
      setPending("");
      const segments: RichPasteInputSegment[] = [];
      let cursor = 0;

      while (cursor < input.length) {
        const start = input.indexOf(BRACKETED_PASTE_OPEN, cursor);
        if (start === -1) {
          const tail = input.slice(cursor);
          const heldLength = longestSuffixPrefixLength(tail, BRACKETED_PASTE_OPEN);
          const ready = tail.slice(0, tail.length - heldLength);
          if (ready.length > 0) {
            segments.push({ text: ready, observablePaste: false });
          }
          setPending(tail.slice(tail.length - heldLength));
          break;
        }

        if (start > cursor) {
          segments.push({ text: input.slice(cursor, start), observablePaste: false });
        }

        const contentStart = start + BRACKETED_PASTE_OPEN.length;
        const end = input.indexOf(BRACKETED_PASTE_CLOSE, contentStart);
        if (end === -1) {
          setPending(input.slice(start));
          break;
        }

        segments.push({
          text: input.slice(contentStart, end),
          observablePaste: true,
        });
        cursor = end + BRACKETED_PASTE_CLOSE.length;
      }

      if (pending.length > SHELL_ATTACH_MAX_PENDING_BRACKETED_PASTE_CHARS) {
        discardIncompletePaste();
      }

      return segments;
    },
    reset() {
      pending = "";
      suppressedCloseMarkerTail = "";
      clearIncompletePasteTimer();
    },
  };
}

function longestSuffixPrefixLength(value: string, prefix: string): number {
  const maxLength = Math.min(value.length, prefix.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (prefix.startsWith(value.slice(value.length - length))) {
      return length;
    }
  }
  return 0;
}

export function createShellClient(options: ShellClientOptions): ShellClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.gatewayUrl.replace(/\/+$/, "");
  const terminalWorkspacesPath = "/api/terminal/workspaces";

  function createAttachUrl(ref: TerminalRef, attachOptions: { fromSeq?: number; token?: string; size?: { cols: number; rows: number } | null } = {}): string {
    const url = new URL(`${base}/ws/terminal/tab`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("workspaceId", ref.workspaceId);
    url.searchParams.set("tabId", ref.tabId);
    url.searchParams.set("client", "cli");
    if (attachOptions.size) {
      // Declare as a hard sizing client (spec 107 FR-007): a TTY cannot scale
      // its render, so its size participates in canonical-size negotiation.
      // Without a known size the declaration is omitted (legacy behavior) so
      // an undeclared hard client can never pin the session to a fallback.
      url.searchParams.set("client", "hard");
      url.searchParams.set("cols", String(attachOptions.size.cols));
      url.searchParams.set("rows", String(attachOptions.size.rows));
      url.searchParams.set("lease", "exclusive");
    }
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

  async function sendOneShotInput(url: string, ref: TerminalRef, data: string): Promise<void> {
    const WebSocketImpl = await import("ws").then((mod) => mod.WebSocket as unknown as NonNullable<ShellAttachOptions["WebSocketImpl"]>);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocketImpl(url, options.token ? { headers: { Authorization: `Bearer ${options.token}` } } : undefined);
      const timer = setTimeout(() => {
        ws.close();
        reject(Object.assign(new Error("Request failed"), { code: "request_timeout" }));
      }, timeoutMs);
      timer.unref?.();
      const finish = (error?: Error) => {
        clearTimeout(timer);
        ws.close();
        if (error) reject(error); else resolve();
      };
      ws.on("message", (raw: unknown) => {
        try {
          const frame = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)) as { type?: unknown };
          if (frame.type !== "attached") return;
          ws.send(JSON.stringify({ type: "input", terminalRef: ref, data }));
          ws.send(JSON.stringify({ type: "detach", terminalRef: ref }));
          finish();
        } catch (error) {
          console.error(
            "matrix shell: invalid terminal response",
            error instanceof Error ? error.name : "unknown_error",
          );
          finish(Object.assign(new Error("Request failed"), { code: "invalid_response" }));
        }
      });
      ws.on("error", () => finish(Object.assign(new Error("Request failed"), { code: "attach_failed" })));
    });
  }

  return {
    async listWorkspaces() {
      const payload = await request(terminalWorkspacesPath);
      if (
        typeof payload === "object" &&
        payload !== null &&
        "workspaces" in payload &&
        Array.isArray((payload as { workspaces: unknown }).workspaces)
      ) {
        return (payload as { workspaces: unknown[] }).workspaces;
      }
      return [];
    },
    async listProjects() {
      const payload = await request("/api/coding-agents/summary");
      if (!payload || typeof payload !== "object") return [];
      const projects = (payload as { projects?: { items?: unknown } }).projects?.items;
      return Array.isArray(projects) ? projects : [];
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
    async ensureWorkspace(input = {}) {
      return (await request(`${terminalWorkspacesPath}/ensure`, {
        method: "POST",
        body: JSON.stringify(input),
      })) as Record<string, unknown>;
    },
    async createTab(workspaceId, input) {
      return (await request(`${terminalWorkspacesPath}/${encodeURIComponent(workspaceId)}/tabs`, {
        method: "POST",
        body: JSON.stringify(input),
      })) as Record<string, unknown>;
    },
    async terminateTab(ref) {
      await request(`${terminalWorkspacesPath}/${encodeURIComponent(ref.workspaceId)}/tabs/${encodeURIComponent(ref.tabId)}`, {
        method: "DELETE",
      });
    },
    createAttachUrl,
    async sendInput(ref, data) {
      await sendOneShotInput(createAttachUrl(ref, { token: options.token }), ref, data);
    },
    async attachTab(ref, attachOptions = {}) {
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
      const localCommandPrefix = detachSequence[0] ?? "\u001c";
      const clipboardPasteSequence = `${localCommandPrefix}${LOCAL_CLIPBOARD_IMAGE_PASTE_SUFFIX}`;
      const dropMouse = attachOptions.mouse === false;
      let writeAttachOutput: AttachWriter = (data: string) => {
        try {
          output.write(data);
          return true;
        } catch (err: unknown) {
          if (!isEpipeError(err)) {
            console.warn("[shell] failed to write attach output:", err instanceof Error ? err.message : String(err));
          }
          return false;
        }
      };
      let writeAttachError: AttachWriter = (data: string) => {
        try {
          errorOutput.write(data);
          return true;
        } catch (err: unknown) {
          if (!isEpipeError(err)) {
            console.warn("[shell] failed to write attach error output:", err instanceof Error ? err.message : String(err));
          }
          return false;
        }
      };
      const resetLocalInputModes = () => {
        writeAttachOutput(LOCAL_TERMINAL_INPUT_RESET, { allowAfterSettled: true });
      };
      const inputFilter = createTerminalInputFilter({
        dropMouse,
        resetLocalInputModes,
      });
      const controlDropper = createUnsupportedTerminalControlDropper();
      const bracketedPasteParser = createBracketedPasteStreamParser({
        onIncompletePaste: () => {
          writeAttachError(`\r\n${INCOMPLETE_BRACKETED_PASTE_MESSAGE}\r\n`);
        },
      });
      const richPasteEnabled = attachOptions.noRichPaste !== true && attachOptions.richPaste?.enabled !== false;
      const richPasteRewriter: RichPasteRewriter | undefined = richPasteEnabled
        ? attachOptions.richPaste?.rewriter ?? createRichPasteRewriter({
          uploadClient: attachOptions.richPaste?.uploadClient ?? createRichPasteUploadClient({
            gatewayUrl: base,
            token: options.token,
            fetch: fetchImpl,
            cwd: attachOptions.cwd,
          }),
          clipboardReader: attachOptions.richPaste?.clipboardReader ?? createMacOsClipboardImageReader(),
        })
        : undefined;
      const configuredRichPasteStatusMinVisibleMs = attachOptions.richPaste?.statusMinVisibleMs;
      const richPasteStatusMinVisibleMs = typeof configuredRichPasteStatusMinVisibleMs === "number" &&
        Number.isFinite(configuredRichPasteStatusMinVisibleMs)
        ? Math.max(0, configuredRichPasteStatusMinVisibleMs)
        : RICH_PASTE_STATUS_MIN_VISIBLE_MS;
      const heartbeatIntervalMs = attachOptions.heartbeatIntervalMs ?? SHELL_ATTACH_HEARTBEAT_INTERVAL_MS;
      const heartbeatTimeoutMs = attachOptions.heartbeatTimeoutMs ?? SHELL_ATTACH_HEARTBEAT_TIMEOUT_MS;
      const heartbeatMissesBeforeReconnect =
        attachOptions.heartbeatMissesBeforeReconnect ?? SHELL_ATTACH_HEARTBEAT_MISSES_BEFORE_RECONNECT;
      const reconnectBaseDelayMs = attachOptions.reconnectBaseDelayMs ?? SHELL_ATTACH_RECONNECT_BASE_DELAY_MS;
      const reconnectMaxDelayMs = attachOptions.reconnectMaxDelayMs ?? SHELL_ATTACH_RECONNECT_MAX_DELAY_MS;
      let pendingInput = "";
      let inputQueue = Promise.resolve();
      let queuedAsyncInputs = 0;

      return new Promise<{ detached: boolean; exitCode: number | null }>((resolve, reject) => {
        let settled = false;
        let currentWs: AttachWebSocket | null = null;
        let currentSocketListeners: {
          ws: AttachWebSocket;
          onOpen: () => void;
          onMessage: (chunk: unknown) => void;
          onClose: () => void;
          onError: (err: unknown) => void;
        } | null = null;
        let socketOpen = false;
        let everAttached = false;
        let rawModeEnabled = false;
        let reconnecting = false;
        let reconnectAttempt = 0;
        let socketGeneration = 0;
        let lastSeq: number | undefined;
        let lastRevision = -1;
        const queuedFrames: string[] = [];
        let queuedFrameBytes = 0;
        let attachTimeout: ReturnType<typeof setTimeout> | undefined;
        let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
        let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
        let heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;
        let heartbeatPending = false;
        let missedHeartbeats = 0;
        let reconnectNoticeVisible = false;
        let localOutputBackpressured = false;
        const detachForClosedLocalPipe = () => {
          if (settled) {
            return;
          }
          const wsToClose = currentWs;
          if (socketOpen) {
            try {
              wsToClose?.send(JSON.stringify({ type: "detach", terminalRef: ref }));
            } catch (err: unknown) {
              console.warn("[shell] failed to send detach after local pipe closed:", err instanceof Error ? err.message : String(err));
            }
          }
          settle(() => resolve({ detached: true, exitCode: null }));
          wsToClose?.close();
        };
        const handleLocalStreamError = (err: unknown) => {
          if (isEpipeError(err)) {
            detachForClosedLocalPipe();
            return;
          }
          const wsToClose = currentWs;
          settle(() => reject(Object.assign(new Error("Request failed"), { code: "attach_failed" })));
          wsToClose?.close();
        };
        const writeOutput: AttachWriter = (data, writeOptions = {}) => {
          if (settled && !writeOptions.allowAfterSettled) {
            return false;
          }
          try {
            output.write(data);
            return true;
          } catch (err: unknown) {
            handleLocalStreamError(err);
            return false;
          }
        };
        const writeError: AttachWriter = (data, writeOptions = {}) => {
          if (settled && !writeOptions.allowAfterSettled) {
            return false;
          }
          try {
            errorOutput.write(data);
            return true;
          } catch (err: unknown) {
            handleLocalStreamError(err);
            return false;
          }
        };
        writeAttachOutput = writeOutput;
        writeAttachError = writeError;
        const onLocalStreamError = (err: unknown) => {
          handleLocalStreamError(err);
        };
        const onLocalOutputDrain = () => {
          if (settled || !localOutputBackpressured) {
            return;
          }
          localOutputBackpressured = false;
          scheduleReconnect();
        };
        const writeRemoteOutput = (data: string): boolean => {
          if (settled || localOutputBackpressured) {
            return false;
          }
          try {
            const canContinue = output.write(data);
            if (canContinue === false) {
              localOutputBackpressured = true;
              output.once?.("drain", onLocalOutputDrain);
              currentWs?.close();
            }
            return true;
          } catch (err: unknown) {
            handleLocalStreamError(err);
            return false;
          }
        };
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
          output.off?.("error", onLocalStreamError);
          output.off?.("drain", onLocalOutputDrain);
          errorOutput.off?.("error", onLocalStreamError);
          pendingInput = "";
          inputFilter.reset();
          controlDropper.reset();
          bracketedPasteParser.reset();
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
              currentWs.send(JSON.stringify({ type: "ping", terminalRef: ref }));
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
          if (currentSocketListeners) {
            currentSocketListeners.ws.off?.("open", currentSocketListeners.onOpen);
            currentSocketListeners.ws.off?.("message", currentSocketListeners.onMessage);
            currentSocketListeners.ws.off?.("close", currentSocketListeners.onClose);
            currentSocketListeners.ws.off?.("error", currentSocketListeners.onError);
          }
          currentSocketListeners = null;
          currentWs = null;
          socketOpen = false;
        };
        const connect = () => {
          if (settled) {
            return;
          }
          cleanupSocket();
          const generation = socketGeneration + 1;
          socketGeneration = generation;
          // Revisions are ordered only within one runtime attachment. A resize
          // can advance the workspace revision beyond the tab revision used by
          // the next attachment, so never compare revisions across sockets.
          lastRevision = -1;
          const ws = new WebSocketImpl(createAttachUrl(ref, {
            ...attachOptions,
            fromSeq: currentFromSeq(),
            size: terminalSize(input, output),
          }), { headers });
          currentWs = ws;
          const isCurrentSocket = () => currentWs === ws && socketGeneration === generation && !settled;
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
          currentSocketListeners = {
            ws,
            onOpen: () => {
              if (isCurrentSocket()) onOpen();
            },
            onMessage: (chunk: unknown) => {
              if (isCurrentSocket()) onMessage(chunk);
            },
            onClose: () => {
              if (isCurrentSocket()) onClose();
            },
            onError: (err: unknown) => {
              if (isCurrentSocket()) onError(err);
            },
          };
          ws.on("open", currentSocketListeners.onOpen);
          ws.on("message", currentSocketListeners.onMessage);
          ws.on("close", currentSocketListeners.onClose);
          ws.on("error", currentSocketListeners.onError);
        };
        const scheduleReconnect = () => {
          if (settled) {
            return;
          }
          if (reconnectTimer) {
            return;
          }
          if (!reconnecting && attachOptions.showReconnectStatus === true) {
            writeError("\r\nConnection lost. Reconnecting...\r\n");
            writeOutput(SHELL_ATTACH_RECONNECT_NOTICE);
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
              writeError("Shell attach failed\n");
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
            writeError("Shell attach failed\n");
            settle(() => reject(Object.assign(new Error("Request failed"), {
              code: err instanceof Error ? "attach_failed" : "request_failed",
            })));
          }
        };
        const sendInputData = (data: string) => {
          for (const frameData of splitTerminalInputFrames(data)) {
            sendFrame(JSON.stringify({ type: "input", terminalRef: ref, data: frameData }));
          }
        };
        const detachLocal = () => {
          const wsToClose = currentWs;
          sendFrame(JSON.stringify({ type: "detach", terminalRef: ref }));
          settle(() => resolve({ detached: true, exitCode: null }));
          wsToClose?.close();
        };
        const handleInputFailure = (err: unknown) => {
          writeError("Shell attach failed\n");
          settle(() => reject(Object.assign(new Error("Request failed"), {
            code: err instanceof Error && "code" in err ? (err as { code?: string }).code ?? "attach_failed" : "attach_failed",
          })));
        };
        const waitForRichPasteStatusVisibility = (shownAt: number): Promise<void> => {
          const remainingMs = richPasteStatusMinVisibleMs - (Date.now() - shownAt);
          if (remainingMs <= 0) {
            return Promise.resolve();
          }
          return new Promise((resolveDelay) => {
            const timer = setTimeout(resolveDelay, remainingMs);
            timer.unref?.();
          });
        };
        const sendInputFrame = (
          data: string,
          observablePaste: boolean,
          options: { manualClipboardPaste?: boolean } = {},
        ): Promise<void> | void => {
          const shouldRewrite = options.manualClipboardPaste || (observablePaste
            ? data.length === 0 || shouldProcessRichPasteText(data)
            : shouldProcessRichPasteText(data));
          if (!richPasteRewriter || !shouldRewrite) {
            sendInputData(data);
            return;
          }
          const progressShownAt = Date.now();
          writeError(`\r\n${RICH_PASTE_PROGRESS_MESSAGE}\r\n`);
          return richPasteRewriter.rewrite({
            sessionName: `${ref.workspaceId}:${ref.tabId}`,
            text: options.manualClipboardPaste ? "" : data,
            observablePaste: options.manualClipboardPaste ? true : observablePaste,
          }).then(async (result) => {
            await waitForRichPasteStatusVisibility(progressShownAt);
            if (settled) {
              return;
            }
            if (result.status === "failed") {
              writeError(`\r\n${result.localMessage}\r\n`);
              return;
            }
            if (result.status === "rewritten") {
              writeError(`\r\n${RICH_PASTE_INSERTED_MESSAGE}\r\n`);
            }
            sendInputData(result.outgoingText);
          }).catch(async (err: unknown) => {
            await waitForRichPasteStatusVisibility(progressShownAt);
            if (!settled) {
              writeError(`\r\n${RICH_PASTE_UPLOAD_FAILED_MESSAGE}\r\n`);
              writeError(`[debug] rich paste rewrite failed: ${err instanceof Error ? err.name : typeof err}\r\n`);
            }
          });
        };
        const processInputData = (data: string, observablePaste: boolean): Promise<void> | void => {
          let outbound = "";
          let sequence: Promise<void> | undefined;
          const enqueueInputFrame = (
            frameData: string,
            frameObservablePaste: boolean,
            frameOptions: { manualClipboardPaste?: boolean } = {},
          ) => {
            const run = () => Promise.resolve(sendInputFrame(frameData, frameObservablePaste, frameOptions));
            if (sequence) {
              sequence = sequence.then(run);
              return;
            }
            const maybeWrite = sendInputFrame(frameData, frameObservablePaste, frameOptions);
            if (maybeWrite) {
              sequence = Promise.resolve(maybeWrite);
            }
          };
          for (const char of data) {
            pendingInput += char;
            if (!observablePaste && pendingInput === clipboardPasteSequence) {
              pendingInput = "";
              if (outbound.length > 0) {
                enqueueInputFrame(outbound, false);
                outbound = "";
              }
              enqueueInputFrame("", false, { manualClipboardPaste: true });
              continue;
            }
            if (!observablePaste && clipboardPasteSequence.startsWith(pendingInput)) {
              continue;
            }
            if (pendingInput === detachSequence) {
              pendingInput = "";
              if (outbound.length > 0) {
                enqueueInputFrame(outbound, false);
              }
              detachLocal();
              return sequence;
            }
            if (detachSequence.startsWith(pendingInput)) {
              continue;
            }
            while (pendingInput.length > 0 && !detachSequence.startsWith(pendingInput)) {
              const nextChar = pendingInput[0] ?? "";
              pendingInput = pendingInput.slice(1);
              outbound += nextChar;
            }
          }
          if (outbound.length > 0 || observablePaste) {
            enqueueInputFrame(outbound, observablePaste);
          }
          return sequence;
        };
        const processInput = (chunk: Buffer | string): Promise<void> | void => {
          const rawData = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
          if (rawModeEnabled && !everAttached && rawData.includes("\u0003")) {
            detachLocal();
            return;
          }
          const droppedControls = controlDropper.filter(rawData);
          const bracketedSegments = bracketedPasteParser.push(droppedControls);
          if (bracketedSegments.length === 0) {
            return;
          }
          let sequence: Promise<void> | undefined;
          for (const segment of bracketedSegments) {
            const runSegment = () => Promise.resolve(processInputData(
              segment.observablePaste ? segment.text : inputFilter.filter(segment.text),
              segment.observablePaste,
            ));
            if (sequence) {
              sequence = sequence.then(runSegment);
              continue;
            }
            const result = processInputData(
              segment.observablePaste ? segment.text : inputFilter.filter(segment.text),
              segment.observablePaste,
            );
            if (result) {
              sequence = result;
            }
          }
          return sequence;
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
          sendFrame(JSON.stringify({ type: "resize", terminalRef: ref, mode: "hard", size }));
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
          sendFrame(JSON.stringify({ type: "input", terminalRef: ref, data: "\u0003" }));
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
          const validated = TerminalServerFrameSchema.safeParse(parsed);
          if (!validated.success) {
            return;
          }
          const msg = validated.data;
          if ("terminalRef" in msg && msg.terminalRef && (
            msg.terminalRef.workspaceId !== ref.workspaceId || msg.terminalRef.tabId !== ref.tabId
          )) {
            return;
          }
          if ("revision" in msg) {
            if (msg.revision < lastRevision) return;
            lastRevision = msg.revision;
          }
          if (msg.type === "attached") {
            everAttached = true;
            reconnectAttempt = 0;
            markOpen();
            startHeartbeat();
            if (reconnecting) {
              reconnecting = false;
              if (attachOptions.showReconnectStatus === true) {
                writeError("\r\nConnection restored.\r\n");
              }
              if (reconnectNoticeVisible && attachOptions.showReconnectStatus === true) {
                writeOutput(SHELL_ATTACH_RECONNECT_NOTICE_CLEAR);
              }
              reconnectNoticeVisible = false;
            }
            schedulePostAttachResizeFrames();
          } else if (msg.type === "output" && typeof msg.data === "string") {
            noteRemoteActivity();
            inputFilter.noteRemoteOutput();
            if (writeRemoteOutput(msg.data) && Number.isSafeInteger(msg.seq) && (msg.seq as number) >= 0) {
              lastSeq = Math.max(lastSeq ?? -1, msg.seq as number);
            }
          } else if (msg.type === "snapshot" && typeof msg.ansi === "string") {
            noteRemoteActivity();
            writeRemoteOutput("\u001b[2J\u001b[H" + msg.ansi);
            if (Number.isSafeInteger(msg.seq) && (msg.seq as number) >= 0) lastSeq = msg.seq as number;
          } else if (msg.type === "pong") {
            noteRemoteActivity();
          } else if (msg.type === "error" || msg.type === "safe-error") {
            const requestedCode = msg.type === "error" ? msg.code : msg.error.code;
            const code = SAFE_SHELL_SERVER_ERROR_CODES.has(requestedCode)
              ? requestedCode
              : "attach_failed";
            if (everAttached && code === "attach_failed") {
              currentWs?.close();
              return;
            }
            settle(() => reject(Object.assign(new Error("Request failed"), { code })));
          } else if (msg.type === "exit") {
            const exitCode = typeof msg.exitCode === "number" ? msg.exitCode : null;
            settle(() => resolve({ detached: false, exitCode }));
          }
        };
        const onClose = () => {
          const shouldReconnect = everAttached;
          cleanupSocket();
          if (!shouldReconnect) {
            settle(() => reject(Object.assign(new Error("Request failed"), { code: "attach_failed" })));
            return;
          }
          if (localOutputBackpressured) {
            return;
          }
          scheduleReconnect();
        };
        const onError = (err: unknown) => {
          if (everAttached) {
            currentWs?.close();
            return;
          }
          writeError("Shell attach failed\n");
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
        output.on?.("error", onLocalStreamError);
        errorOutput.on?.("error", onLocalStreamError);
        input.on?.("data", onInput);
        connect();
      });
    },
  };
}
