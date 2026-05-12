import { encodeAppSlugPath } from "@/lib/app-slugs";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export type ServerMessage =
  | { type: "kernel:init"; sessionId: string }
  | { type: "kernel:text"; text: string }
  | { type: "kernel:tool_start"; tool: string }
  | { type: "kernel:tool_end" }
  | { type: "kernel:result"; data: unknown }
  | { type: "kernel:error"; message: string }
  | { type: "file:change"; path: string; event: string }
  | { type: "task:created"; task: { id: string; type: string; status: string; input: string } }
  | { type: "task:updated"; taskId: string; status: string }
  | { type: "session:switched"; sessionId: string }
  | { type: "approval:request"; id: string; toolName: string; args: unknown; timeout: number };

export interface MatrixAppEntry {
  name: string;
  description?: string;
  icon?: string;
  category?: string;
  author?: string;
  version?: string;
  slug?: string;
  runtime?: "static" | "vite" | "node";
  runtimeState?: {
    status?: string;
    [key: string]: unknown;
  };
  launchUrl?: string;
  file: string;
  path: string;
}

export interface MatrixAppManifestResponse {
  manifest?: {
    name?: string;
    description?: string;
    icon?: string;
    category?: string;
    version?: string;
    runtime?: string;
    runtimeVersion?: string;
    [key: string]: unknown;
  };
  runtimeState?: {
    status?: string;
    [key: string]: unknown;
  };
  distributionStatus?: {
    status?: string;
    [key: string]: unknown;
  };
}

type ClientMessage =
  | { type: "message"; text: string; sessionId?: string }
  | { type: "switch_session"; sessionId: string }
  | { type: "approval_response"; id: string; approved: boolean };

