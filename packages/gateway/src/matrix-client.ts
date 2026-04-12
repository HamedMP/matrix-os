import { randomUUID } from 'node:crypto';

export interface MatrixClientConfig {
  homeserverUrl: string;
  accessToken: string;
  fetch?: typeof globalThis.fetch;
}

export interface MatrixMessage {
  eventId: string;
  sender: string;
  body: string;
  type: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Typed errors (spec §J error policy — never leak raw response text to callers)
// ---------------------------------------------------------------------------

export class MatrixForbiddenError extends Error {
  override readonly name = 'MatrixForbiddenError' as const;
  constructor(message: string) {
    super(message);
  }
}

export class MatrixNotFoundError extends Error {
  override readonly name = 'MatrixNotFoundError' as const;
  constructor(message: string) {
    super(message);
  }
}

export class MatrixRateLimitError extends Error {
  override readonly name = 'MatrixRateLimitError' as const;
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

export class MatrixUnknownError extends Error {
  override readonly name = 'MatrixUnknownError' as const;
  constructor(message: string) {
    super(message);
  }
}

export class MatrixContentTooLargeError extends Error {
  override readonly name = 'MatrixContentTooLargeError' as const;
  readonly contentBytes: number;
  readonly maxBytes: number;
  constructor(message: string, contentBytes: number, maxBytes: number) {
    super(message);
    this.contentBytes = contentBytes;
    this.maxBytes = maxBytes;
  }
}

// ---------------------------------------------------------------------------
// Sync types
// ---------------------------------------------------------------------------

export interface MatrixRawEvent {
  event_id?: string;
  type: string;
  sender?: string;
  state_key?: string;
  origin_server_ts?: number;
  content: Record<string, unknown>;
}

export interface MatrixTimelineSlice {
  events: MatrixRawEvent[];
  limited: boolean;
  prev_batch?: string;
}

export interface MatrixJoinedRoom {
  timeline: MatrixTimelineSlice;
  state: { events: MatrixRawEvent[] };
}

export interface MatrixInvitedRoom {
  invite_state?: { events: MatrixRawEvent[] };
}

export interface MatrixLeftRoom {
  timeline?: MatrixTimelineSlice;
  state?: { events: MatrixRawEvent[] };
}

export interface MatrixSyncResponse {
  next_batch: string;
  rooms: {
    join: Record<string, MatrixJoinedRoom>;
    invite: Record<string, MatrixInvitedRoom>;
    leave: Record<string, MatrixLeftRoom>;
  };
  presence: { events: MatrixRawEvent[] };
  account_data?: { events: MatrixRawEvent[] };
}

// ---------------------------------------------------------------------------
// Lifecycle / state types
// ---------------------------------------------------------------------------

export interface CreateRoomInput {
  name?: string;
  invite?: string[];
  preset?: 'private_chat' | 'trusted_private_chat' | 'public_chat';
  powerLevelContentOverride?: PowerLevelsContent;
  initialState?: Array<{
    type: string;
    state_key?: string;
    content: Record<string, unknown>;
  }>;
}

export interface PowerLevelsContent {
  users?: Record<string, number>;
  users_default?: number;
  state_default?: number;
  events_default?: number;
  events?: Record<string, number>;
  ban?: number;
  kick?: number;
  invite?: number;
  redact?: number;
}

export interface RoomStateEvent {
  type: string;
  state_key: string;
  content: Record<string, unknown>;
  event_id?: string;
  sender?: string;
  origin_server_ts?: number;
}

export interface RoomMember {
  userId: string;
  membership: 'join' | 'invite' | 'leave' | 'ban' | 'knock';
  displayName?: string;
}

// ---------------------------------------------------------------------------
// MatrixClient interface
// ---------------------------------------------------------------------------

/**
 * `matrix-client.ts` is a thin Matrix HTTP wrapper. It intentionally exposes
 * NO subscription / dispatch API — subscription and event fan-out are owned
 * exclusively by `MatrixSyncHub` (spec §E.1). Keep this surface a raw RPC
 * client so the higher layer can own cursor threading, gap-fill, and ordering.
 */
export interface MatrixClient {
  // existing
  sendMessage(roomId: string, body: string): Promise<{ eventId: string }>;
  createDM(userId: string): Promise<{ roomId: string }>;
  joinRoom(roomId: string): Promise<{ roomId: string }>;
  getRoomMessages(
    roomId: string,
    options?: { limit?: number; from?: string; dir?: 'f' | 'b' },
  ): Promise<{ messages: MatrixMessage[]; end: string; chunk: MatrixRawEvent[] }>;
  whoami(): Promise<{ userId: string }>;
  sendCustomEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<{ eventId: string }>;

