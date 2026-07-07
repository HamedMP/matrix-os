import { encodeAppSlugPath } from "@/lib/app-slugs";
import {
  isSafeShellSessionName,
  parseShellSessions,
  type MobileTerminalSession,
} from "@/lib/terminal-state";
import {
  AgentThreadSnapshotSchema,
  ApprovalDecisionRequestSchema,
  ApprovalIdSchema,
  CursorSchema,
  FileReadRequestSchema,
  FileReadResponseSchema,
  RequestIdSchema,
  ReviewSnapshotSchema,
  ReviewSummarySchema,
  RuntimeSummarySchema,
  ThreadIdSchema,
  UserInputAnswerRequestSchema,
  type CreateAgentThreadRequest,
  type FileReadRequest,
  type FileReadResponse,
  type ReviewSnapshot,
  type RuntimeSummary,
  boundedListSchema,
} from "@matrix-os/contracts";
import type { z } from "zod/v4";

function randomShellSuffix(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID().replace(/-/g, "").slice(0, 7);
  }
  return Math.random().toString(36).slice(2, 9).padEnd(7, "0").slice(0, 7);
}

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

export type CodingAgentRuntimeSummaryResult =
  | { ok: true; summary: RuntimeSummary }
  | { ok: false; error: "Runtime summary unavailable" };

export type CodingAgentThreadCreateResult =
  | { ok: true; snapshot: z.infer<typeof AgentThreadSnapshotSchema> }
  | { ok: false; error: "Agent run could not be started. Try again." };

export type CodingAgentThreadSnapshotResult =
  | { ok: true; snapshot: z.infer<typeof AgentThreadSnapshotSchema> }
  | { ok: false; error: "Thread state unavailable" };

export type CodingAgentApprovalDecisionResult =
  | { ok: true; snapshot: z.infer<typeof AgentThreadSnapshotSchema> }
  | { ok: false; error: "Approval could not be sent. Try again." };

export type CodingAgentInputAnswerResult =
  | { ok: true; snapshot: z.infer<typeof AgentThreadSnapshotSchema> }
  | { ok: false; error: "Input could not be sent. Try again." };

const CodingAgentReviewListSchema = boundedListSchema(ReviewSummarySchema, 50);

export type CodingAgentReviewsResult =
  | { ok: true; reviews: z.infer<typeof CodingAgentReviewListSchema> }
  | { ok: false; error: "Review state unavailable" };

export type CodingAgentReviewSnapshotResult =
  | { ok: true; snapshot: ReviewSnapshot }
  | { ok: false; error: "Review details unavailable" };

export type CodingAgentFileContentResult =
  | { ok: true; file: FileReadResponse }
  | { ok: false; error: "File content unavailable" };

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
export const DEFAULT_GATEWAY_FETCH_TIMEOUT_MS = 10_000;
const SAFE_REVIEW_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SECURE_TOKEN_TRANSPORT_ERROR =
  "Matrix OS Cloud requires HTTPS/WSS.";
