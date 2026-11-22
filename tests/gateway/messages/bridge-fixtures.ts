import { vi } from "vitest";
import type { MessagingBridgeSession } from "@matrix-os/contracts/messaging-bridge";
import type { MessagingBridgePlatformClient } from "../../../packages/gateway/src/messages/bridge-platform-client.js";
import type { BridgeSessionStore } from "../../../packages/gateway/src/messages/bridge-session.js";

export const bridgeServer = "bridge.example.test";
export const ownUserId = `@mx_owner:${bridgeServer}`;

export function bridgeSession(accessToken = "syt_owner_secret_token_1"): MessagingBridgeSession {
  return {
    homeserverUrl: `https://${bridgeServer}`,
    userId: ownUserId,
    accessToken,
    deviceId: "MATRIXOSGW",
    networks: ["whatsapp", "telegram", "linkedin"],
  };
}

export function memorySessionStore(initial: Record<string, MessagingBridgeSession> = {}): BridgeSessionStore & { data: Record<string, MessagingBridgeSession> } {
  const data = { ...initial };
  return {
    data,
    async read(ownerId) {
      return data[ownerId] ?? null;
    },
    async write(ownerId, session) {
      data[ownerId] = session;
    },
  };
}

export function platformMock(overrides: Partial<MessagingBridgePlatformClient> = {}): MessagingBridgePlatformClient {
  return {
    createSession: vi.fn(async () => bridgeSession()),
    listLoginFlows: vi.fn(async () => []),
    startLogin: vi.fn(),
    submitLoginStep: vi.fn(),
    cancelLogin: vi.fn(async () => {}),
    listLogins: vi.fn(async () => []),
    logout: vi.fn(async () => {}),
    ...overrides,
  };
}

export function portalState(network: string, extra: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  return [
    {
      type: "m.bridge",
      state_key: `fi.mau.${network}://portal`,
      sender: `@${network}bot:${bridgeServer}`,
      content: { bridgebot: `@${network}bot:${bridgeServer}`, protocol: { id: network, displayname: network } },
    },
    { type: "m.room.member", state_key: ownUserId, sender: ownUserId, content: { membership: "join" } },
    ...extra,
  ];
}

export function textEvent(eventId: string, sender: string, body: string, at: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "m.room.message",
    event_id: eventId,
    sender,
    origin_server_ts: Date.parse(at),
    content: { msgtype: "m.text", body },
    ...extra,
  };
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Fake homeserver behind the real Matrix client: queued /sync responses plus room state, join and send. */
export function fakeHomeserver() {
  const syncQueue: Array<Response | Error | ((url: URL, init: RequestInit) => Promise<Response>)> = [];
  const roomState: Record<string, unknown[]> = {};
  const joined: string[] = [];
  const sent: Array<{ roomId: string; txnId: string; body: unknown; token: string | null }> = [];
  const syncCalls: Array<{ since: string | null; token: string | null }> = [];
  let sendHandler: Handler | null = null;
  let sendCounter = 0;

  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const token = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") ?? null;
    const path = decodeURIComponent(url.pathname);
    if (path === "/_matrix/client/v3/sync") {
      syncCalls.push({ since: url.searchParams.get("since"), token });
      const next = syncQueue.shift();
      if (!next) {
        return new Promise<Response>((_, reject) => {
          const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (init.signal?.aborted) abort();
          else init.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(url, init) : next;
    }
    const state = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state$/.exec(path);
    if (state) return json(200, roomState[state[1]!] ?? []);
    const join = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/join$/.exec(path);
    if (join) {
      joined.push(join[1]!);
      return json(200, { room_id: join[1] });
    }
    const send = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/m\.room\.message\/([^/]+)$/.exec(path);
    if (send) {
      sent.push({ roomId: send[1]!, txnId: send[2]!, body: JSON.parse(String(init.body)), token });
      if (sendHandler) return sendHandler(url, init);
      sendCounter += 1;
      return json(200, { event_id: `$sent${sendCounter}` });
    }
    return json(404, { errcode: "M_UNRECOGNIZED" });
  });

  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    syncQueue,
    roomState,
    joined,
    sent,
    syncCalls,
    onSend(handler: Handler | null) {
      sendHandler = handler;
    },
  };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function syncResponse(nextBatch: string, rooms: { join?: Record<string, unknown>; invite?: Record<string, unknown> } = {}): Response {
  return json(200, { next_batch: nextBatch, rooms });
}