  // sync
  sync(options: {
    since?: string;
    timeoutMs?: number;
    filter?: string;
  }): Promise<MatrixSyncResponse>;

  // room lifecycle
  createRoom(input: CreateRoomInput): Promise<{ roomId: string }>;
  inviteToRoom(roomId: string, userId: string): Promise<void>;
  kickFromRoom(roomId: string, userId: string, reason?: string): Promise<void>;
  leaveRoom(roomId: string): Promise<void>;

  // room state
  getRoomState(
    roomId: string,
    eventType: string,
    stateKey: string,
  ): Promise<Record<string, unknown> | null>;
  getAllRoomStateEvents(
    roomId: string,
    eventType?: string,
  ): Promise<RoomStateEvent[]>;
  setRoomState(
    roomId: string,
    eventType: string,
    stateKey: string,
    content: Record<string, unknown>,
  ): Promise<{ eventId: string }>;

  // membership / power
  getRoomMembers(roomId: string): Promise<RoomMember[]>;
  getPowerLevels(roomId: string): Promise<PowerLevelsContent>;
  setPowerLevels(
    roomId: string,
    content: PowerLevelsContent,
  ): Promise<{ eventId: string }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Matrix canonical room-event content ceiling is 65 536 B (64 KiB). The spike
 * measured a Conduit hard-fail at 65 000 B; we pick 64 500 B as the preflight
 * cap to leave ~500 B of headroom for JSON envelope overhead added by the
 * homeserver (`type`, `sender`, etc).
 */
export const MATRIX_EVENT_CONTENT_MAX_BYTES = 64_500;

const DEFAULT_STATE_TIMEOUT_MS = 10_000;
const DEFAULT_SYNC_TIMEOUT_MS = 30_000;
const SYNC_CLIENT_SLACK_MS = 5_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMatrixClient(config: MatrixClientConfig): MatrixClient {
  const { homeserverUrl, accessToken } = config;
  const fetchFn = config.fetch ?? globalThis.fetch;

  function headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  async function matrixFetch(
    path: string,
    init: RequestInit & { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const url = `${homeserverUrl}${path}`;
    const timeoutMs = init.timeoutMs ?? DEFAULT_STATE_TIMEOUT_MS;
    const signal = init.signal ?? AbortSignal.timeout(timeoutMs);
    const res = (await fetchFn(url, {
      ...init,
      headers: { ...headers(), ...init.headers },
      signal,
    })) as Response;

    let body: unknown = {};
    try {
      body = await res.json();
    } catch (jsonErr) {
      // 204 No Content and some 4xx bodies are empty; fall back to {} so
      // translateError still produces a typed error from the status code.
      // Surface any non-parse errors via console.warn so real failures are
      // still visible — we never bubble raw server text to callers (spec §J).
      if (!(jsonErr instanceof SyntaxError)) {
        console.warn('matrix-client: unexpected body read error', {
          status: (res as { status?: number }).status,
          error: (jsonErr as Error)?.message ?? 'unknown',
        });
      }
    }

    if (!res.ok) {
      throw translateError(res, body as Record<string, unknown>);
    }
    return body;
  }

  async function matrixFetchRaw(
    path: string,
    init: RequestInit & { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    return matrixFetch(path, init);
  }

  return {
    async sendMessage(roomId, body) {
      const txnId = randomUUID();
      const result = (await matrixFetch(
        `/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${txnId}`,
        {
          method: 'PUT',
          body: JSON.stringify({ msgtype: 'm.text', body }),
        },
      )) as { event_id: string };
      return { eventId: result.event_id };
    },

    async createDM(userId) {
      const result = (await matrixFetch('/_matrix/client/v3/createRoom', {
        method: 'POST',
        body: JSON.stringify({
          invite: [userId],
          is_direct: true,
          preset: 'trusted_private_chat',
        }),
      })) as { room_id: string };
      return { roomId: result.room_id };
    },

    async joinRoom(roomId) {
      const result = (await matrixFetch(`/_matrix/client/v3/join/${roomId}`, {
        method: 'POST',
        body: JSON.stringify({}),
      })) as { room_id: string };
      return { roomId: result.room_id };
    },

    async getRoomMessages(roomId, options) {
      const params = new URLSearchParams({ dir: options?.dir ?? 'b' });
      if (options?.limit) params.set('limit', String(options.limit));
      if (options?.from) params.set('from', options.from);

      const result = (await matrixFetch(
        `/_matrix/client/v3/rooms/${roomId}/messages?${params}`,
        { method: 'GET' },
      )) as {
        chunk: MatrixRawEvent[];
        end: string;
      };

      return {
        messages: result.chunk.map((ev) => {
          const content = (ev.content ?? {}) as { msgtype?: string; body?: string };
          return {
            eventId: ev.event_id ?? '',
            sender: ev.sender ?? '',
            body: content.body ?? '',
            type: content.msgtype ?? 'unknown',
            timestamp: ev.origin_server_ts ?? 0,
          } satisfies MatrixMessage;
        }),
        end: result.end,
        chunk: result.chunk,
      };
    },

    async whoami() {
      const result = (await matrixFetch('/_matrix/client/v3/account/whoami', {
        method: 'GET',
      })) as { user_id: string };
      return { userId: result.user_id };
    },

    async sendCustomEvent(roomId, eventType, content) {
      // Preflight content-size check so callers see a typed error before we
      // burn a network round-trip (spike §9.4, M_INVALID_PARAM at ~65 000 B).
      const json = JSON.stringify(content);
      const byteLength = Buffer.byteLength(json, 'utf8');
      if (byteLength > MATRIX_EVENT_CONTENT_MAX_BYTES) {
        throw new MatrixContentTooLargeError(
          `content serialization is ${byteLength} bytes (cap ${MATRIX_EVENT_CONTENT_MAX_BYTES})`,
          byteLength,
          MATRIX_EVENT_CONTENT_MAX_BYTES,
        );
      }

      const txnId = randomUUID();
      const result = (await matrixFetch(
        `/_matrix/client/v3/rooms/${roomId}/send/${eventType}/${txnId}`,
        {
          method: 'PUT',
          body: json,
        },
      )) as { event_id: string };
      return { eventId: result.event_id };
    },

    async sync({ since, timeoutMs, filter }) {
      const effectiveTimeout = timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
      const params = new URLSearchParams();
      params.set('timeout', String(effectiveTimeout));
      if (since) params.set('since', since);
      if (filter) params.set('filter', filter);

      // Give the server its full long-poll window plus a small client-side slack.
      const clientTimeoutMs = effectiveTimeout + SYNC_CLIENT_SLACK_MS;
      const raw = (await matrixFetch(`/_matrix/client/v3/sync?${params}`, {
        method: 'GET',
        timeoutMs: clientTimeoutMs,
      })) as Partial<MatrixSyncResponse> & { next_batch?: string };

      return normalizeSyncResponse(raw);
    },

    async createRoom(input) {
      const body: Record<string, unknown> = {};
      if (input.name !== undefined) body.name = input.name;
      if (input.invite !== undefined) body.invite = input.invite;
      if (input.preset !== undefined) body.preset = input.preset;
      if (input.powerLevelContentOverride !== undefined) {
        body.power_level_content_override = input.powerLevelContentOverride;
      }
      if (input.initialState !== undefined) {
        body.initial_state = input.initialState;
      }

      const result = (await matrixFetch('/_matrix/client/v3/createRoom', {
        method: 'POST',
        body: JSON.stringify(body),
      })) as { room_id: string };
      return { roomId: result.room_id };
    },

    async inviteToRoom(roomId, userId) {
      await matrixFetch(
        `/_matrix/client/v3/rooms/${roomId}/invite`,
        {
          method: 'POST',
          body: JSON.stringify({ user_id: userId }),
        },
      );
    },

    async kickFromRoom(roomId, userId, reason) {
      const payload: Record<string, unknown> = { user_id: userId };
      if (reason !== undefined) payload.reason = reason;
      await matrixFetch(
        `/_matrix/client/v3/rooms/${roomId}/kick`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      );
    },

    async leaveRoom(roomId) {
      await matrixFetch(
        `/_matrix/client/v3/rooms/${roomId}/leave`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        },
      );
    },

    async getRoomState(roomId, eventType, stateKey) {
      try {
        const result = (await matrixFetch(
          `/_matrix/client/v3/rooms/${roomId}/state/${eventType}/${encodeURIComponent(stateKey)}`,
          { method: 'GET' },
        )) as Record<string, unknown>;
        return result;
      } catch (err) {
        if (err instanceof MatrixNotFoundError) {
          return null;
        }
        throw err;
      }
    },

    async getAllRoomStateEvents(roomId, eventType) {
      const raw = (await matrixFetchRaw(
        `/_matrix/client/v3/rooms/${roomId}/state`,
        { method: 'GET' },
      )) as RoomStateEvent[];
      if (!Array.isArray(raw)) {
        return [];
      }
      if (eventType !== undefined) {
        return raw.filter((ev) => ev.type === eventType);
      }
      return raw;
    },

    async setRoomState(roomId, eventType, stateKey, content) {
      const result = (await matrixFetch(
        `/_matrix/client/v3/rooms/${roomId}/state/${eventType}/${encodeURIComponent(stateKey)}`,
        {
          method: 'PUT',
          body: JSON.stringify(content),
        },
      )) as { event_id: string };
      return { eventId: result.event_id };
    },

    async getRoomMembers(roomId) {
      const events = await this.getAllRoomStateEvents(roomId, 'm.room.member');
      const members: RoomMember[] = [];
      for (const ev of events) {
        const content = (ev.content ?? {}) as {
          membership?: string;
          displayname?: string;
        };
        const membership = content.membership;
        if (
          membership !== 'join' &&
          membership !== 'invite' &&
          membership !== 'leave' &&
          membership !== 'ban' &&
          membership !== 'knock'
        ) {
          continue;
        }
        members.push({
          userId: ev.state_key,
          membership,
          displayName: content.displayname,
        });
      }
      return members;
    },

    async getPowerLevels(roomId) {
      const content = await this.getRoomState(roomId, 'm.room.power_levels', '');
      return (content ?? {}) as PowerLevelsContent;
    },

    async setPowerLevels(roomId, content) {
      return this.setRoomState(
        roomId,
        'm.room.power_levels',
        '',
        content as unknown as Record<string, unknown>,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Error translation — map Matrix `errcode` / HTTP status into typed errors.
// Never embed the server body in the public message (spec §J).
// ---------------------------------------------------------------------------

function translateError(
  res: { status: number; headers: { get(name: string): string | null } },
  body: Record<string, unknown>,
): Error {
  const errcode = typeof body.errcode === 'string' ? body.errcode : 'M_UNKNOWN';

  if (res.status === 429 || errcode === 'M_LIMIT_EXCEEDED') {
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), body);
    return new MatrixRateLimitError(errcode, retryAfterMs);
  }
  if (res.status === 403 || errcode === 'M_FORBIDDEN') {
    return new MatrixForbiddenError(errcode);
  }
  if (res.status === 404 || errcode === 'M_NOT_FOUND') {
    return new MatrixNotFoundError(errcode);
  }
  return new MatrixUnknownError(errcode);
}

function parseRetryAfterMs(
  header: string | null,
  body: Record<string, unknown>,
): number {
  const fromBody = body.retry_after_ms;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) {
    return fromBody;
  }
  if (header !== null) {
    const asSeconds = Number(header);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      return Math.round(asSeconds * 1000);
    }
  }
  return 1000;
}

function normalizeSyncResponse(
  raw: Partial<MatrixSyncResponse> & { next_batch?: string },
): MatrixSyncResponse {
  return {
    next_batch: raw.next_batch ?? '',
    rooms: {
      join: raw.rooms?.join ?? {},
      invite: raw.rooms?.invite ?? {},
      leave: raw.rooms?.leave ?? {},
    },
    presence: { events: raw.presence?.events ?? [] },
    account_data: { events: raw.account_data?.events ?? [] },
  };
}
