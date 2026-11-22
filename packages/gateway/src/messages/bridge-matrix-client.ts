import { z } from "zod/v4";
import type { MessagingBridgeSession } from "@matrix-os/contracts/messaging-bridge";
import { cancelBody, errorName, readBoundedJson } from "./bridge-http.js";
import type { MatrixClientEvent } from "./bridge-room-state.js";

/** Minimal Matrix client-server API client for exactly one owner's homeserver session. */

export const MATRIX_REQUEST_TIMEOUT_MS = 10_000;
export const MATRIX_SYNC_TIMEOUT_MS = 35_000;
export const MATRIX_SYNC_LONG_POLL_MS = 30_000;
const SYNC_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;
const STATE_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const SMALL_RESPONSE_LIMIT_BYTES = 64 * 1024;

export const SYNC_FILTER = {
  presence: { not_types: ["*"] },
  account_data: { not_types: ["*"] },
  room: {
    timeline: { limit: 50 },
    ephemeral: { not_types: ["*"] },
    account_data: { not_types: ["*"] },
    // Member events for every timeline sender, so each batch can name senders.
    state: { lazy_load_members: true, include_redundant_members: true },
  },
} as const;

export class MatrixUnauthorizedError extends Error {
  constructor() {
    super("Bridge homeserver rejected the access token");
    this.name = "MatrixUnauthorizedError";
  }
}

export class MatrixRequestError extends Error {
  constructor(readonly status: number | null, readonly retryable: boolean) {
    super(`Bridge homeserver request failed (${status ?? "network"})`);
    this.name = "MatrixRequestError";
  }
}

const EventSchema = z.looseObject({
  type: z.string().max(255),
  event_id: z.string().max(255).optional(),
  sender: z.string().max(255).optional(),
  origin_server_ts: z.number().optional(),
  state_key: z.string().max(512).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
  unsigned: z.looseObject({
    transaction_id: z.string().max(255).optional(),
    redacted_because: z.unknown().optional(),
  }).optional(),
});

const EventListSchema = z.object({ events: z.array(EventSchema).max(10_000).default([]) }).loose();

const TimelineSchema = EventListSchema.extend({
  limited: z.boolean().optional(),
  prev_batch: z.string().min(1).max(2_048).optional(),
});

const JoinedRoomSchema = z.looseObject({
  state: EventListSchema.optional(),
  timeline: TimelineSchema.optional(),
});

const MessagesResponseSchema = z.looseObject({
  chunk: z.array(EventSchema).max(1_000).default([]),
  end: z.string().min(1).max(2_048).optional(),
  state: z.array(EventSchema).max(10_000).default([]),
});

/** Member events for the senders on each history page, so the caller can name them. */
const MESSAGES_FILTER = { lazy_load_members: true } as const;

const InvitedRoomSchema = z.looseObject({
  invite_state: EventListSchema.optional(),
});

const SyncResponseSchema = z.looseObject({
  next_batch: z.string().min(1).max(2_048),
  rooms: z.looseObject({
    join: z.record(z.string().max(255), JoinedRoomSchema).optional(),
    invite: z.record(z.string().max(255), InvitedRoomSchema).optional(),
  }).optional(),
});

export interface MatrixSyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, {
      state?: { events: MatrixClientEvent[] };
      /** `limited` means events between the previous batch and this timeline were left out; fill from `prev_batch`. */
      timeline?: { events: MatrixClientEvent[]; limited?: boolean; prev_batch?: string };
    }>;
    invite?: Record<string, { invite_state?: { events: MatrixClientEvent[] } }>;
  };
}

export interface BridgeMatrixClient {
  sync(session: MessagingBridgeSession, options: { since?: string; timeoutMs: number; signal?: AbortSignal }): Promise<MatrixSyncResponse>;
  sendText(session: MessagingBridgeSession, input: { roomId: string; txnId: string; body: string; signal?: AbortSignal }): Promise<{ eventId: string }>;
  getRoomState(session: MessagingBridgeSession, roomId: string, signal?: AbortSignal): Promise<MatrixClientEvent[]>;
  joinRoom(session: MessagingBridgeSession, roomId: string, signal?: AbortSignal): Promise<void>;
  /** One page of room history, newest first, from `from` back towards `to`; no `end` means no older events. */
  getMessages(session: MessagingBridgeSession, input: { roomId: string; from: string; to?: string; limit: number; signal?: AbortSignal }): Promise<MatrixMessagesPage>;
}

export interface MatrixMessagesPage {
  chunk: MatrixClientEvent[];
  end?: string;
  state: MatrixClientEvent[];
}

