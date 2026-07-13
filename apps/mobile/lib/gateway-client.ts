import { encodeAppSlugPath } from "@/lib/app-slugs";
import {
  isSafeShellSessionName,
  parseShellSessions,
  type MobileTerminalSession,
} from "@/lib/terminal-state";
import { logMobileCodingAgentWarning } from "@/lib/coding-agent-diagnostics";
import {
  AgentThreadEventSchema,
  AgentThreadSnapshotSchema,
  ApprovalDecisionRequestSchema,
  ApprovalIdSchema,
  CodingAgentNotificationPreferencesSchema,
  CodingAgentNotificationPreferencesUpdateSchema,
  CodingAgentProjectCreateRequestSchema,
  CodingAgentProjectCreateResponseSchema,
  CursorSchema,
  FileBrowseRequestSchema,
  FileBrowseResponseSchema,
  FileReadRequestSchema,
  FileReadResponseSchema,
  FileSearchRequestSchema,
  FileSearchResponseSchema,
  FileWriteRequestSchema,
  FileWriteResponseSchema,
  RequestIdSchema,
  ReviewSnapshotSchema,
  ReviewSummarySchema,
  RuntimeSummarySchema,
  SafeClientErrorSchema,
  SourceControlCreatePullRequestRequestSchema,
  SourceControlCreatePullRequestResponseSchema,
  SourceControlPrepareCommitRequestSchema,
  SourceControlPrepareCommitResponseSchema,
  ThreadIdSchema,
  UserInputAnswerRequestSchema,
  type CreateAgentThreadRequest,
  type AgentThreadEvent,
  type CodingAgentNotificationPreferences,
  type CodingAgentNotificationPreferencesUpdate,
  type CodingAgentProjectCreateRequest,
  type CodingAgentProjectCreateResponse,
  type FileBrowseRequest,
  type FileBrowseResponse,
  type FileReadRequest,
  type FileReadResponse,
  type FileSearchRequest,
  type FileSearchResponse,
  type FileWriteRequest,
  type FileWriteResponse,
  type ReviewSnapshot,
  type RuntimeSummary,
  type SourceControlCreatePullRequestRequest,
  type SourceControlCreatePullRequestResponse,
  type SourceControlPrepareCommitRequest,
  type SourceControlPrepareCommitResponse,
  boundedListSchema,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

function randomShellSuffix(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID().replace(/-/g, "").slice(0, 7);
  }
  return Math.random().toString(36).slice(2, 9).padEnd(7, "0").slice(0, 7);
}

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** Canonical hosted platform origin; `/vm/<handle>` computer routes share it. */
const HOSTED_PLATFORM_ORIGIN = "https://app.matrix-os.com";

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

export type ProjectCreateResult =
  | ({ ok: true } & CodingAgentProjectCreateResponse)
  | { ok: false; error: "Project could not be created. Try again." };

const CodingAgentNotificationPreferencesRouteResponseSchema = z.object({
  preferences: CodingAgentNotificationPreferencesSchema,
}).strict();

export type CodingAgentNotificationPreferencesResult =
  | { ok: true; preferences: CodingAgentNotificationPreferences }
  | { ok: false; error: "Notification settings unavailable" };

export type CodingAgentNotificationPreferencesUpdateResult =
  | { ok: true; preferences: CodingAgentNotificationPreferences }
  | { ok: false; error: "Notification settings could not be saved. Try again." };

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

export type CodingAgentFileBrowseResult =
  | { ok: true; browse: FileBrowseResponse }
  | { ok: false; error: "File list unavailable" };

export type CodingAgentFileSearchResult =
  | { ok: true; search: FileSearchResponse }
  | { ok: false; error: "File search unavailable" };

export type CodingAgentFileSaveResult =
  | { ok: true; file: FileWriteResponse }
  | { ok: false; error: "File could not be saved. Refresh and try again." };

export type CodingAgentSourceCommitResult =
  | { ok: true; commit: SourceControlPrepareCommitResponse }
  | { ok: false; error: "Source commit could not be prepared. Refresh and try again." };

export type CodingAgentSourcePullRequestResult =
  | { ok: true; pullRequest: SourceControlCreatePullRequestResponse }
  | { ok: false; error: "Pull request could not be created. Refresh and try again." };

export type CodingAgentThreadStreamStatus = "connecting" | "open" | "closed" | "error";

export interface CodingAgentThreadEventSubscription {
  detach(): void;
}

