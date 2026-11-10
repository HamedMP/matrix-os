import { Hono, type Context } from "hono";
import {
  APP_CHAT_OPERATION_SCOPES,
  AppChatErrorSchema,
  AppChatEventsResultSchema,
  CanonicalChatStreamEventSchema,
  type AppChatReply,
  type AppChatRequest,
} from "@matrix-os/contracts";
import { createCanonicalChatRoutes, type CanonicalChatRouteService } from "../chat/routes.js";
import { createChatProviderRoutes } from "../chat/provider-routes.js";
import type { ChatProviderCatalogService } from "../chat/provider-catalog.js";
import type { ChatOutboxEvent, ChatOwner } from "../chat/records.js";
import type { ChatOutboxSink } from "../chat/outbox-delivery.js";
import type { RequestPrincipal } from "../request-principal.js";
import { appChatScopes, readAppCapabilityAccess } from "./policy.js";

const MAX_CHAT_REQUESTS_PER_MINUTE = 600;
const MAX_CHAT_IN_FLIGHT = 16;
const MAX_EVENT_WAITERS = 8;
const EVENT_PAGE = 100;
/** Apps always read the newest wire formats; older versions exist only for shipped native clients. */
const CHAT_WIRE_VERSIONS = "messageVersion=2&inputVersion=1&commandPreviewVersion=1&assistantTextVersion=1&readStateVersion=1&importSourceVersion=1&fundingVersion=1";
const PROVIDER_QUERY = "includeConnectionLabels=true&includeConnectionState=true&includeFundingState=true&includeChatFunding=true";

type Env = { principal: RequestPrincipal };
type Route = { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; body?: unknown };

export interface AppChatEventSource {
  registerOutboxSink(sink: ChatOutboxSink): { dispose(): void };
  replayOutboxWindow(owner: ChatOwner, input: { afterCursor?: number; limit: number }): Promise<{ events: ChatOutboxEvent[]; gap: boolean; nextCursor?: number }>;
}

export interface AppChatRuntimeOptions {
  service: CanonicalChatRouteService;
  catalog: Pick<ChatProviderCatalogService, "getCatalog" | "refresh">;
  projects: { list(principal: RequestPrincipal): Promise<unknown> };
  events: AppChatEventSource;
}

export interface AppChatRuntime {
  dispatch(principal: RequestPrincipal, request: AppChatRequest, signal: AbortSignal): Promise<AppChatReply>;
  close(): void;
}

export interface AppChatRoutesOptions {
  runtime(): AppChatRuntime | null;
  resolvePrincipal(context: Context): RequestPrincipal;
}

const failure = (status: number, code: string, safeMessage: string, retryable: boolean): AppChatReply =>
  ({ ok: false, status, error: { code, safeMessage, retryable } });
const denied = () => failure(403, "app_chat_denied", "This app does not have access to that Chat action.", false);
const unavailable = () => failure(503, "chat_unavailable", "Chat is temporarily unavailable.", true);

function query(values: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) search.set(key, String(value));
  return search.toString();
}

function chatPath(chatId: string, suffix = ""): string {
  return `/api/chats/${encodeURIComponent(chatId)}${suffix}`;
}