type MessageHandler = (msg: ServerMessage) => void;
type StateHandler = (state: ConnectionState) => void;
type TokenProvider = () => Promise<string | null>;
type TokenSource = string | TokenProvider;
type ReactNativeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> },
) => WebSocket;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private baseUrl: string;
  private token: string | undefined;
  private tokenProvider: TokenProvider | undefined;
  private wsToken: string | undefined;
  private wsTokenExpiresAt = 0;
  private state: ConnectionState = "disconnected";
  private messageHandlers = new Set<MessageHandler>();
  private stateHandlers = new Set<StateHandler>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;

  constructor(baseUrl: string, token?: TokenSource, wsToken?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    if (typeof token === "function") {
      this.tokenProvider = token;
    } else {
      this.token = token;
    }
    this.wsToken = wsToken;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get httpUrl(): string {
    return this.baseUrl.replace(/^ws/, "http");
  }

  get wsUrl(): string {
    const url = this.baseUrl.replace(/^http/, "ws");
    return `${url}/ws`;
  }

  setWebSocketToken(token: string | null, expiresAt?: number): void {
    const previous = this.wsToken;
    this.wsToken = token ?? undefined;
    if (!token) {
      this.wsTokenExpiresAt = 0;
      return;
    }
    if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
      this.wsTokenExpiresAt = expiresAt;
      return;
    }
    if (previous !== token && !this.wsTokenExpiresAt) {
      this.wsTokenExpiresAt = Date.now() + 240_000;
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStateChange(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  connect(): void {
    if (this.state === "connected" || this.state === "connecting") return;

    this.shouldReconnect = true;
    this.setState("connecting");

    const upgradeToken = this.wsToken;
    const wsUrl = upgradeToken
      ? `${this.wsUrl}?token=${encodeURIComponent(upgradeToken)}`
      : this.wsUrl;

    const WebSocketWithOptions = WebSocket as unknown as ReactNativeWebSocketConstructor;
    this.ws = new WebSocketWithOptions(
      wsUrl,
      [],
      this.token
        ? { headers: { Authorization: `Bearer ${this.token}` } }
        : undefined,
    );

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setState("connected");
    };

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data) as ServerMessage;
        for (const handler of this.messageHandlers) {
          handler(msg);
        }
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = (evt) => {
      const closeEvent = evt as CloseEvent;
      console.warn("[mobile] websocket closed", closeEvent.code, closeEvent.reason || "");
      this.ws = null;
      this.setState("disconnected");
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.setState("error");
      this.ws?.close();
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setState("disconnected");
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  sendMessage(text: string, sessionId?: string): boolean {
    return this.send({ type: "message", text, sessionId });
  }

  switchSession(sessionId: string): void {
    this.send({ type: "switch_session", sessionId });
  }

  respondToApproval(id: string, approved: boolean): void {
    this.send({ type: "approval_response", id, approved });
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.refreshWebSocketTokenForReconnect()
        .catch((err: unknown) => {
          console.warn("[mobile] websocket token refresh before reconnect failed", err instanceof Error ? err.message : String(err));
        })
        .finally(() => this.connect());
    }, delay);
  }

  private async refreshAuthToken(): Promise<string | undefined> {
    if (!this.tokenProvider) return this.token;
    try {
      const nextToken = await this.tokenProvider();
      this.token = nextToken ?? undefined;
    } catch (err: unknown) {
      console.warn("[mobile] Clerk session token refresh failed", err instanceof Error ? err.message : String(err));
      this.token = undefined;
    }
    return this.token;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.refreshAuthToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
  }

  async webViewHeaders(): Promise<Record<string, string> | undefined> {
    const token = await this.refreshAuthToken();
    if (!token) return undefined;
    return {
      Authorization: `Bearer ${token}`,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    try {
      const res = await fetch(`${this.httpUrl}/health`, {
        headers: await this.authHeaders(),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = await res.json();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
    }
  }

  async getWsToken(): Promise<string | null> {
    try {
      const res = await fetch(`${this.httpUrl}/api/auth/ws-token`, {
        headers: await this.authHeaders(),
      });
      if (!res.ok) {
        const body = await res.text().catch((err: unknown) => {
          console.warn("[mobile] failed to read /api/auth/ws-token error body", err instanceof Error ? err.message : String(err));
          return "";
        });
        console.warn("[mobile] /api/auth/ws-token failed", res.status, body.slice(0, 160));
        return null;
      }
      const data = (await res.json()) as { token?: unknown; expiresAt?: unknown };
      if (typeof data.token !== "string") {
        console.warn("[mobile] /api/auth/ws-token returned no token");
        return null;
      }
      this.setWebSocketToken(data.token, typeof data.expiresAt === "number" ? data.expiresAt : undefined);
      return data.token;
    } catch (err: unknown) {
      console.warn("[mobile] /api/auth/ws-token network error", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  private async refreshWebSocketTokenForReconnect(): Promise<void> {
    if (!this.token && !this.tokenProvider) return;
    if (!this.wsToken || !this.wsTokenExpiresAt || Date.now() + 30_000 >= this.wsTokenExpiresAt) {
      if (this.wsTokenExpiresAt && Date.now() + 30_000 >= this.wsTokenExpiresAt) {
        this.setWebSocketToken(null);
      }
      await this.getWsToken();
    }
  }

  async getTasks(status?: string): Promise<unknown[]> {
    const url = status
      ? `${this.httpUrl}/api/tasks?status=${encodeURIComponent(status)}`
      : `${this.httpUrl}/api/tasks`;
    const res = await fetch(url, { headers: await this.authHeaders() });
    return res.json();
  }

  async createTask(input: string, type = "todo"): Promise<unknown> {
    const res = await fetch(`${this.httpUrl}/api/tasks`, {
      method: "POST",
      headers: await this.authHeaders(),
      body: JSON.stringify({ input, type }),
    });
    return res.json();
  }

  async updateTask(id: string, updates: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.httpUrl}/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: await this.authHeaders(),
      body: JSON.stringify(updates),
    });
    return res.json();
  }

  async deleteTask(id: string): Promise<void> {
    await fetch(`${this.httpUrl}/api/tasks/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: await this.authHeaders(),
    });
  }

  async getCron(): Promise<unknown[]> {
    const res = await fetch(`${this.httpUrl}/api/cron`, {
      headers: await this.authHeaders(),
    });
    return res.json();
  }

  async getChannelStatus(): Promise<unknown> {
    const res = await fetch(`${this.httpUrl}/api/channels/status`, {
      headers: await this.authHeaders(),
    });
    return res.json();
  }

  async getSystemInfo(): Promise<unknown> {
    const res = await fetch(`${this.httpUrl}/api/system/info`, {
      headers: await this.authHeaders(),
    });
    return res.json();
  }

  async getMessages(sessionId?: string, before?: number, limit = 20): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (sessionId) params.set("sessionId", sessionId);
    if (before) params.set("before", String(before));
    params.set("limit", String(limit));
    const res = await fetch(`${this.httpUrl}/api/messages?${params}`, {
      headers: await this.authHeaders(),
    });
    if (!res.ok) return [];
    return res.json();
  }

  async getConversations(): Promise<unknown[]> {
    const res = await fetch(`${this.httpUrl}/api/conversations`, {
      headers: await this.authHeaders(),
    });
    return res.json();
  }

  async getApps(): Promise<MatrixAppEntry[]> {
    try {
      const res = await fetch(`${this.httpUrl}/api/apps`, {
        headers: await this.authHeaders(),
      });
      if (!res.ok) {
        const body = await res.text().catch((err: unknown) => {
          console.warn("[mobile] failed to read /api/apps error body", err instanceof Error ? err.message : String(err));
          return "";
        });
        console.warn("[mobile] /api/apps failed", res.status, body.slice(0, 160));
        return [];
      }
      return res.json();
    } catch (err: unknown) {
      console.warn("[mobile] /api/apps unavailable", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  async getAppManifest(slug: string): Promise<MatrixAppManifestResponse | null> {
    try {
      const res = await fetch(`${this.httpUrl}/api/apps/${encodeAppSlugPath(slug)}/manifest`, {
        headers: await this.authHeaders(),
      });
      if (!res.ok) return null;
      return res.json();
    } catch (err: unknown) {
      console.warn("[mobile] /api/apps/:slug/manifest unavailable", slug, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async createAppSessionToken(slug: string): Promise<{ launchUrl: string; expiresAt: number } | null> {
    try {
      const res = await fetch(`${this.httpUrl}/api/apps/${encodeAppSlugPath(slug)}/session-token`, {
        method: "POST",
        headers: await this.authHeaders(),
        body: "{}",
      });
      if (!res.ok) {
        const body = await res.text().catch((err: unknown) => {
          console.warn(
            "[mobile] failed to read /api/apps/:slug/session-token error body",
            err instanceof Error ? err.message : String(err),
          );
          return "";
        });
        console.warn("[mobile] /api/apps/:slug/session-token failed", slug, res.status, body.slice(0, 160));
        return null;
      }
      const data = (await res.json()) as { launchUrl?: unknown; expiresAt?: unknown };
      if (typeof data.launchUrl !== "string" || typeof data.expiresAt !== "number") {
        console.warn("[mobile] /api/apps/:slug/session-token returned invalid payload", slug);
        return null;
      }
      return { launchUrl: data.launchUrl, expiresAt: data.expiresAt };
    } catch (err: unknown) {
      console.warn(
        "[mobile] /api/apps/:slug/session-token network error",
        slug,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  async getProfile(): Promise<string | null> {
    const res = await fetch(`${this.httpUrl}/api/profile`, {
      headers: await this.authHeaders(),
    });
    if (!res.ok) return null;
    return res.text();
  }

  async getAiProfile(): Promise<string | null> {
    const res = await fetch(`${this.httpUrl}/api/ai-profile`, {
      headers: await this.authHeaders(),
    });
    if (!res.ok) return null;
    return res.text();
  }

  async getIdentity(): Promise<unknown> {
    const res = await fetch(`${this.httpUrl}/api/identity`, {
      headers: await this.authHeaders(),
    });
    return res.json();
  }

  async registerPushToken(token: string, platform: string): Promise<void> {
    await fetch(`${this.httpUrl}/api/push/register`, {
      method: "POST",
      headers: await this.authHeaders(),
      body: JSON.stringify({ token, platform }),
    });
  }
}