export interface CodingAgentThreadEventSubscriptionOptions {
  threadId: string;
  cursor?: string;
  onEvent: (event: AgentThreadEvent) => void;
  onStatus?: (status: CodingAgentThreadStreamStatus) => void;
  onError?: (error: "Thread stream unavailable") => void;
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
export const DEFAULT_GATEWAY_FETCH_TIMEOUT_MS = 10_000;
const SAFE_REVIEW_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SECURE_TOKEN_TRANSPORT_ERROR =
  "Matrix OS Cloud requires HTTPS/WSS.";
const CLEARTEXT_HOST_ERROR =
  "Self-hosted gateways with saved credentials require HTTPS/WSS unless they are local.";

const ThreadStreamServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("thread.stream.attached"),
    threadId: ThreadIdSchema,
  }).strict(),
  z.object({
    type: z.literal("thread.event"),
    event: AgentThreadEventSchema,
  }).strict(),
  z.object({
    type: z.literal("thread.replay.end"),
    nextCursor: CursorSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal("thread.stream.error"),
    error: SafeClientErrorSchema,
  }).strict(),
  z.object({
    type: z.literal("thread.stream.closing"),
    reason: z.string().trim().min(1).max(64),
  }).strict(),
  z.object({ type: z.literal("pong") }).strict(),
]);

const WS_OPEN = 1;

function logCodingAgentStatusWarning(scope: string, status: number): void {
  logMobileCodingAgentWarning(scope, `status ${status}`);
}

function logCodingAgentParseWarning(scope: string): void {
  logMobileCodingAgentWarning(scope, "invalid payload");
}

function logCodingAgentCatchWarning(scope: string, err: unknown): void {
  const reason = err instanceof Error && err.name === "AbortError" ? "aborted" : err;
  logMobileCodingAgentWarning(scope, reason);
}

function logGatewayStatusWarning(scope: string, status: number): void {
  logMobileCodingAgentWarning(scope, `status ${status}`);
}

function logGatewayCatchWarning(scope: string, err: unknown): void {
  const reason = err instanceof Error && err.name === "AbortError" ? "aborted" : err;
  logMobileCodingAgentWarning(scope, reason);
}

