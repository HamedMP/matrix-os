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
  createAttachUrl(name: string, options?: { fromSeq?: number }): string;
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
  WebSocketImpl?: new (url: string, options?: { headers?: Record<string, string> }) => AttachWebSocket;
}

export function createShellClient(options: ShellClientOptions): ShellClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.gatewayUrl.replace(/\/+$/, "");

  function createAttachUrl(name: string, attachOptions: { fromSeq?: number } = {}): string {
    const url = new URL(`${base}/ws/terminal`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("session", name);
    if (typeof attachOptions.fromSeq === "number") {
      url.searchParams.set("fromSeq", String(attachOptions.fromSeq));
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
      const payload = await request("/api/sessions");
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
      return (await request("/api/sessions", {
        method: "POST",
        body: JSON.stringify(input),
      })) as Record<string, unknown>;
    },
    async deleteSession(name, options = {}) {
      const suffix = options.force ? "?force=1" : "";
      await request(`/api/sessions/${encodeURIComponent(name)}${suffix}`, {
        method: "DELETE",
      });
    },
    async listTabs(name) {
      const payload = await request(`/api/sessions/${encodeURIComponent(name)}/tabs`);
      return typeof payload === "object" && payload !== null && "tabs" in payload && Array.isArray((payload as { tabs: unknown }).tabs)
        ? (payload as { tabs: unknown[] }).tabs
        : [];
    },
    async createTab(name, input) {
      return (await request(`/api/sessions/${encodeURIComponent(name)}/tabs`, {
        method: "POST",
        body: JSON.stringify(input),
      })) as Record<string, unknown>;
    },
    async switchTab(name, tab) {
      return (await request(`/api/sessions/${encodeURIComponent(name)}/tabs/${tab}/go`, {
        method: "POST",
      })) as Record<string, unknown>;
    },
    async closeTab(name, tab) {
      return (await request(`/api/sessions/${encodeURIComponent(name)}/tabs/${tab}`, {
        method: "DELETE",
      })) as Record<string, unknown>;
    },
    async splitPane(name, input) {
      return (await request(`/api/sessions/${encodeURIComponent(name)}/panes`, {
        method: "POST",
        body: JSON.stringify(input),
      })) as Record<string, unknown>;
    },
    async closePane(name, pane) {
      return (await request(`/api/sessions/${encodeURIComponent(name)}/panes/${encodeURIComponent(pane)}`, {
        method: "DELETE",
      })) as Record<string, unknown>;
    },
    async listLayouts() {
      const payload = await request("/api/layouts");
      return typeof payload === "object" && payload !== null && "layouts" in payload && Array.isArray((payload as { layouts: unknown }).layouts)
        ? (payload as { layouts: unknown[] }).layouts
        : [];
    },
    async showLayout(name) {
      return (await request(`/api/layouts/${encodeURIComponent(name)}`)) as Record<string, unknown>;
    },
    async saveLayout(name, kdl) {
      return (await request(`/api/layouts/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify({ kdl }),
      })) as Record<string, unknown>;
    },
    async deleteLayout(name) {
      return (await request(`/api/layouts/${encodeURIComponent(name)}`, {
        method: "DELETE",
      })) as Record<string, unknown>;
    },
    async applyLayout(session, layout) {
      return (await request(`/api/sessions/${encodeURIComponent(session)}/layouts/${encodeURIComponent(layout)}/apply`, {
        method: "POST",
      })) as Record<string, unknown>;
    },
    async dumpLayout(session) {
      return (await request(`/api/sessions/${encodeURIComponent(session)}/layout/dump`)) as Record<string, unknown>;
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
      const input = attachOptions.input ?? process.stdin;
      const detachSequence = attachOptions.detachSequence ?? "\u001c\u001c";
      let pendingInput = "";

      return new Promise<{ detached: boolean }>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          ws.close();
          settle(() => reject(Object.assign(new Error("Request failed"), { code: "attach_timeout" })));
        }, timeoutMs);
        timeout.unref?.();
        const cleanup = () => {
          clearTimeout(timeout);
          input.off?.("data", onInput);
          ws.off?.("message", onMessage);
          ws.off?.("close", onClose);
          ws.off?.("error", onError);
        };
        const settle = (fn: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          fn();
        };
        const onInput = (chunk: Buffer | string) => {
          const data = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
          pendingInput = `${pendingInput}${data}`.slice(-detachSequence.length);
          if (pendingInput === detachSequence) {
            ws.send(JSON.stringify({ type: "detach" }));
            ws.close();
            settle(() => resolve({ detached: true }));
            return;
          }
          ws.send(JSON.stringify({ type: "input", data }));
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
          if (msg.type === "output" && typeof msg.data === "string") {
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

        ws.on("message", onMessage);
        ws.on("close", onClose);
        ws.on("error", onError);
        input.on?.("data", onInput);
      });
    },
  };
}