/** Every route an app can reach is listed here; unlisted native routes stay closed. */
function routeFor(request: Exclude<AppChatRequest, { op: "access" | "events" | "projects" | "providers" }>): Route {
  switch (request.op) {
    case "navigation": return { method: "GET", path: `/api/chat-navigation?${query({ version: 1, importSourceVersion: 1, limit: request.limit, lifecycle: request.lifecycle })}` };
    case "list": return { method: "GET", path: `/api/chats?${query({ unread: request.unread, limit: request.limit, lifecycle: request.lifecycle, projectId: request.projectId, scope: request.scope, cursor: request.cursor })}` };
    case "search": return { method: "GET", path: `/api/chats/search?${query({ query: request.query, limit: request.limit, projectId: request.projectId, scope: request.scope })}` };
    case "get": return { method: "GET", path: `${chatPath(request.chatId)}?${query({ limit: request.limit, cursor: request.cursor })}` };
    case "turnAdmission": return { method: "GET", path: `${chatPath(request.chatId, `/turn-admissions/${encodeURIComponent(request.clientRequestId)}`)}?${query({ requestHash: request.requestHash })}` };
    case "create": return { method: "POST", path: "/api/chats", body: request.body };
    case "setTitle": return { method: "PATCH", path: chatPath(request.chatId, "/title"), body: request.body };
    case "setProject": return { method: "PATCH", path: chatPath(request.chatId, "/project"), body: request.body };
    case "setPinned": return { method: "PATCH", path: chatPath(request.chatId, "/user-state"), body: { pinned: request.pinned } };
    case "setReadState": return { method: "PATCH", path: chatPath(request.chatId, "/read-state"), body: request.body };
    case "acknowledgeCompletion": return { method: "POST", path: chatPath(request.chatId, `/runs/${encodeURIComponent(request.runId)}/acknowledge`), body: {} };
    case "sendTurn": return { method: "POST", path: chatPath(request.chatId, "/turns"), body: request.body };
    case "queueTurn": return { method: "POST", path: chatPath(request.chatId, "/queued-turns"), body: request.body };
    case "updateQueuedTurn": return { method: "PATCH", path: chatPath(request.chatId, `/queued-turns/${encodeURIComponent(request.queuedTurnId)}`), body: request.body };
    case "cancelQueuedTurn": return { method: "DELETE", path: chatPath(request.chatId, `/queued-turns/${encodeURIComponent(request.queuedTurnId)}`), body: request.body };
    case "reorderQueuedTurns": return { method: "PATCH", path: chatPath(request.chatId, "/queued-turns/order"), body: request.body };
    case "steerRun": return { method: "POST", path: chatPath(request.chatId, `/runs/${encodeURIComponent(request.runId)}/steer`), body: request.body };
    case "steerQueuedTurn": return { method: "POST", path: chatPath(request.chatId, `/runs/${encodeURIComponent(request.runId)}/queued-turns/${encodeURIComponent(request.queuedTurnId)}/steer`), body: request.body };
    case "cancelRun": return { method: "POST", path: chatPath(request.chatId, `/runs/${encodeURIComponent(request.runId)}/cancel`), body: request.body };
    case "submitInput": return { method: "POST", path: chatPath(request.chatId, `/runs/${encodeURIComponent(request.runId)}/inputs/${encodeURIComponent(request.requestId)}`), body: request.body };
    case "retryTurn": return { method: "POST", path: chatPath(request.chatId, `/turns/${encodeURIComponent(request.turnId)}/runs`), body: request.body };
    // Platform-issued approval proofs are never forwarded, so proof-gated
    // browser and custom-MCP approvals stay with the native approval surface.
    case "submitApproval": return { method: "POST", path: chatPath(request.chatId, `/runs/${encodeURIComponent(request.runId)}/approvals/${encodeURIComponent(request.approvalId)}`), body: request.body };
    case "delete": return { method: "DELETE", path: `${chatPath(request.chatId)}?${query({ clientRequestId: request.clientRequestId })}` };
  }
}

