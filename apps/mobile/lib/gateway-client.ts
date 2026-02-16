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

type ClientMessage =
  | { type: "message"; text: string; sessionId?: string }
  | { type: "switch_session"; sessionId: string }
  | { type: "approval_response"; id: string; approved: boolean };

type MessageHandler = (msg: ServerMessage) => void;
type StateHandler = (state: ConnectionState) => void;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private baseUrl: string;
  private token: string | undefined;
  private state: ConnectionState = "disconnected";
  private messageHandlers = new Set<MessageHandler>();
  private stateHandlers = new Set<StateHandler>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;

  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
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

    const wsUrl = this.token
      ? `${this.wsUrl}?token=${encodeURIComponent(this.token)}`
      : this.wsUrl;

    this.ws = new WebSocket(wsUrl);

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

    this.ws.onclose = () => {
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

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  sendMessage(text: string, sessionId?: string): void {
    this.send({ type: "message", text, sessionId });
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
      this.connect();
    }, delay);
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    return headers;
  }

  async healthCheck(): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    try {
      const res = await fetch(`${this.httpUrl}/health`, {
        headers: this.authHeaders(),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = await res.json();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
    }
  }

  async getTasks(status?: string): Promise<unknown[]> {
    const url = status
      ? `${this.httpUrl}/api/tasks?status=${encodeURIComponent(status)}`
      : `${this.httpUrl}/api/tasks`;
    const res = await fetch(url, { headers: this.authHeaders() });
    return res.json();
  }

  async createTask(input: string, type = "todo"): Promise<unknown> {
    const res = await fetch(`${this.httpUrl}/api/tasks`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ input, type }),
    });
    return res.json();
  }

  async getCron(): Promise<unknown[]> {
    const res = await fetch(`${this.httpUrl}/api/cron`, {
      headers: this.authHeaders(),
    });
    return res.json();
  }

  async getChannelStatus(): Promise<unknown> {
    const res = await fetch(`${this.httpUrl}/api/channels/status`, {
      headers: this.authHeaders(),
    });
    return res.json();
  }

  async getSystemInfo(): Promise<unknown> {
    const res = await fetch(`${this.httpUrl}/api/system/info`, {
      headers: this.authHeaders(),
    });
    return res.json();
  }

  async getConversations(): Promise<unknown[]> {
    const res = await fetch(`${this.httpUrl}/api/conversations`, {
      headers: this.authHeaders(),
    });
    return res.json();
  }

  async getProfile(): Promise<string | null> {
    const res = await fetch(`${this.httpUrl}/api/profile`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) return null;
    return res.text();
  }

  async getAiProfile(): Promise<string | null> {
    const res = await fetch(`${this.httpUrl}/api/ai-profile`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) return null;
    return res.text();
  }

  async getIdentity(): Promise<unknown> {
    const res = await fetch(`${this.httpUrl}/api/identity`, {
      headers: this.authHeaders(),
    });
    return res.json();
  }

  async registerPushToken(token: string, platform: string): Promise<void> {
    await fetch(`${this.httpUrl}/api/push/register`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ token, platform }),
    });
  }
}
