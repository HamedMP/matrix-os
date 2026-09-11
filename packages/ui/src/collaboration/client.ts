import {
  COLLABORATION_HTTP_BODY_LIMIT,
  COLLABORATION_CLIENT_REQUEST_ID_HEADER,
  COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER,
  COLLABORATION_EXPECTED_REVISION_HEADER,
  CollaborationDeleteConditionSchema,
  CollaborationConnectionTicketResponseSchema,
  CollaborationEventFrameSchema,
  CollaborationIdSchema,
  CollaborationTerminalFrameSchema,
} from "@matrix-os/contracts";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// A valid 64 KiB terminal payload can expand substantially when JSON escapes
// control characters. The contract still enforces the decoded 64 KiB bound.
const MAX_SOCKET_FRAME_CHARS = 512 * 1024;
const MAX_RECONNECT_DELAY_MS = 10_000;
const TERMINAL_HEARTBEAT_INTERVAL_MS = 10_000;

export function createCollaborationBrowserApi(options: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  getHeaders?: () => Promise<Record<string, string>>;
  webSocketFactory?: (url: string) => WebSocket;
}): CollaborationApi {
  const baseUrl = requireBaseUrl(options.baseUrl);
  const request = async (path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown) => {
    const url = requireCollaborationPath(baseUrl, path);
    const deleteConditions = method === "DELETE" ? CollaborationDeleteConditionSchema.parse(body) : undefined;
    const serialized = method === "DELETE" || body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > COLLABORATION_HTTP_BODY_LIMIT) {
      throw new Error("CollaborationUnavailable");
    }
    const provided = await options.getHeaders?.();
    const authorization = provided?.Authorization ?? provided?.authorization;
    const headers = new Headers({ accept: "application/json" });
    if (serialized !== undefined) headers.set("content-type", "application/json");
    if (authorization && authorization.length <= 4_096) headers.set("authorization", authorization);
    if (deleteConditions) {
      headers.set(COLLABORATION_CLIENT_REQUEST_ID_HEADER, deleteConditions.clientRequestId);
      headers.set(COLLABORATION_EXPECTED_REVISION_HEADER, deleteConditions.expectedRevision);
      headers.set(COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER, deleteConditions.expectedMemberRevision);
    }
    try {
      const response = await (options.fetchImpl ?? fetch)(url.href, {
        method,
        headers,
        credentials: "same-origin",
        redirect: "error",
        ...(serialized === undefined ? {} : { body: serialized }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json")) {
        await response.body?.cancel();
        throw new Error("CollaborationUnavailable");
      }
      const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
      if (text === null) throw new Error("CollaborationUnavailable");
      return JSON.parse(text) as unknown;
    } catch (error: unknown) {
      if (!(error instanceof Error && error.message === "CollaborationUnavailable")) {
        console.warn("[chat-collaboration] request failed", error instanceof Error ? error.name : "UnknownError");
      }
      throw new Error("CollaborationUnavailable");
    }
  };
  const api: CollaborationApi = {
    baseUrl: baseUrl.origin,
    get: (path) => request(path, "GET"),
    post: (path, body) => request(path, "POST", body),
    patch: (path, body) => request(path, "PATCH", body),
    delete: (path, body) => request(path, "DELETE", body),
  };
  if (options.webSocketFactory || typeof WebSocket !== "undefined") {
    api.subscribe = (scopeId, onEvent, onUnavailable) => {
      const parsedScopeId = CollaborationIdSchema.parse(scopeId);
      let closed = false;
      let socket: WebSocket | null = null;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let attempt = 0;
      let sequence = "0";
      const connect = async () => {
        if (closed) return;
        try {
          const ticket = CollaborationConnectionTicketResponseSchema.parse(await api.post(
            `/api/collaboration/scopes/${parsedScopeId}/connection-tickets`,
            { clientRequestId: crypto.randomUUID(), purpose: "events" },
          ));
          if (closed) return;
          const wsUrl = new URL(`/ws/collaboration/scopes/${parsedScopeId}/events`, baseUrl);
          wsUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
          wsUrl.searchParams.set("ticket", ticket.ticket);
          wsUrl.searchParams.set("after", sequence);
          const next = (options.webSocketFactory ?? ((url: string) => new WebSocket(url)))(wsUrl.href);
          socket = next;
          let usable = true;
          let refreshQueue = Promise.resolve();
          const enqueueAfterRecovery = (operation: () => void | Promise<void>) => {
            refreshQueue = refreshQueue.then(async () => {
              if (!usable || closed) return;
              await operation();
            }).catch((error: unknown) => {
              console.warn("[chat-collaboration] canonical refresh failed", error instanceof Error ? error.name : "UnknownError");
              if (usable && !closed) {
                usable = false;
                next.close(1011, "Refresh failed");
              }
            });
          };
          next.onopen = () => { attempt = 0; };
          next.onmessage = (event) => {
            if (!usable) return;
            if (typeof event.data !== "string" || event.data.length > MAX_SOCKET_FRAME_CHARS) {
              next.close(1008, "Invalid frame");
              return;
            }
            try {
              const frame = CollaborationEventFrameSchema.parse(JSON.parse(event.data) as unknown);
              if (frame.scopeId !== parsedScopeId) throw new Error("Scope mismatch");
              if (frame.type === "heartbeat") {
                next.send(JSON.stringify({ version: 1, type: "heartbeat" }));
                enqueueAfterRecovery(() => { sequence = frame.sequence; });
              } else if (frame.type === "ready") {
                enqueueAfterRecovery(() => { sequence = frame.sequence; });
              } else if (frame.type === "unavailable") {
                closed = true;
                onUnavailable();
                next.close(1008, "Unavailable");
              } else if (frame.type === "changed" || frame.type === "capabilities_changed" || frame.type === "refresh_required") {
                enqueueAfterRecovery(async () => {
                  await onEvent();
                  if (usable && !closed) sequence = frame.sequence;
                });
              }
            } catch (error: unknown) {
              console.warn("[chat-collaboration] event frame rejected", error instanceof Error ? error.name : "UnknownError");
              next.close(1008, "Invalid frame");
            }
          };
          next.onerror = () => next.close();
          next.onclose = () => {
            usable = false;
            if (socket === next) socket = null;
            if (closed) return;
            const delay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * (2 ** Math.min(attempt++, 5)));
            retryTimer = setTimeout(() => { void connect(); }, delay);
          };
        } catch (error: unknown) {
          console.warn("[chat-collaboration] event connection failed", error instanceof Error ? error.name : "UnknownError");
          if (closed) return;
          const delay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * (2 ** Math.min(attempt++, 5)));
          retryTimer = setTimeout(() => { void connect(); }, delay);
        }
      };
      void connect();
      return () => {
        closed = true;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = undefined;
        socket?.close(1000, "Closed");
        socket = null;
      };
    };
    api.subscribeTerminal = (scopeId, handlers) => {
      const parsedScopeId = CollaborationIdSchema.parse(scopeId);
      let closed = false;
      let socket: WebSocket | null = null;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      let attempt = 0;
      let sequence = BigInt(0);
      const clearHeartbeat = () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      };
      const connect = async () => {
        if (closed) return;
        try {
          const ticket = CollaborationConnectionTicketResponseSchema.parse(await api.post(
            `/api/collaboration/scopes/${parsedScopeId}/connection-tickets`,
            { clientRequestId: crypto.randomUUID(), purpose: "terminal" },
          ));
          if (closed) return;
          const wsUrl = new URL(`/ws/collaboration/scopes/${parsedScopeId}/terminal`, baseUrl);
          wsUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
          wsUrl.searchParams.set("ticket", ticket.ticket);
          const next = (options.webSocketFactory ?? ((url: string) => new WebSocket(url)))(wsUrl.href);
          socket = next;
          next.onopen = () => {
            attempt = 0;
            clearHeartbeat();
            heartbeatTimer = setInterval(() => {
              if (!closed && socket === next) next.send(JSON.stringify({ version: 1, type: "heartbeat" }));
            }, TERMINAL_HEARTBEAT_INTERVAL_MS);
          };
          next.onmessage = (event) => {
            if (typeof event.data !== "string" || event.data.length > MAX_SOCKET_FRAME_CHARS) {
              next.close(1008, "Invalid frame");
              return;
            }
            try {
              const frame = CollaborationTerminalFrameSchema.parse(JSON.parse(event.data) as unknown);
              if (frame.scopeId !== parsedScopeId) throw new Error("Scope mismatch");
              if (frame.type === "terminal.ready") {
                sequence = maxSequence(sequence, frame.sequence);
                handlers.onReady(frame);
              } else if (frame.type === "terminal.output") {
                const nextSequence = BigInt(frame.sequence);
                if (nextSequence > sequence) {
                  sequence = nextSequence;
                  handlers.onOutput(frame);
                }
              } else if (frame.type === "terminal.state") {
                sequence = maxSequence(sequence, frame.sequence);
                handlers.onState(frame);
              } else if (frame.type === "terminal.refresh_required") {
                sequence = maxSequence(sequence, frame.sequence);
                void Promise.resolve(handlers.onRefreshRequired()).catch((error: unknown) => {
                  console.warn("[terminal-collaboration] canonical refresh failed", error instanceof Error ? error.name : "UnknownError");
                  next.close(1011, "Refresh failed");
                });
              } else {
                closed = true;
                clearHeartbeat();
                handlers.onUnavailable();
                next.close(1008, "Unavailable");
              }
            } catch (error: unknown) {
              console.warn("[terminal-collaboration] event frame rejected", error instanceof Error ? error.name : "UnknownError");
              next.close(1008, "Invalid frame");
            }
          };
          next.onerror = () => next.close();
          next.onclose = () => {
            clearHeartbeat();
            if (socket === next) socket = null;
            if (closed) return;
            const delay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * (2 ** Math.min(attempt++, 5)));
            retryTimer = setTimeout(() => { void connect(); }, delay);
          };
        } catch (error: unknown) {
          console.warn("[terminal-collaboration] event connection failed", error instanceof Error ? error.name : "UnknownError");
          if (closed) return;
          const delay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * (2 ** Math.min(attempt++, 5)));
          retryTimer = setTimeout(() => { void connect(); }, delay);
        }
      };
      void connect();
      return () => {
        closed = true;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = undefined;
        clearHeartbeat();
        socket?.close(1000, "Closed");
        socket = null;
      };
    };
  }
  return api;
}

function maxSequence(current: bigint, next: string): bigint {
  const parsed = BigInt(next);
  return parsed > current ? parsed : current;
}

function requireBaseUrl(value: string): URL {
  const url = new URL(value);
  if (!url.hostname || !["https:", "http:"].includes(url.protocol) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) throw new Error("CollaborationUnavailable");
  return url;
}

function requireCollaborationPath(baseUrl: URL, path: string): URL {
  if (path.length > 1_024 || !path.startsWith("/api/collaboration/") || path.includes("..") || path.includes("//")) {
    throw new Error("CollaborationUnavailable");
  }
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith("/api/collaboration/")) {
    throw new Error("CollaborationUnavailable");
  }
  return url;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(output);
}
