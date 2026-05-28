export interface ShellClientOptions {
  gatewayUrl: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ShellClient {
  listSessions(): Promise<unknown[]>;
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
  createAttachUrl(name: string, options?: { fromSeq?: number; token?: string }): string;
  attachSession(name: string, options?: ShellAttachOptions): Promise<{ detached: boolean }>;
}

export interface ShellClientError extends Error {
  code: string;
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
  WebSocketImpl?: new (url: string, options?: { headers?: Record<string, string> }) => AttachWebSocket;
}

export const SHELL_ATTACH_MAX_QUEUED_BYTES = 65_536;
const LOCAL_TERMINAL_INPUT_RESET = "\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?1015l\u001b[?1004l";
const MAX_PENDING_MOUSE_SEQUENCE_CHARS = 128;
const STALE_MOUSE_FOCUS_GUARD_MS = 5_000;
const FOCUS_MOUSE_SUPPRESS_MS = 1_000;

type MaybeTtyStream = NodeJS.ReadStream & {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  setRawMode?: (enabled: boolean) => unknown;
  resume?: () => unknown;
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
  let pendingMouseSequence = "";
  let lastRemoteOutputAt = options.now?.() ?? Date.now();
  let suppressMouseUntil = 0;

  const now = () => options.now?.() ?? Date.now();
  const shouldForwardMouse = () => !options.dropMouse && focused && now() >= suppressMouseUntil;

  return {
    noteRemoteOutput() {
      lastRemoteOutputAt = now();
    },
    filter(chunk: string): string {
      const input = pendingMouseSequence + chunk;
      pendingMouseSequence = "";
      let output = "";
      for (let i = 0; i < input.length;) {
        if (input[i] !== "\u001b" || input[i + 1] !== "[") {
          output += input[i] ?? "";
          i += 1;
          continue;
        }

        const third = input[i + 2];
        if (third === undefined) {
          pendingMouseSequence = input.slice(i);
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

        if (third === "<") {
          let end = i + 3;
          while (end < input.length && input[end] !== "M" && input[end] !== "m") {
            end += 1;
          }
          if (end >= input.length) {
            pendingMouseSequence = input.slice(i, Math.min(input.length, i + MAX_PENDING_MOUSE_SEQUENCE_CHARS));
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
            pendingMouseSequence = input.slice(i, Math.min(input.length, i + MAX_PENDING_MOUSE_SEQUENCE_CHARS));
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
      pendingMouseSequence = "";
      suppressMouseUntil = 0;
    },
  };
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

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    if (init.body && !headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let payload: unknown = {};
    try {
      payload = await res.json();
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) {
        throw err;
      }
    }

    if (!res.ok) {
      const code =
        typeof payload === "object" &&
        payload !== null &&
        "error" in payload &&
        typeof (payload as { error?: { code?: unknown } }).error?.code === "string"
          ? (payload as { error: { code: string } }).error.code
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
    createAttachUrl,
    async attachSession(name, attachOptions = {}) {
      const WebSocketImpl =
        attachOptions.WebSocketImpl ??
        (await import("ws").then((mod) => mod.WebSocket as unknown as ShellAttachOptions["WebSocketImpl"]));
      if (!WebSocketImpl) {
        throw Object.assign(new Error("Request failed"), { code: "websocket_unavailable" });
      }

      const headers = options.token ? { Authorization: `Bearer ${options.token}` } : undefined;
      const ws = new WebSocketImpl(createAttachUrl(name, attachOptions), { headers });
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
      let pendingInput = "";

      return new Promise<{ detached: boolean }>((resolve, reject) => {
        let settled = false;
        let socketOpen = false;
        let rawModeEnabled = false;
        const queuedFrames: string[] = [];
        let queuedFrameBytes = 0;
        const timeout = setTimeout(() => {
          ws.close();
          settle(() => reject(Object.assign(new Error("Request failed"), { code: "attach_timeout" })));
        }, timeoutMs);
        timeout.unref?.();
        const cleanup = () => {
          clearTimeout(timeout);
          input.off?.("data", onInput);
          process.off("SIGWINCH", onResize);
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
          process.off("exit", onProcessExit);
          ws.off?.("open", onOpen);
          ws.off?.("message", onMessage);
          ws.off?.("close", onClose);
          ws.off?.("error", onError);
          pendingInput = "";
          inputFilter.reset();
          resetLocalInputModes();
          if (rawModeEnabled) {
            input.setRawMode?.(false);
            rawModeEnabled = false;
          }
        };
        const settle = (fn: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          fn();
        };
        const markOpen = () => {
          if (socketOpen) {
            return;
          }
          socketOpen = true;
          clearTimeout(timeout);
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
              settle(() => reject(Object.assign(new Error("Request failed"), {
                code: "attach_failed",
              })));
              ws.close();
              return;
            }
            queuedFrameBytes = nextQueuedBytes;
            queuedFrames.push(frame);
            return;
          }
          try {
            ws.send(frame);
          } catch (err: unknown) {
            errorOutput.write("Shell attach failed\n");
            settle(() => reject(Object.assign(new Error("Request failed"), {
              code: err instanceof Error ? "attach_failed" : "request_failed",
            })));
          }
        };
        const onInput = (chunk: Buffer | string) => {
          const rawData = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
          const data = inputFilter.filter(rawData);
          let outbound = "";
          for (const char of data) {
            pendingInput += char;
            if (pendingInput === detachSequence) {
              pendingInput = "";
              if (outbound.length > 0) {
                sendFrame(JSON.stringify({ type: "input", data: outbound }));
              }
              sendFrame(JSON.stringify({ type: "detach" }));
              ws.close();
              settle(() => resolve({ detached: true }));
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
            sendFrame(JSON.stringify({ type: "input", data: outbound }));
          }
        };
        const sendResizeFrame = () => {
          const size = terminalSize(input, output);
          if (!size) {
            return;
          }
          sendFrame(JSON.stringify({ type: "resize", ...size }));
        };
        const onResize = () => {
          sendResizeFrame();
        };
        const onSignal = () => {
          sendFrame(JSON.stringify({ type: "detach" }));
          ws.close();
          settle(() => resolve({ detached: true }));
        };
        const onProcessExit = () => {
          resetLocalInputModes();
          if (rawModeEnabled) {
            input.setRawMode?.(false);
            rawModeEnabled = false;
          }
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
            markOpen();
          } else if (msg.type === "output" && typeof msg.data === "string") {
            inputFilter.noteRemoteOutput();
            output.write(msg.data);
          } else if (msg.type === "error") {
            const code = typeof msg.code === "string" ? msg.code : "attach_failed";
            settle(() => reject(Object.assign(new Error("Request failed"), { code })));
          } else if (msg.type === "exit") {
            settle(() => resolve({ detached: false }));
          }
        };
        const onClose = () => {
          settle(() => resolve({ detached: true }));
        };
        const onError = (err: unknown) => {
          errorOutput.write("Shell attach failed\n");
          settle(() => reject(Object.assign(new Error("Request failed"), {
            code: err instanceof Error ? "attach_failed" : "request_failed",
          })));
        };

        ws.on("open", onOpen);
        ws.on("message", onMessage);
        ws.on("close", onClose);
        ws.on("error", onError);
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
      });
    },
  };
}