function homeserverOrigin(session: MessagingBridgeSession): string {
  let url: URL;
  try {
    url = new URL(session.homeserverUrl);
  } catch (err: unknown) {
    console.warn("[messages/bridge-matrix] invalid homeserver URL", errorName(err));
    throw new MatrixRequestError(null, false);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new MatrixRequestError(null, false);
  }
  return url.origin;
}

function signalFor(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

export function createBridgeMatrixClient(options: { fetchImpl?: typeof fetch } = {}): BridgeMatrixClient {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(
    session: MessagingBridgeSession,
    method: "GET" | "POST" | "PUT",
    path: string,
    init: { body?: unknown; timeoutMs?: number; limit?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const origin = homeserverOrigin(session);
    let response: Response;
    try {
      response = await fetchImpl(`${origin}/_matrix/client/v3${path}`, {
        method,
        redirect: "error",
        signal: signalFor(init.timeoutMs ?? MATRIX_REQUEST_TIMEOUT_MS, init.signal),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${session.accessToken}`,
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (err: unknown) {
      if (init.signal?.aborted) throw err;
      console.warn("[messages/bridge-matrix] request failed", errorName(err));
      throw new MatrixRequestError(null, true);
    }
    if (response.status === 401) {
      await cancelBody(response);
      throw new MatrixUnauthorizedError();
    }
    if (!response.ok) {
      await cancelBody(response);
      const retryable = response.status === 429 || response.status >= 500;
      throw new MatrixRequestError(response.status, retryable);
    }
    try {
      return await readBoundedJson(response, init.limit ?? SMALL_RESPONSE_LIMIT_BYTES);
    } catch (err: unknown) {
      await cancelBody(response);
      console.warn("[messages/bridge-matrix] unreadable response", errorName(err));
      throw new MatrixRequestError(response.status, true);
    }
  }

  return {
    async sync(session, syncOptions) {
      const params = new URLSearchParams({
        filter: JSON.stringify(SYNC_FILTER),
        timeout: String(syncOptions.timeoutMs),
      });
      if (syncOptions.since) params.set("since", syncOptions.since);
      const payload = await request(session, "GET", `/sync?${params.toString()}`, {
        timeoutMs: MATRIX_SYNC_TIMEOUT_MS,
        limit: SYNC_RESPONSE_LIMIT_BYTES,
        signal: syncOptions.signal,
      });
      const parsed = SyncResponseSchema.safeParse(payload);
      if (!parsed.success) {
        console.warn("[messages/bridge-matrix] sync response failed validation");
        throw new MatrixRequestError(200, true);
      }
      return parsed.data as MatrixSyncResponse;
    },
    async sendText(session, input) {
      const payload = await request(
        session,
        "PUT",
        `/rooms/${encodeURIComponent(input.roomId)}/send/m.room.message/${encodeURIComponent(input.txnId)}`,
        { body: { msgtype: "m.text", body: input.body }, signal: input.signal },
      );
      const parsed = z.object({ event_id: z.string().min(2).max(255).regex(/^\$/) }).loose().safeParse(payload);
      if (!parsed.success) throw new MatrixRequestError(200, true);
      return { eventId: parsed.data.event_id };
    },
    async getRoomState(session, roomId, signal) {
      const payload = await request(session, "GET", `/rooms/${encodeURIComponent(roomId)}/state`, {
        limit: STATE_RESPONSE_LIMIT_BYTES,
        signal,
      });
      const parsed = z.array(EventSchema).max(10_000).safeParse(payload);
      if (!parsed.success) throw new MatrixRequestError(200, true);
      return parsed.data as MatrixClientEvent[];
    },
    async joinRoom(session, roomId, signal) {
      await request(session, "POST", `/rooms/${encodeURIComponent(roomId)}/join`, { body: {}, signal });
    },
    async getMessages(session, input) {
      const params = new URLSearchParams({
        dir: "b",
        from: input.from,
        limit: String(input.limit),
        filter: JSON.stringify(MESSAGES_FILTER),
      });
      if (input.to) params.set("to", input.to);
      const payload = await request(session, "GET", `/rooms/${encodeURIComponent(input.roomId)}/messages?${params.toString()}`, {
        limit: STATE_RESPONSE_LIMIT_BYTES,
        signal: input.signal,
      });
      const parsed = MessagesResponseSchema.safeParse(payload);
      if (!parsed.success) throw new MatrixRequestError(200, true);
      return {
        chunk: parsed.data.chunk as MatrixClientEvent[],
        ...(parsed.data.end ? { end: parsed.data.end } : {}),
        state: parsed.data.state as MatrixClientEvent[],
      };
    },
  };
}