const CLEARTEXT_HOST_ERROR =
  "Self-hosted gateways with saved credentials require HTTPS/WSS unless they are local.";

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
    if (token || wsToken) {
      assertSecureTokenTransport(this.baseUrl);
    }
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

  /**
   * Current auth credential for asset GETs the fetch wrapper can't reach,
   * e.g. <Image> loads of authenticated `/icons/*` URLs. Refreshes via the
   * token provider so callers get a non-expired token.
   */
  async getAuthToken(): Promise<string | undefined> {
    return this.refreshAuthToken();
  }

  async getAuthorizationHeader(): Promise<string | undefined> {
    const token = await this.refreshAuthToken();
    return formatAuthorizationHeader(token);
  }

  get wsUrl(): string {
    const url = this.baseUrl.replace(/^http/, "ws");
    return `${url}/ws`;
  }

  get terminalWsUrl(): string {
    const url = this.baseUrl.replace(/^http/, "ws");
    // Shell-sessions endpoint: attach by session name passed in the query.
    return `${url}/ws/terminal/session`;
  }

  setWebSocketToken(token: string | null, expiresAt?: number): void {
    const previous = this.wsToken;
    if (token) {
      assertSecureTokenTransport(this.baseUrl);
    }
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
    const authorization = formatAuthorizationHeader(this.token);
    const wsUrl = upgradeToken
      ? `${this.wsUrl}?token=${encodeURIComponent(upgradeToken)}`
      : this.wsUrl;

    const WebSocketWithOptions = WebSocket as unknown as ReactNativeWebSocketConstructor;
    this.ws = new WebSocketWithOptions(
      wsUrl,
      [],
      authorization
        ? { headers: { Authorization: authorization } }
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
    const authorization = formatAuthorizationHeader(token);
    if (authorization) {
      headers["Authorization"] = authorization;
    }
    return headers;
  }

  private async fetchGateway(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.httpUrl}${path}`, {
      ...init,
      headers: {
        ...(await this.authHeaders()),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: init.signal ?? createTimeoutSignal(DEFAULT_GATEWAY_FETCH_TIMEOUT_MS),
    });
  }

  async webViewHeaders(): Promise<Record<string, string> | undefined> {
    const token = await this.refreshAuthToken();
    const authorization = formatAuthorizationHeader(token);
    if (!authorization) return undefined;
    return {
      Authorization: authorization,
    };
  }

  openTerminalWebSocket(token?: string | null, sessionName?: string, fromSeq?: number): WebSocket {
    if (token || this.token) {
      assertSecureTokenTransport(this.baseUrl);
    }
    const params = new URLSearchParams();
    if (sessionName) params.set("session", sessionName);
    if (typeof fromSeq === "number" && Number.isFinite(fromSeq)) params.set("fromSeq", String(fromSeq));
    if (token) params.set("token", token);
    const query = params.toString();
    const wsUrl = query ? `${this.terminalWsUrl}?${query}` : this.terminalWsUrl;
    const WebSocketWithOptions = WebSocket as unknown as ReactNativeWebSocketConstructor;
    const authorization = formatAuthorizationHeader(this.token);
    return new WebSocketWithOptions(
      wsUrl,
      [],
      authorization
        ? { headers: { Authorization: authorization } }
        : undefined,
    );
  }

  async healthCheck(): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    try {
      const res = await this.fetchGateway("/health");
      if (!res.ok) return { ok: false, error: "Gateway unavailable" };
      const data = await res.json();
      return { ok: true, data };
    } catch {
      console.warn("[mobile] gateway health check unavailable");
      return { ok: false, error: "Gateway unavailable" };
    }
  }

  async getWsToken(): Promise<string | null> {
    try {
      const res = await this.fetchGateway("/api/auth/ws-token");
      if (!res.ok) {
        console.warn("[mobile] /api/auth/ws-token unavailable", res.status);
        return null;
      }
      const data = (await res.json()) as { token?: unknown; expiresAt?: unknown };
      if (data.token == null) return null;
      if (typeof data.token !== "string") {
        console.warn("[mobile] /api/auth/ws-token returned invalid token");
        return null;
      }
      this.setWebSocketToken(data.token, typeof data.expiresAt === "number" ? data.expiresAt : undefined);
      return data.token;
    } catch {
      console.warn("[mobile] /api/auth/ws-token network error");
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
      ? `/api/tasks?status=${encodeURIComponent(status)}`
      : "/api/tasks";
    const res = await this.fetchGateway(url);
    return res.json();
  }

  async createTask(input: string, type = "todo"): Promise<unknown> {
    const res = await this.fetchGateway("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input, type }),
    });
    return res.json();
  }

  async updateTask(id: string, updates: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchGateway(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
    return res.json();
  }

  async deleteTask(id: string): Promise<void> {
    await this.fetchGateway(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async getCron(): Promise<unknown[]> {
    const res = await this.fetchGateway("/api/cron");
    return res.json();
  }

  async getChannelStatus(): Promise<unknown> {
    const res = await this.fetchGateway("/api/channels/status");
    return res.json();
  }

  async getSystemInfo(): Promise<unknown> {
    const res = await this.fetchGateway("/api/system/info");
    return res.json();
  }

  async getMessages(sessionId?: string, before?: number, limit = 20): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (sessionId) params.set("sessionId", sessionId);
    if (before) params.set("before", String(before));
    params.set("limit", String(limit));
    const res = await this.fetchGateway(`/api/messages?${params}`);
    if (!res.ok) return [];
    return res.json();
  }

  async getConversations(): Promise<unknown[]> {
    const res = await this.fetchGateway("/api/conversations");
    return res.json();
  }

  async getApps(): Promise<MatrixAppEntry[]> {
    try {
      const res = await this.fetchGateway("/api/apps");
      if (!res.ok) {
        const body = await res.text().catch((err: unknown) => {
          console.warn("[mobile] failed to read /api/apps error body", err instanceof Error ? err.message : String(err));
          return "";
        });
        console.warn("[mobile] /api/apps unavailable", res.status, body.slice(0, 160));
        return [];
      }
      return res.json();
    } catch (err: unknown) {
      console.warn("[mobile] /api/apps unavailable", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  async getTerminalSessions(): Promise<MobileTerminalSession[]> {
    try {
      const res = await this.fetchGateway("/api/terminal/sessions");
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn("[mobile] /api/terminal/sessions unavailable", res.status, body.slice(0, 160));
        return [];
      }
      const body = (await res.json()) as { sessions?: unknown };
      return parseShellSessions(body?.sessions ?? body);
    } catch (err: unknown) {
      console.warn("[mobile] /api/terminal/sessions unavailable", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  async getCodingAgentRuntimeSummary(): Promise<CodingAgentRuntimeSummaryResult> {
    try {
      const res = await this.fetchGateway("/api/coding-agents/summary");
      if (!res.ok) {
        console.warn("[mobile] /api/coding-agents/summary unavailable", res.status);
        return { ok: false, error: "Runtime summary unavailable" };
      }
      const body = await res.json();
      const parsed = RuntimeSummarySchema.safeParse(body);
      if (!parsed.success) {
        console.warn("[mobile] /api/coding-agents/summary returned invalid payload");
        return { ok: false, error: "Runtime summary unavailable" };
      }
      return { ok: true, summary: parsed.data };
    } catch {
      console.warn("[mobile] /api/coding-agents/summary unavailable");
      return { ok: false, error: "Runtime summary unavailable" };
    }
  }

  async createCodingAgentThread(
    request: CreateAgentThreadRequest,
  ): Promise<CodingAgentThreadCreateResult> {
    try {
      const res = await this.fetchGateway("/api/coding-agents/threads", {
        method: "POST",
        body: JSON.stringify(request),
      });
      if (!res.ok) {
        console.warn("[mobile] /api/coding-agents/threads unavailable", res.status);
        return { ok: false, error: "Agent run could not be started. Try again." };
      }
      const body = await res.json();
      const parsed = AgentThreadSnapshotSchema.safeParse(body);
      if (!parsed.success) {
        console.warn("[mobile] /api/coding-agents/threads returned invalid payload");
        return { ok: false, error: "Agent run could not be started. Try again." };
      }
      return { ok: true, snapshot: parsed.data };
    } catch {
      console.warn("[mobile] /api/coding-agents/threads unavailable");
      return { ok: false, error: "Agent run could not be started. Try again." };
    }
  }

  async getCodingAgentThreadSnapshot(
    options: { threadId: string },
  ): Promise<CodingAgentThreadSnapshotResult> {
    try {
      const parsedThreadId = ThreadIdSchema.safeParse(options.threadId);
      if (!parsedThreadId.success) {
        return { ok: false, error: "Thread state unavailable" };
      }
      const res = await this.fetchGateway(`/api/coding-agents/threads/${encodeURIComponent(parsedThreadId.data)}`);
      if (!res.ok) {
        console.warn("[mobile] /api/coding-agents/threads/:threadId unavailable", res.status);
        return { ok: false, error: "Thread state unavailable" };
      }
      const body = await res.json();
      const parsed = AgentThreadSnapshotSchema.safeParse(body);
      if (!parsed.success) {
        console.warn("[mobile] /api/coding-agents/threads/:threadId returned invalid payload");
        return { ok: false, error: "Thread state unavailable" };
      }
      return { ok: true, snapshot: parsed.data };
    } catch {
      console.warn("[mobile] /api/coding-agents/threads/:threadId unavailable");
      return { ok: false, error: "Thread state unavailable" };
    }
  }

  async submitCodingAgentApprovalDecision(options: {
    threadId: string;
    approvalId: string;
    decision: unknown;
    correlationId: string;
    clientRequestId: string;
  }): Promise<CodingAgentApprovalDecisionResult> {
    try {
      const parsedThreadId = ThreadIdSchema.safeParse(options.threadId);
      const parsedApprovalId = ApprovalIdSchema.safeParse(options.approvalId);
      const parsedBody = ApprovalDecisionRequestSchema.safeParse({
        decision: options.decision,
        correlationId: options.correlationId,
        clientRequestId: options.clientRequestId,
      });
      if (!parsedThreadId.success || !parsedApprovalId.success || !parsedBody.success) {
        return { ok: false, error: "Approval could not be sent. Try again." };
      }
      const res = await this.fetchGateway(
        `/api/coding-agents/threads/${encodeURIComponent(parsedThreadId.data)}/approvals/${encodeURIComponent(parsedApprovalId.data)}/decision`,
        {
          method: "POST",
          body: JSON.stringify(parsedBody.data),
        },
      );
      if (!res.ok) {
        console.warn("[mobile] /api/coding-agents/threads/:threadId/approvals/:approvalId/decision unavailable", res.status);
        return { ok: false, error: "Approval could not be sent. Try again." };
      }
      const body = await res.json();
      const parsed = AgentThreadSnapshotSchema.safeParse(body);
      if (!parsed.success) {
        console.warn("[mobile] /api/coding-agents/threads/:threadId/approvals/:approvalId/decision returned invalid payload");
        return { ok: false, error: "Approval could not be sent. Try again." };
      }
      return { ok: true, snapshot: parsed.data };
    } catch {
      console.warn("[mobile] /api/coding-agents/threads/:threadId/approvals/:approvalId/decision unavailable");
      return { ok: false, error: "Approval could not be sent. Try again." };
    }
  }

  async submitCodingAgentInputAnswer(options: {
    threadId: string;
    inputRequestId: string;
    answer: string;
    correlationId: string;
    clientRequestId: string;
  }): Promise<CodingAgentInputAnswerResult> {
    try {
      const parsedThreadId = ThreadIdSchema.safeParse(options.threadId);
      const parsedInputRequestId = RequestIdSchema.safeParse(options.inputRequestId);
      const parsedBody = UserInputAnswerRequestSchema.safeParse({
        answer: options.answer,
        correlationId: options.correlationId,
        clientRequestId: options.clientRequestId,
      });
      if (!parsedThreadId.success || !parsedInputRequestId.success || !parsedBody.success) {
        return { ok: false, error: "Input could not be sent. Try again." };
      }
      const res = await this.fetchGateway(
        `/api/coding-agents/threads/${encodeURIComponent(parsedThreadId.data)}/inputs/${encodeURIComponent(parsedInputRequestId.data)}/answer`,
        {
          method: "POST",
          body: JSON.stringify(parsedBody.data),
        },
      );
      if (!res.ok) {
        console.warn("[mobile] /api/coding-agents/threads/:threadId/inputs/:inputRequestId/answer unavailable", res.status);
        return { ok: false, error: "Input could not be sent. Try again." };
      }
      const body = await res.json();
      const parsed = AgentThreadSnapshotSchema.safeParse(body);
      if (!parsed.success) {
        console.warn("[mobile] /api/coding-agents/threads/:threadId/inputs/:inputRequestId/answer returned invalid payload");
        return { ok: false, error: "Input could not be sent. Try again." };
      }
      return { ok: true, snapshot: parsed.data };
    } catch {
      console.warn("[mobile] /api/coding-agents/threads/:threadId/inputs/:inputRequestId/answer unavailable");
      return { ok: false, error: "Input could not be sent. Try again." };
    }
  }

  async getCodingAgentReviews(options: { cursor?: string } = {}): Promise<CodingAgentReviewsResult> {
    try {
      let path = "/api/coding-agents/reviews";
      if (options.cursor) {
        const parsedCursor = CursorSchema.safeParse(options.cursor);
        if (!parsedCursor.success) {
          return { ok: false, error: "Review state unavailable" };
        }
        path += `?${new URLSearchParams({ cursor: parsedCursor.data }).toString()}`;
      }
      const res = await this.fetchGateway(path);
      if (!res.ok) {
        console.warn("[mobile] /api/coding-agents/reviews unavailable", res.status);
        return { ok: false, error: "Review state unavailable" };
      }
      const body = await res.json();
      const parsed = CodingAgentReviewListSchema.safeParse(body);
      if (!parsed.success) {
        console.warn("[mobile] /api/coding-agents/reviews returned invalid payload");
        return { ok: false, error: "Review state unavailable" };
      }
      return { ok: true, reviews: parsed.data };
    } catch {
      console.warn("[mobile] /api/coding-agents/reviews unavailable");
      return { ok: false, error: "Review state unavailable" };
    }
  }

  async getCodingAgentReviewSnapshot(
    options: { reviewId: string },
  ): Promise<CodingAgentReviewSnapshotResult> {
    try {
      if (!SAFE_REVIEW_REFERENCE.test(options.reviewId) || options.reviewId.includes("..")) {
        return { ok: false, error: "Review details unavailable" };
      }
      const res = await this.fetchGateway(`/api/coding-agents/reviews/${encodeURIComponent(options.reviewId)}`);
      if (!res.ok) {
        console.warn("[mobile] /api/coding-agents/reviews/:reviewId unavailable", res.status);
        return { ok: false, error: "Review details unavailable" };
      }
      const body = await res.json();
      const parsed = ReviewSnapshotSchema.safeParse(body);
      if (!parsed.success) {
        console.warn("[mobile] /api/coding-agents/reviews/:reviewId returned invalid payload");
        return { ok: false, error: "Review details unavailable" };
      }
      return { ok: true, snapshot: parsed.data };
    } catch (err: unknown) {
      const reason = err instanceof Error && err.name === "AbortError" ? "aborted" : "unavailable";
      console.warn(`[mobile] /api/coding-agents/reviews/:reviewId ${reason}`);
      return { ok: false, error: "Review details unavailable" };
    }
  }

  async getCodingAgentFileContent(
    request: FileReadRequest,
  ): Promise<CodingAgentFileContentResult> {
    try {
      const parsedRequest = FileReadRequestSchema.safeParse(request);
      if (!parsedRequest.success) {
        return { ok: false, error: "File content unavailable" };
      }
      const query = new URLSearchParams({
        projectId: parsedRequest.data.projectId,
        worktreeId: parsedRequest.data.worktreeId,
        path: parsedRequest.data.path,
      });
      const res = await this.fetchGateway(`/api/coding-agents/files/read?${query.toString()}`);
      if (!res.ok) {
        console.warn("[mobile] /api/coding-agents/files/read unavailable", res.status);
        return { ok: false, error: "File content unavailable" };
      }
      const body = await res.json();
      const parsed = FileReadResponseSchema.safeParse(body);
      if (!parsed.success) {
        console.warn("[mobile] /api/coding-agents/files/read returned invalid payload");
        return { ok: false, error: "File content unavailable" };
      }
      return { ok: true, file: parsed.data };
    } catch (err: unknown) {
      const reason = err instanceof Error && err.name === "AbortError" ? "aborted" : "unavailable";
      console.warn(`[mobile] /api/coding-agents/files/read ${reason}`);
      return { ok: false, error: "File content unavailable" };
    }
  }

  /** Create a new shell session and return its zellij name, or null on failure. */
  async createTerminalSession(): Promise<string | null> {
    const name = `matrix-${randomShellSuffix()}`;
    try {
      const res = await this.fetchGateway("/api/terminal/sessions", {
        method: "POST",
        body: JSON.stringify({ name }),
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn("[mobile] terminal session create failed", res.status, body.slice(0, 160));
        return null;
      }
      const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
      const created = typeof body?.name === "string" ? body.name : name;
      return isSafeShellSessionName(created) ? created : null;
    } catch {
      console.warn("[mobile] terminal session create unavailable");
      return null;
    }
  }

  async deleteTerminalSession(name: string): Promise<boolean> {
    if (!isSafeShellSessionName(name)) return false;
    try {
      const res = await this.fetchGateway(
        `/api/terminal/sessions/${encodeURIComponent(name)}?force=1`,
        { method: "DELETE" },
      );
      if (res.ok || res.status === 404) return true;
      console.warn("[mobile] terminal session delete unavailable", res.status);
      return false;
    } catch {
      console.warn("[mobile] terminal session delete unavailable");
      return false;
    }
  }

  async getAppManifest(slug: string): Promise<MatrixAppManifestResponse | null> {
    try {
      const res = await this.fetchGateway(`/api/apps/${encodeAppSlugPath(slug)}/manifest`);
      if (!res.ok) return null;
      return res.json();
    } catch {
      console.warn("[mobile] /api/apps/:slug/manifest unavailable", slug);
      return null;
    }
  }

  async createAppSessionToken(slug: string): Promise<{ launchUrl: string; expiresAt: number } | null> {
    try {
      const res = await this.fetchGateway(`/api/apps/${encodeAppSlugPath(slug)}/session-token`, {
        method: "POST",
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
        console.warn("[mobile] /api/apps/:slug/session-token unavailable", slug, res.status, body.slice(0, 160));
        return null;
      }
      const data = (await res.json()) as { launchUrl?: unknown; expiresAt?: unknown };
      if (typeof data.launchUrl !== "string" || typeof data.expiresAt !== "number") {
        console.warn("[mobile] /api/apps/:slug/session-token returned invalid payload", slug);
        return null;
      }
      return { launchUrl: data.launchUrl, expiresAt: data.expiresAt };
    } catch {
      console.warn("[mobile] /api/apps/:slug/session-token network error", slug);
      return null;
    }
  }

  async getProfile(): Promise<string | null> {
    const res = await this.fetchGateway("/api/profile");
    if (!res.ok) return null;
    return res.text();
  }

  async getAiProfile(): Promise<string | null> {
    const res = await this.fetchGateway("/api/ai-profile");
    if (!res.ok) return null;
    return res.text();
  }

  async getIdentity(): Promise<unknown> {
    const res = await this.fetchGateway("/api/identity");
    return res.json();
  }

  async registerPushToken(token: string, platform: string): Promise<void> {
    await this.fetchGateway("/api/push/register", {
      method: "POST",
      body: JSON.stringify({ token, platform }),
    });
  }
}

function createTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
  const timeout = (AbortSignal as { timeout?: (milliseconds: number) => AbortSignal }).timeout;
  if (typeof timeout === "function") {
    return timeout(timeoutMs);
  }

  if (typeof AbortController === "undefined") {
    return undefined;
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

function formatAuthorizationHeader(token: string | undefined): string | undefined {
  if (!token) return undefined;
  if (/^(Basic|Bearer)\s+/i.test(token)) return token;
  return `Bearer ${token}`;
}

export function assertSecureTokenTransport(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Gateway URL is invalid.");
  }

  if (parsed.protocol === "https:" || parsed.protocol === "wss:") {
    return;
  }

  if (
    (parsed.protocol === "http:" || parsed.protocol === "ws:")
    && isCleartextSelfHostedHost(parsed.hostname)
  ) {
    return;
  }

  if (parsed.protocol === "http:" || parsed.protocol === "ws:") {
    throw new Error(isMatrixCloudHost(parsed.hostname) ? SECURE_TOKEN_TRANSPORT_ERROR : CLEARTEXT_HOST_ERROR);
  }

  throw new Error(SECURE_TOKEN_TRANSPORT_ERROR);
}

function isMatrixCloudHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return host === "app.matrix-os.com";
}

function isCleartextSelfHostedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return true;
  }

  const octets = host.split(".").map((part) => Number(part));
  if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    const [first = -1, second = -1] = octets;
    return first === 10 ||
      first === 127 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 169 && second === 254) ||
      (first === 192 && second === 168);
  }

  return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}
