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

export interface MatrixClient {
  sendMessage(roomId: string, body: string): Promise<{ eventId: string }>;
  createDM(userId: string): Promise<{ roomId: string }>;
  joinRoom(roomId: string): Promise<{ roomId: string }>;
  getRoomMessages(
    roomId: string,
    options?: { limit?: number; from?: string },
  ): Promise<{ messages: MatrixMessage[]; end: string }>;
  whoami(): Promise<{ userId: string }>;
  sendCustomEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<{ eventId: string }>;
}

export function createMatrixClient(config: MatrixClientConfig): MatrixClient {
  const { homeserverUrl, accessToken } = config;
  const fetchFn = config.fetch ?? globalThis.fetch;

  function headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  async function matrixFetch(path: string, init?: RequestInit): Promise<unknown> {
    const url = `${homeserverUrl}${path}`;
    const res = await fetchFn(url, { ...init, headers: { ...headers(), ...init?.headers } });
    const body = await res.json();
    if (!res.ok) {
      const errcode = (body as { errcode?: string }).errcode ?? 'M_UNKNOWN';
      throw new Error(errcode);
    }
    return body;
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
      const params = new URLSearchParams({ dir: 'b' });
      if (options?.limit) params.set('limit', String(options.limit));
      if (options?.from) params.set('from', options.from);

      const result = (await matrixFetch(
        `/_matrix/client/v3/rooms/${roomId}/messages?${params}`,
        { method: 'GET' },
      )) as {
        chunk: Array<{
          event_id: string;
          sender: string;
          content: { msgtype?: string; body?: string };
          origin_server_ts: number;
        }>;
        end: string;
      };

      return {
        messages: result.chunk.map((ev) => ({
          eventId: ev.event_id,
          sender: ev.sender,
          body: ev.content.body ?? '',
          type: ev.content.msgtype ?? 'unknown',
          timestamp: ev.origin_server_ts,
        })),
        end: result.end,
      };
    },

    async whoami() {
      const result = (await matrixFetch('/_matrix/client/v3/account/whoami', {
        method: 'GET',
      })) as { user_id: string };
      return { userId: result.user_id };
    },

    async sendCustomEvent(roomId, eventType, content) {
      const txnId = randomUUID();
      const result = (await matrixFetch(
        `/_matrix/client/v3/rooms/${roomId}/send/${eventType}/${txnId}`,
        {
          method: 'PUT',
          body: JSON.stringify(content),
        },
      )) as { event_id: string };
      return { eventId: result.event_id };
    },
  };
}
