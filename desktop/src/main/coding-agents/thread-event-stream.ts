import {
  AgentThreadEventSchema,
  CursorSchema,
  SafeClientErrorSchema,
  ThreadIdSchema,
  type AgentThreadEvent,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { AuthService } from "../auth/auth-service";
import type { EventChannel, EventPayload } from "../../shared/ipc-contract";

const WS_TOKEN_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_THREAD_STREAMS = 8;
const WS_OPEN = 1;

const WsTokenResponseSchema = z.object({
  token: z.string().min(1).max(4096).optional(),
}).passthrough();

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
]);

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface DesktopCodingAgentThreadWebSocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

interface ThreadSubscription {
  threadId: string;
  ws: DesktopCodingAgentThreadWebSocket;
}

export interface CodingAgentThreadEventStreamer {
  subscribe(input: { threadId: string; cursor?: string }): Promise<void>;
  unsubscribe(threadId: string): void;
  closeAll(): void;
}

export function createCodingAgentThreadEventStreamer(options: {
  auth: AuthService;
  emit: <C extends EventChannel>(channel: C, payload: EventPayload<C>) => void;
  fetchFn?: FetchFn;
  createWebSocket?: (url: string) => DesktopCodingAgentThreadWebSocket;
  maxSubscriptions?: number;
}): CodingAgentThreadEventStreamer {
  const fetchFn = options.fetchFn ?? fetch;
  const maxSubscriptions = Math.max(1, Math.min(options.maxSubscriptions ?? DEFAULT_MAX_THREAD_STREAMS, DEFAULT_MAX_THREAD_STREAMS));
  const subscriptions = new Map<string, ThreadSubscription>();
  const subscriptionGenerations = new Map<string, number>();

  function nextSubscriptionGeneration(threadId: string): number {
    const generation = (subscriptionGenerations.get(threadId) ?? 0) + 1;
    subscriptionGenerations.set(threadId, generation);
    return generation;
  }

  function closeSubscription(subscription: ThreadSubscription): void {
    if (subscription.ws.readyState === WS_OPEN) {
      try {
        subscription.ws.send(JSON.stringify({ type: "detach" }));
      } catch (err: unknown) {
        console.warn("[desktop] coding-agent thread stream detach failed:", err instanceof Error ? err.message : String(err));
      }
    }
    try {
      subscription.ws.close();
    } catch (err: unknown) {
      console.warn("[desktop] coding-agent thread stream close failed:", err instanceof Error ? err.message : String(err));
    }
  }

  function closeTrackedSubscription(threadId: string): void {
    const subscription = subscriptions.get(threadId);
    if (!subscription) return;
    subscriptions.delete(threadId);
    closeSubscription(subscription);
  }

  function unsubscribe(threadId: string): void {
    const parsedThreadId = ThreadIdSchema.safeParse(threadId);
    if (!parsedThreadId.success) return;
    nextSubscriptionGeneration(parsedThreadId.data);
    closeTrackedSubscription(parsedThreadId.data);
  }

  function evictIfNeeded(): void {
    while (subscriptions.size > maxSubscriptions) {
      const oldest = subscriptions.keys().next().value;
      if (typeof oldest !== "string") return;
      unsubscribe(oldest);
    }
  }

  async function fetchWsToken(): Promise<string> {
    const token = options.auth.getToken();
    if (!token) throw new Error("thread stream unavailable");
    const url = new URL("/api/auth/ws-token", options.auth.getGatewayOrigin());
    const res = await fetchFn(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(WS_TOKEN_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error("thread stream unavailable");
    const parsed = WsTokenResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.token) throw new Error("thread stream unavailable");
    return parsed.data.token;
  }

  async function subscribe(input: { threadId: string; cursor?: string }): Promise<void> {
    const parsedThreadId = ThreadIdSchema.safeParse(input.threadId);
    const parsedCursor = input.cursor ? CursorSchema.safeParse(input.cursor) : null;
    if (!parsedThreadId.success || (parsedCursor && !parsedCursor.success)) {
      throw new Error("thread stream unavailable");
    }

    const generation = nextSubscriptionGeneration(parsedThreadId.data);
    closeTrackedSubscription(parsedThreadId.data);
    const token = await fetchWsToken();
    if (subscriptionGenerations.get(parsedThreadId.data) !== generation) return;
    const url = new URL(`/ws/coding-agents/thread/${encodeURIComponent(parsedThreadId.data)}`, options.auth.getGatewayOrigin());
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", token);
    if (parsedCursor?.success) url.searchParams.set("cursor", parsedCursor.data);

    const createWebSocket = options.createWebSocket ?? ((wsUrl: string) => new WebSocket(wsUrl) as unknown as DesktopCodingAgentThreadWebSocket);
    const ws = createWebSocket(url.toString());
    if (subscriptionGenerations.get(parsedThreadId.data) !== generation) {
      try {
        ws.close();
      } catch (err: unknown) {
        console.warn("[desktop] stale coding-agent thread stream close failed:", err instanceof Error ? err.message : String(err));
      }
      return;
    }
    const subscription: ThreadSubscription = { threadId: parsedThreadId.data, ws };
    subscriptions.set(parsedThreadId.data, subscription);
    evictIfNeeded();

    ws.onmessage = (event) => {
      if (subscriptions.get(parsedThreadId.data) !== subscription) return;
      if (typeof event.data !== "string") return;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(event.data);
      } catch {
        console.warn("[desktop] coding-agent thread stream sent invalid JSON");
        return;
      }
      const frame = ThreadStreamServerFrameSchema.safeParse(parsedJson);
      if (!frame.success) {
        console.warn("[desktop] coding-agent thread stream sent invalid frame");
        return;
      }
      if (frame.data.type === "thread.stream.error") {
        options.emit("runtime:thread-stream-error", {
          threadId: parsedThreadId.data,
          error: frame.data.error,
        });
        return;
      }
      if (frame.data.type !== "thread.event") return;
      const threadEvent: AgentThreadEvent = frame.data.event;
      if (threadEvent.threadId !== parsedThreadId.data) return;
      options.emit("runtime:thread-event", {
        threadId: parsedThreadId.data,
        event: threadEvent,
      });
    };

    ws.onerror = () => {
      console.warn("[desktop] coding-agent thread stream unavailable");
    };
    ws.onclose = () => {
      if (subscriptions.get(parsedThreadId.data) === subscription) {
        subscriptions.delete(parsedThreadId.data);
      }
    };
  }

  return {
    subscribe,
    unsubscribe,
    closeAll() {
      for (const subscription of subscriptions.values()) {
        closeSubscription(subscription);
      }
      subscriptions.clear();
      subscriptionGenerations.clear();
    },
  };
}
