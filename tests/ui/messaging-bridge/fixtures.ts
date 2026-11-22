import {
  MessagingBridgeConversationsResponseSchema,
  MessagingBridgeLinkProgressSchema,
  MessagingBridgeMessageSchema,
  MessagingBridgeMessagesResponseSchema,
  MessagingBridgeStatusSchema,
  type MessagingBridgeConversation,
  type MessagingBridgeLinkProgress,
  type MessagingBridgeLoginStep,
  type MessagingBridgeMessage,
  type MessagingBridgeNetwork,
  type MessagingBridgeStatus,
} from "@matrix-os/contracts/messaging-bridge";

/* Every fixture is parsed with the shared contract so a drift fails here, not in the UI. */

export function status(value: MessagingBridgeStatus): MessagingBridgeStatus {
  return MessagingBridgeStatusSchema.parse(value);
}

export const readyNoAccounts = () =>
  status({
    availability: "ready",
    networks: [
      { network: "whatsapp", accounts: [] },
      { network: "telegram", accounts: [] },
      { network: "linkedin", accounts: [] },
    ],
  });

export const readyWithAccounts = () =>
  status({
    availability: "ready",
    networks: [
      { network: "whatsapp", accounts: [{ accountId: "wa-1", displayName: "+46 70 000 0000", state: "connected" }] },
      { network: "telegram", accounts: [{ accountId: "tg-1", state: "needs_relink" }] },
      { network: "linkedin", accounts: [] },
    ],
  });

export function progress(network: MessagingBridgeNetwork, step: MessagingBridgeLoginStep, linkId = "link-1"): MessagingBridgeLinkProgress {
  return MessagingBridgeLinkProgressSchema.parse({ linkId, network, step });
}

export function conversation(overrides: Partial<MessagingBridgeConversation> & { roomId: string }): MessagingBridgeConversation {
  return MessagingBridgeConversationsResponseSchema.parse({
    items: [{ network: "whatsapp", displayName: "Ada", unreadCount: 0, ...overrides }],
  }).items[0]!;
}

export function conversations(items: MessagingBridgeConversation[], nextCursor?: string) {
  return MessagingBridgeConversationsResponseSchema.parse(nextCursor ? { items, nextCursor } : { items });
}

export function message(overrides: Partial<MessagingBridgeMessage>): MessagingBridgeMessage {
  return MessagingBridgeMessageSchema.parse({
    direction: "incoming",
    senderName: "Ada",
    kind: "text",
    body: "hello",
    occurredAt: "2026-11-22T10:00:00.000Z",
    ...overrides,
  });
}

export function messages(items: MessagingBridgeMessage[], nextCursor?: string) {
  return MessagingBridgeMessagesResponseSchema.parse(nextCursor ? { items, nextCursor } : { items });
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
  signal: AbortSignal | undefined;
}

type Reply = { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;
type Handler = (request: RecordedRequest) => Reply;

/**
 * A fake owner gateway: routes by `METHOD path` (path without query, or with
 * query when a handler is registered for it), records every request, and
 * rejects in-flight requests with the signal's reason when aborted, as the
 * real Fetch API does.
 */
export function fakeGateway(routes: Record<string, Handler>) {
  const requests: RecordedRequest[] = [];
  const fetch = (path: string, init: RequestInit): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const signal = init.signal ?? undefined;
    const request: RecordedRequest = { method, path, body, signal };
    requests.push(request);
    const handler = routes[`${method} ${path}`] ?? routes[`${method} ${path.split("?")[0]}`];
    if (!handler) return Promise.resolve(json(404, { error: { code: "not_found", message: "Not found" } }));
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      Promise.resolve(handler(request)).then(
        (reply) => resolve(json(reply.status ?? 200, reply.body)),
        reject,
      );
    });
  };
  return { fetch, requests };
}

export function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