function withVersions(path: string): string {
  if (!path.startsWith("/api/chats")) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${CHAT_WIRE_VERSIONS}`;
}

function replyFromBody(status: number, body: unknown): AppChatReply {
  if (status >= 200 && status < 300) return { ok: true, status, result: (body ?? null) as never };
  const reported = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  const safe = AppChatErrorSchema.safeParse(typeof reported === "object" && reported !== null ? {
    code: (reported as { code?: unknown }).code,
    safeMessage: (reported as { safeMessage?: unknown }).safeMessage,
    retryable: (reported as { retryable?: unknown }).retryable === true,
  } : undefined);
  if (safe.success) return { ok: false, status, error: safe.data };
  if (status === 400) return failure(status, "invalid_request", "Invalid Chat request.", false);
  if (status === 404) return failure(status, "chat_not_found", "Chat not found.", false);
  if (status === 413) return failure(status, "request_too_large", "That message is too large.", false);
  return status >= 500 ? unavailable() : failure(status, "chat_request_failed", "The Chat request failed.", false);
}

export function createAppChatRuntime(options: AppChatRuntimeOptions): AppChatRuntime {
  const routes = new Hono<{ Bindings: Env }>();
  const getPrincipal = (context: Context) => (context.env as Env).principal;
  routes.route("/", createCanonicalChatRoutes({ service: options.service, getPrincipal }));
  routes.route("/", createChatProviderRoutes({ catalog: options.catalog, getPrincipal }));

  const waiters = new Set<{ ownerId: string; wake(): void }>();
  const sink = options.events.registerOutboxSink(({ owner }) => {
    for (const waiter of waiters) if (waiter.ownerId === owner.ownerId) waiter.wake();
  });

  function waitForEvent(ownerId: string, waitMs: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        waiters.delete(waiter);
        resolve();
      };
      const waiter = { ownerId, wake: finish };
      const timer = setTimeout(finish, waitMs);
      if (signal.aborted) { finish(); return; }
      signal.addEventListener("abort", finish, { once: true });
      waiters.add(waiter);
    });
  }

  async function events(principal: RequestPrincipal, request: Extract<AppChatRequest, { op: "events" }>, signal: AbortSignal): Promise<AppChatReply> {
    const owner: ChatOwner = { type: "personal", ownerId: principal.userId };
    const read = () => options.events.replayOutboxWindow(owner, {
      ...(request.cursor === undefined ? {} : { afterCursor: request.cursor }), limit: EVENT_PAGE,
    });
    let page = await read();
    if (!page.gap && page.events.length === 0 && request.waitMs && waiters.size < MAX_EVENT_WAITERS) {
      await waitForEvent(principal.userId, request.waitMs, signal);
      page = await read();
    }
    // Persisted payloads can hold stream content captured before a Chat was
    // shared. Apps get the notification and refetch through the owner read.
    const result = AppChatEventsResultSchema.parse({
      events: page.events.map(event => CanonicalChatStreamEventSchema.parse({
        cursor: event.cursor, chatId: event.chatId, revision: event.revision, eventType: event.eventType, createdAt: event.createdAt,
      })),
      gap: page.gap,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
    return { ok: true, status: 200, result: result as never };
  }

  async function forward(principal: RequestPrincipal, route: Route, signal: AbortSignal): Promise<AppChatReply> {
    const response = await routes.request(route.path, {
      method: route.method,
      signal,
      headers: { "content-type": "application/json", "x-matrix-chat-metadata": "1" },
      ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
    }, { principal });
    let body: unknown = null;
    try { body = await response.json(); }
    catch (error: unknown) {
      // An unmatched route answers in plain text; the status alone still maps safely.
      if (!(error instanceof SyntaxError)) console.warn("[app-capabilities] Chat reply unreadable", error instanceof Error ? error.name : "UnknownError");
    }
    return replyFromBody(response.status, body);
  }

  return {
    async dispatch(principal, request, signal) {
      switch (request.op) {
        case "access": throw new Error("Access is answered from policy");
        case "events": return events(principal, request, signal);
        case "projects": return { ok: true, status: 200, result: await options.projects.list(principal) as never };
        case "providers": return forward(principal, { method: "GET", path: `/api/chat-providers?${PROVIDER_QUERY}` }, signal);
        default: {
          const route = routeFor(request);
          return forward(principal, { ...route, path: withVersions(route.path) }, signal);
        }
      }
    },
    close() {
      for (const waiter of [...waiters]) waiter.wake();
      sink.dispose();
    },
  };
}

export function createAppChatBudget() {
  let windowStart = 0;
  let requests = 0;
  let inFlight = 0;
  return {
    acquire(): boolean {
      const now = Date.now();
      if (now - windowStart >= 60_000) { windowStart = now; requests = 0; }
      if (requests >= MAX_CHAT_REQUESTS_PER_MINUTE || inFlight >= MAX_CHAT_IN_FLIGHT) return false;
      requests += 1;
      inFlight += 1;
      return true;
    },
    release(): void { inFlight -= 1; },
  };
}

export async function handleAppChatRequest(input: {
  context: Context;
  homePath: string;
  app: string;
  request: AppChatRequest;
  options: AppChatRoutesOptions | undefined;
  budget: ReturnType<typeof createAppChatBudget>;
}): Promise<AppChatReply> {
  if (!input.budget.acquire()) return failure(429, "app_chat_busy", "Chat is busy. Try again shortly.", true);
  try {
    // Trust and policy are read per request, so revocation applies immediately.
    const scopes = appChatScopes(await readAppCapabilityAccess(input.homePath, input.app));
    if (input.request.op === "access") return { ok: true, status: 200, result: { scopes: [...scopes] } as never };
    const required = APP_CHAT_OPERATION_SCOPES[input.request.op];
    if (!required || !scopes.includes(required)) return denied();
    const runtime = input.options?.runtime();
    if (!runtime) return unavailable();
    const signal = AbortSignal.any([input.context.req.raw.signal, AbortSignal.timeout(30_000)]);
    return await runtime.dispatch(input.options!.resolvePrincipal(input.context), input.request, signal);
  } catch (error: unknown) {
    console.warn("[app-capabilities] Chat request failed", error instanceof Error ? error.name : "UnknownError");
    return unavailable();
  } finally {
    input.budget.release();
  }
}