function logGatewayWarning(scope: string, detail: unknown): void {
  logMobileCodingAgentWarning(scope, detail);
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private baseUrl: string;
  /** Routing query (without `?`) carried by the base URL, e.g. `runtime=<slot>`. */
  private baseQuery: string;
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
    // A routed computer URL may carry a routing query (e.g. `/vm/<handle>?runtime=<slot>`).
    // Split it off so path joins stay valid, and re-apply it to every request URL.
    const trimmed = baseUrl.replace(/\/+$/, "");
    const queryIndex = trimmed.indexOf("?");
    this.baseUrl = queryIndex === -1 ? trimmed : trimmed.slice(0, queryIndex).replace(/\/+$/, "");
    this.baseQuery = queryIndex === -1 ? "" : trimmed.slice(queryIndex + 1);
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

  /** Re-applies the base routing query (e.g. `runtime=<slot>`) to a joined URL. */
  private withBaseQuery(url: string): string {
    if (!this.baseQuery) return url;
    return `${url}${url.includes("?") ? "&" : "?"}${this.baseQuery}`;
  }

  /**
   * Hosted computers route HTTP through `/vm/<handle>` path prefixes, but the
   * platform terminates WebSocket upgrades (and issues ws tokens) on the
   * canonical origin, resolving the machine from identity + `runtime` query.
   * Returns the platform origin for hosted routed bases, null otherwise.
   */
  private get hostedPlatformOrigin(): string | null {
    return this.baseUrl.startsWith(`${HOSTED_PLATFORM_ORIGIN}/vm/`) ? HOSTED_PLATFORM_ORIGIN : null;
  }

  private get wsBaseUrl(): string {
    return (this.hostedPlatformOrigin ?? this.baseUrl).replace(/^http/, "ws");
  }

  get wsUrl(): string {
    return this.withBaseQuery(`${this.wsBaseUrl}/ws`);
  }

  get terminalWsUrl(): string {
    // Shell-sessions endpoint: attach by session name passed in the query.
    return this.withBaseQuery(`${this.wsBaseUrl}/ws/terminal/session`);
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
      ? appendQuery(this.wsUrl, `token=${encodeURIComponent(upgradeToken)}`)
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
      logGatewayWarning("websocket closed", `code ${closeEvent.code}${closeEvent.reason ? ` ${closeEvent.reason}` : ""}`);
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
          logGatewayCatchWarning("websocket token refresh before reconnect failed", err);
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
      logGatewayCatchWarning("Clerk session token refresh failed", err);
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
    return this.fetchAbsolute(this.withBaseQuery(`${this.httpUrl}${path}`), init);
  }

  /** Platform-owned routes (e.g. ws-token) live on the canonical origin, not the `/vm/` prefix. */
  private async fetchPlatform(path: string, init: RequestInit = {}): Promise<Response> {
    const base = this.hostedPlatformOrigin ?? this.httpUrl;
    return this.fetchAbsolute(this.withBaseQuery(`${base}${path}`), init);
  }

  private async fetchAbsolute(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
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
    const wsUrl = query ? appendQuery(this.terminalWsUrl, query) : this.terminalWsUrl;
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

  async subscribeCodingAgentThreadEvents(
    options: CodingAgentThreadEventSubscriptionOptions,
  ): Promise<CodingAgentThreadEventSubscription | null> {
    const parsedThreadId = ThreadIdSchema.safeParse(options.threadId);
    const parsedCursor = options.cursor ? CursorSchema.safeParse(options.cursor) : null;
    if (!parsedThreadId.success || (parsedCursor && !parsedCursor.success)) {
      options.onError?.("Thread stream unavailable");
      return null;
    }
    const token = await this.getWsToken();
    if (token) this.setWebSocketToken(token);
    const params = new URLSearchParams();
    if (token) params.set("token", token);
    if (parsedCursor?.success) params.set("cursor", parsedCursor.data);
    const query = params.toString();
    const wsUrl = this.withBaseQuery(
      `${this.wsBaseUrl}/ws/coding-agents/thread/${encodeURIComponent(parsedThreadId.data)}${query ? `?${query}` : ""}`,
    );
    const WebSocketWithOptions = WebSocket as unknown as ReactNativeWebSocketConstructor;
    const authorization = formatAuthorizationHeader(this.token);
    const ws = new WebSocketWithOptions(
      wsUrl,
      [],
      authorization
        ? { headers: { Authorization: authorization } }
        : undefined,
    );
    let detached = false;

    ws.onopen = () => {
      options.onStatus?.("open");
    };

    ws.onmessage = (event) => {
      if (detached) return;
      if (typeof event.data !== "string") return;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(event.data);
      } catch {
        logMobileCodingAgentWarning("coding-agent thread stream sent invalid JSON", "invalid json");
        return;
      }
      const frame = ThreadStreamServerFrameSchema.safeParse(parsedJson);
      if (!frame.success) {
        logCodingAgentParseWarning("coding-agent thread stream sent invalid frame");
        return;
      }
      if (frame.data.type === "thread.event") {
        options.onEvent(frame.data.event);
        return;
      }
      if (frame.data.type === "thread.stream.error") {
        options.onError?.("Thread stream unavailable");
      }
    };

    ws.onerror = () => {
      options.onStatus?.("error");
      options.onError?.("Thread stream unavailable");
    };

    ws.onclose = () => {
      options.onStatus?.("closed");
    };

    options.onStatus?.("connecting");
    return {
      detach() {
        detached = true;
        if (ws.readyState === WS_OPEN) {
          try {
            ws.send(JSON.stringify({ type: "detach" }));
          } catch (err: unknown) {
            logCodingAgentCatchWarning("coding-agent thread stream detach failed", err);
          }
        }
        try {
          ws.close();
        } catch (err: unknown) {
          logCodingAgentCatchWarning("coding-agent thread stream close failed", err);
        }
      },
    };
  }

  async healthCheck(): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    try {
      const res = await this.fetchGateway("/health");
      if (!res.ok) return { ok: false, error: "Gateway unavailable" };
      const data = await res.json();
      return { ok: true, data };
    } catch {
      logGatewayWarning("gateway health check unavailable", "unavailable");
      return { ok: false, error: "Gateway unavailable" };
    }
  }

  async getWsToken(): Promise<string | null> {
    try {
      const res = await this.fetchPlatform("/api/auth/ws-token");
      if (!res.ok) {
        logGatewayStatusWarning("/api/auth/ws-token unavailable", res.status);
        return null;
      }
      const data = (await res.json()) as { token?: unknown; expiresAt?: unknown };
      if (data.token == null) return null;
      if (typeof data.token !== "string") {
        logGatewayWarning("/api/auth/ws-token returned invalid token", "invalid payload");
        return null;
      }
      this.setWebSocketToken(data.token, typeof data.expiresAt === "number" ? data.expiresAt : undefined);
      return data.token;
    } catch {
      logGatewayWarning("/api/auth/ws-token network error", "unavailable");
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
    // `/api/messages` is owned by the messaging bridge on newer gateways and
    // no longer returns a chat-history array; treat any non-array body as
    // "no older history" instead of crashing history pagination.
    const body: unknown = await res.json();
    return Array.isArray(body) ? body : [];
  }

  async getConversations(): Promise<unknown[]> {
    const res = await this.fetchGateway("/api/conversations");
    return res.json();
  }

  async getApps(): Promise<MatrixAppEntry[]> {
    try {
      const res = await this.fetchGateway("/api/apps");
      if (!res.ok) {
        await res.text().catch((err: unknown) => {
          logGatewayCatchWarning("failed to read /api/apps error body", err);
          return "";
        });
        logGatewayStatusWarning("/api/apps unavailable", res.status);
        return [];
      }
      return res.json();
    } catch (err: unknown) {
      logGatewayCatchWarning("/api/apps unavailable", err);
      return [];
    }
  }

  async getTerminalSessions(): Promise<MobileTerminalSession[]> {
    try {
      const res = await this.fetchGateway("/api/terminal/sessions");
      if (!res.ok) {
        await res.text().catch((err: unknown) => {
          logGatewayCatchWarning("failed to read /api/terminal/sessions error body", err);
          return "";
        });
        logGatewayStatusWarning("/api/terminal/sessions unavailable", res.status);
        return [];
      }
      const body = (await res.json()) as { sessions?: unknown };
      return parseShellSessions(body?.sessions ?? body);
    } catch (err: unknown) {
      logGatewayCatchWarning("/api/terminal/sessions unavailable", err);
      return [];
    }
  }

  async getCodingAgentRuntimeSummary(): Promise<CodingAgentRuntimeSummaryResult> {
    try {
      const res = await this.fetchGateway("/api/coding-agents/summary");
      if (!res.ok) {
        logCodingAgentStatusWarning("/api/coding-agents/summary unavailable", res.status);
        return { ok: false, error: "Runtime summary unavailable" };
      }
      const body = await res.json();
      const parsed = RuntimeSummarySchema.safeParse(body);
      if (!parsed.success) {
        logCodingAgentParseWarning("/api/coding-agents/summary returned invalid payload");
        return { ok: false, error: "Runtime summary unavailable" };
      }
      return { ok: true, summary: parsed.data };
    } catch (err: unknown) {
      logCodingAgentCatchWarning("/api/coding-agents/summary unavailable", err);
      return { ok: false, error: "Runtime summary unavailable" };
    }
  }

  async createProject(request: CodingAgentProjectCreateRequest): Promise<ProjectCreateResult> {
    try {
      const parsedRequest = CodingAgentProjectCreateRequestSchema.safeParse(request);
      if (!parsedRequest.success) {
        return { ok: false, error: "Project could not be created. Try again." };
      }
      const res = await this.fetchGateway("/api/coding-agents/projects", {
        method: "POST",
        body: JSON.stringify(parsedRequest.data),
      });
      if (!res.ok) {
        logGatewayStatusWarning("/api/coding-agents/projects unavailable", res.status);
        return { ok: false, error: "Project could not be created. Try again." };
      }
      const body = await res.json();
      const parsed = CodingAgentProjectCreateResponseSchema.safeParse(body);
      if (!parsed.success) {
        logGatewayWarning("/api/coding-agents/projects returned invalid payload", "invalid payload");
        return { ok: false, error: "Project could not be created. Try again." };
      }
      return { ok: true, ...parsed.data };
    } catch (err: unknown) {
      logGatewayCatchWarning("/api/coding-agents/projects unavailable", err);
      return { ok: false, error: "Project could not be created. Try again." };
    }
  }

  async getCodingAgentNotificationPreferences(): Promise<CodingAgentNotificationPreferencesResult> {
    try {
      const res = await this.fetchGateway("/api/coding-agents/notification-preferences");
      if (!res.ok) {
        logCodingAgentStatusWarning("/api/coding-agents/notification-preferences unavailable", res.status);
        return { ok: false, error: "Notification settings unavailable" };
      }
      const body = await res.json();
      const parsed = CodingAgentNotificationPreferencesRouteResponseSchema.safeParse(body);
      if (!parsed.success) {
        logCodingAgentParseWarning("/api/coding-agents/notification-preferences returned invalid payload");
        return { ok: false, error: "Notification settings unavailable" };
      }
      return { ok: true, preferences: parsed.data.preferences };
    } catch (err: unknown) {
      logCodingAgentCatchWarning("/api/coding-agents/notification-preferences unavailable", err);
      return { ok: false, error: "Notification settings unavailable" };
    }
  }

  async updateCodingAgentNotificationPreferences(
    request: CodingAgentNotificationPreferencesUpdate,
  ): Promise<CodingAgentNotificationPreferencesUpdateResult> {
    try {
      const parsedRequest = CodingAgentNotificationPreferencesUpdateSchema.safeParse(request);
      if (!parsedRequest.success) {
        return { ok: false, error: "Notification settings could not be saved. Try again." };
      }
      const res = await this.fetchGateway("/api/coding-agents/notification-preferences", {
        method: "PUT",
        body: JSON.stringify(parsedRequest.data),
      });
      if (!res.ok) {
        logCodingAgentStatusWarning("/api/coding-agents/notification-preferences update unavailable", res.status);
        return { ok: false, error: "Notification settings could not be saved. Try again." };
      }
      const body = await res.json();
      const parsed = CodingAgentNotificationPreferencesRouteResponseSchema.safeParse(body);
      if (!parsed.success) {
        logCodingAgentParseWarning("/api/coding-agents/notification-preferences update returned invalid payload");
        return { ok: false, error: "Notification settings could not be saved. Try again." };
      }
      return { ok: true, preferences: parsed.data.preferences };
    } catch (err: unknown) {
      logCodingAgentCatchWarning("/api/coding-agents/notification-preferences update unavailable", err);
      return { ok: false, error: "Notification settings could not be saved. Try again." };
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
        logCodingAgentStatusWarning("/api/coding-agents/threads unavailable", res.status);
        return { ok: false, error: "Agent run could not be started. Try again." };
      }
      const body = await res.json();
      const parsed = AgentThreadSnapshotSchema.safeParse(body);
      if (!parsed.success) {
        logCodingAgentParseWarning("/api/coding-agents/threads returned invalid payload");
        return { ok: false, error: "Agent run could not be started. Try again." };
      }
      return { ok: true, snapshot: parsed.data };
    } catch (err: unknown) {
      logCodingAgentCatchWarning("/api/coding-agents/threads unavailable", err);
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
        logCodingAgentStatusWarning("/api/coding-agents/threads/:threadId unavailable", res.status);
        return { ok: false, error: "Thread state unavailable" };
      }
      const body = await res.json();
      const parsed = AgentThreadSnapshotSchema.safeParse(body);
      if (!parsed.success) {
        logCodingAgentParseWarning("/api/coding-agents/threads/:threadId returned invalid payload");
        return { ok: false, error: "Thread state unavailable" };
      }
      return { ok: true, snapshot: parsed.data };
    } catch (err: unknown) {
      logCodingAgentCatchWarning("/api/coding-agents/threads/:threadId unavailable", err);
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
        logCodingAgentStatusWarning("/api/coding-agents/threads/:threadId/approvals/:approvalId/decision unavailable", res.status);
        return { ok: false, error: "Approval could not be sent. Try again." };
      }
      const body = await res.json();
      const parsed = AgentThreadSnapshotSchema.safeParse(body);
      if (!parsed.success) {
        logCodingAgentParseWarning("/api/coding-agents/threads/:threadId/approvals/:approvalId/decision returned invalid payload");
        return { ok: false, error: "Approval could not be sent. Try again." };
      }
      return { ok: true, snapshot: parsed.data };
    } catch (err: unknown) {
      logCodingAgentCatchWarning("/api/coding-agents/threads/:threadId/approvals/:approvalId/decision unavailable", err);
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
        logCodingAgentStatusWarning("/api/coding-agents/threads/:threadId/inputs/:inputRequestId/answer unavailable", res.status);
        return { ok: false, error: "Input could not be sent. Try again." };
      }
      const body = await res.json();
      const parsed = AgentThreadSnapshotSchema.safeParse(body);
      if (!parsed.success) {
        logCodingAgentParseWarning("/api/coding-agents/threads/:threadId/inputs/:inputRequestId/answer returned invalid payload");
        return { ok: false, error: "Input could not be sent. Try again." };
      }
      return { ok: true, snapshot: parsed.data };
    } catch (err: unknown) {
      logCodingAgentCatchWarning("/api/coding-agents/threads/:threadId/inputs/:inputRequestId/answer unavailable", err);
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
        logCodingAgentStatusWarning("/api/coding-agents/reviews unavailable", res.status);
        return { ok: false, error: "Review state unavailable" };
      }
      const body = await res.json();
      const parsed = CodingAgentReviewListSchema.safeParse(body);
      if (!parsed.success) {
        logCodingAgentParseWarning("/api/coding-agents/reviews returned invalid payload");
        return { ok: false, error: "Review state unavailable" };
      }
      return { ok: true, reviews: parsed.data };
    } catch (err: unknown) {
      logCodingAgentCatchWarning("/api/coding-agents/reviews unavailable", err);
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
        logCodingAgentStatusWarning("/api/coding-agents/reviews/:reviewId unavailable", res.status);
        return { ok: false, error: "Review details unavailable" };
      }
      const body = await res.json();
      const parsed = ReviewSnapshotSchema.safeParse(body);
      if (!parsed.success) {
        logCodingAgentParseWarning("/api/coding-agents/reviews/:reviewId returned invalid payload");
        return { ok: false, error: "Review details unavailable" };
      }
      return { ok: true, snapshot: parsed.data };
    } catch (err: unknown) {
      logCodingAgentCatchWarning("/api/coding-agents/reviews/:reviewId unavailable", err);
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
      const query = new URLSearchParams({ projectId: parsedRequest.data.projectId });
      if (parsedRequest.data.worktreeId) {
        query.set("worktreeId", parsedRequest.data.worktreeId);
      }
      query.set("path", parsedRequest.data.path);
      const res = await this.fetchGateway(`/api/coding-agents/files/read?${query.toString()}`);
      if (!res.ok) {
        logCodingAgentStatusWarning("/api/coding-agents/files/read unavailable", res.status);
        return { ok: false, error: "File content unavailable" };
      }
      const body = await res.json();
      const parsed = FileReadResponseSchema.safeParse(body);
      if (!parsed.success) {
        logCodingAgentParseWarning("/api/coding-agents/files/read returned invalid payload");
        return { ok: false, error: "File content unavailable" };
      }
      return { ok: true, file: parsed.data };
    } catch (err: unknown) {
      logCodingAgentCatchWarning("/api/coding-agents/files/read unavailable", err);
      return { ok: false, error: "File content unavailable" };
    }
  }

  async browseCodingAgentFiles(
    request: FileBrowseRequest,
  ): Promise<CodingAgentFileBrowseResult> {
    try {
      const parsedRequest = FileBrowseRequestSchema.safeParse(request);
      if (!parsedRequest.success) {
        return { ok: false, error: "File list unavailable" };
      }
      const query = new URLSearchParams({ projectId: parsedRequest.data.projectId });
      if (parsedRequest.data.worktreeId) {
        query.set("worktreeId", parsedRequest.data.worktreeId);
      }
      if (parsedRequest.data.path) {
        query.set("path", parsedRequest.data.path);
      }
      query.set("limit", String(parsedRequest.data.limit));
      const res = await this.fetchGateway(`/api/coding-agents/files/browse?${query.toString()}`);
      if (!res.ok) {
        logCodingAgentStatusWarning("/api/coding-agents/files/browse unavailable", res.status);
        return { ok: false, error: "File list unavailable" };
      }
      const body = await res.json();
      const parsed = FileBrowseResponseSchema.safeParse(body);
      if (!parsed.success) {
        logCodingAgentParseWarning("/api/coding-agents/files/browse returned invalid payload");
        return { ok: false, error: "File list unavailable" };
      }
      return { ok: true, browse: parsed.data };
    } catch (err: unknown) {
      logCodingAgentCatchWarning("/api/coding-agents/files/browse unavailable", err);
      return { ok: false, error: "File list unavailable" };
    }
  }

  async searchCodingAgentFiles(
    request: FileSearchRequest,
  ): Promise<CodingAgentFileSearchResult> {
    try {
      const parsedRequest = FileSearchRequestSchema.safeParse(request);
      if (!parsedRequest.success) {
        return { ok: false, error: "File search unavailable" };
      }
      const query = new URLSearchParams({ projectId: parsedRequest.data.projectId });
      if (parsedRequest.data.worktreeId) {
        query.set("worktreeId", parsedRequest.data.worktreeId);
      }
      if (parsedRequest.data.path) {
        query.set("path", parsedRequest.data.path);
      }
      query.set("query", parsedRequest.data.query);
      query.set("limit", String(parsedRequest.data.limit));
      const res = await this.fetchGateway(`/api/coding-agents/files/search?${query.toString()}`);
      if (!res.ok) {
        logCodingAgentStatusWarning("/api/coding-agents/files/search unavailable", res.status);
        return { ok: false, error: "File search unavailable" };
      }
      const body = await res.json();
      const parsed = FileSearchResponseSchema.safeParse(body);
      if (!parsed.success) {
        logCodingAgentParseWarning("/api/coding-agents/files/search returned invalid payload");
        return { ok: false, error: "File search unavailable" };
      }
      return { ok: true, search: parsed.data };
    } catch (err: unknown) {
      logCodingAgentCatchWarning("/api/coding-agents/files/search unavailable", err);
      return { ok: false, error: "File search unavailable" };
    }
  }

  async saveCodingAgentFileContent(
    request: FileWriteRequest,
  ): Promise<CodingAgentFileSaveResult> {
    try {
      const parsedRequest = FileWriteRequestSchema.safeParse(request);
      if (!parsedRequest.success) {
        return { ok: false, error: "File could not be saved. Refresh and try again." };
      }
      const res = await this.fetchGateway("/api/coding-agents/files/write", {
        method: "POST",
        body: JSON.stringify(parsedRequest.data),
      });
      if (!res.ok) {
        logCodingAgentStatusWarning("/api/coding-agents/files/write unavailable", res.status);
        return { ok: false, error: "File could not be saved. Refresh and try again." };
      }
      const body = await res.json();
      const parsed = FileWriteResponseSchema.safeParse(body);
      if (!parsed.success) {
        logCodingAgentParseWarning("/api/coding-agents/files/write returned invalid payload");
        return { ok: false, error: "File could not be saved. Refresh and try again." };
      }
      return { ok: true, file: parsed.data };
    } catch (err: unknown) {
      logCodingAgentCatchWarning("/api/coding-agents/files/write unavailable", err);
      return { ok: false, error: "File could not be saved. Refresh and try again." };
    }
  }

  async prepareCodingAgentSourceCommit(
    request: SourceControlPrepareCommitRequest,
  ): Promise<CodingAgentSourceCommitResult> {
    try {
      const parsedRequest = SourceControlPrepareCommitRequestSchema.safeParse(request);
      if (!parsedRequest.success) {
        return { ok: false, error: "Source commit could not be prepared. Refresh and try again." };
      }
      const res = await this.fetchGateway("/api/coding-agents/source-control/prepare-commit", {
        method: "POST",
        body: JSON.stringify(parsedRequest.data),
      });
      if (!res.ok) {
        logCodingAgentStatusWarning("/api/coding-agents/source-control/prepare-commit unavailable", res.status);
        return { ok: false, error: "Source commit could not be prepared. Refresh and try again." };
      }
      const body = await res.json();
      const parsed = SourceControlPrepareCommitResponseSchema.safeParse(body);
      if (!parsed.success) {
        logCodingAgentParseWarning("/api/coding-agents/source-control/prepare-commit returned invalid payload");
        return { ok: false, error: "Source commit could not be prepared. Refresh and try again." };
      }
      return { ok: true, commit: parsed.data };
    } catch (err: unknown) {
      logCodingAgentCatchWarning("/api/coding-agents/source-control/prepare-commit unavailable", err);
      return { ok: false, error: "Source commit could not be prepared. Refresh and try again." };
    }
  }

  async createCodingAgentSourcePullRequest(
    request: SourceControlCreatePullRequestRequest,
  ): Promise<CodingAgentSourcePullRequestResult> {
    try {
      const parsedRequest = SourceControlCreatePullRequestRequestSchema.safeParse(request);
      if (!parsedRequest.success) {
        return { ok: false, error: "Pull request could not be created. Refresh and try again." };
      }
      const res = await this.fetchGateway("/api/coding-agents/source-control/pull-requests", {
        method: "POST",
        body: JSON.stringify(parsedRequest.data),
      });
      if (!res.ok) {
        logCodingAgentStatusWarning("/api/coding-agents/source-control/pull-requests unavailable", res.status);
        return { ok: false, error: "Pull request could not be created. Refresh and try again." };
      }
      const body = await res.json();
      const parsed = SourceControlCreatePullRequestResponseSchema.safeParse(body);
      if (!parsed.success) {
        logCodingAgentParseWarning("/api/coding-agents/source-control/pull-requests returned invalid payload");
        return { ok: false, error: "Pull request could not be created. Refresh and try again." };
      }
      return { ok: true, pullRequest: parsed.data };
    } catch (err: unknown) {
      logCodingAgentCatchWarning("/api/coding-agents/source-control/pull-requests unavailable", err);
      return { ok: false, error: "Pull request could not be created. Refresh and try again." };
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
        await res.text().catch((err: unknown) => {
          logGatewayCatchWarning("failed to read terminal session create error body", err);
          return "";
        });
        logGatewayStatusWarning("terminal session create failed", res.status);
        return null;
      }
      const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
      const created = typeof body?.name === "string" ? body.name : name;
      return isSafeShellSessionName(created) ? created : null;
    } catch {
      logGatewayWarning("terminal session create unavailable", "unavailable");
      return null;
    }
  }

  /**
   * Create a shell session that runs a provider setup command and return its
   * zellij name for terminal handoff, or null on failure. The command is sent to
   * the gateway inside the bounded foreground session and is never stored in
   * shell state or rendered in the UI (CLAUDE.md: provider setup stays
   * terminal-backed and command-hidden).
   */
  async createProviderSetupSession(command: string): Promise<string | null> {
    if (typeof command !== "string" || command.length === 0) return null;
    const name = `matrix-setup-${randomShellSuffix()}`;
    try {
      const res = await this.fetchGateway("/api/terminal/sessions", {
        method: "POST",
        body: JSON.stringify({ name, cwd: "projects", cmd: command }),
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        await res.text().catch((err: unknown) => {
          logGatewayCatchWarning("failed to read provider setup session create error body", err);
          return "";
        });
        logGatewayStatusWarning("provider setup session create failed", res.status);
        return null;
      }
      const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
      const created = typeof body?.name === "string" ? body.name : name;
      return isSafeShellSessionName(created) ? created : null;
    } catch {
      logGatewayWarning("provider setup session create unavailable", "unavailable");
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
      logGatewayStatusWarning("terminal session delete unavailable", res.status);
      return false;
    } catch {
      logGatewayWarning("terminal session delete unavailable", "unavailable");
      return false;
    }
  }

  async getAppManifest(slug: string): Promise<MatrixAppManifestResponse | null> {
    try {
      const res = await this.fetchGateway(`/api/apps/${encodeAppSlugPath(slug)}/manifest`);
      if (!res.ok) return null;
      return res.json();
    } catch {
      logGatewayWarning("/api/apps/:slug/manifest unavailable", `slug ${slug}`);
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
        await res.text().catch((err: unknown) => {
          logGatewayCatchWarning("failed to read /api/apps/:slug/session-token error body", err);
          return "";
        });
        logGatewayWarning("/api/apps/:slug/session-token unavailable", `slug ${slug} status ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { launchUrl?: unknown; expiresAt?: unknown };
      if (typeof data.launchUrl !== "string" || typeof data.expiresAt !== "number") {
        logGatewayWarning("/api/apps/:slug/session-token returned invalid payload", `slug ${slug}`);
        return null;
      }
      return { launchUrl: data.launchUrl, expiresAt: data.expiresAt };
    } catch {
      logGatewayWarning("/api/apps/:slug/session-token network error", `slug ${slug}`);
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

  /**
   * Authenticated GET against an owner file-browser API path (`/api/files/*`,
   * `/api/projects`). The caller builds the full path + query; auth headers, the
   * base routing query, and the default timeout are applied here. Parsing lives
   * in `lib/matrix-files.ts` so this only exposes a bounded read surface.
   */
  async fetchOwnerFilesApi(path: string): Promise<Response> {
    return this.fetchGateway(path);
  }

  /**
   * Authenticated GET of a raw owner home file (`/files/<rel-path>`). Path
   * segments are URL-encoded while directory separators are preserved.
   */
  async fetchOwnerHomeFile(relPath: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchGateway(`/files/${encodeHomeFilePath(relPath)}`, init);
  }

  /**
   * Absolute, base-query-aware URL for a raw owner home file. Used for
   * authenticated `<Image>` loads that carry the Authorization header via
   * `getAuthorizationHeader()` and cannot go through the fetch wrapper.
   */
  homeFileUrl(relPath: string): string {
    return this.withBaseQuery(`${this.httpUrl}/files/${encodeHomeFilePath(relPath)}`);
  }
}

/** Encodes each path segment while preserving `/` separators. */
export function encodeHomeFilePath(relPath: string): string {
  return relPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function appendQuery(url: string, query: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

export function createTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
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
