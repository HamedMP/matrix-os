import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createMatrixClient,
  type MatrixClient,
  type MatrixClientConfig,
} from '../../packages/gateway/src/matrix-client.js';

describe('gateway/matrix-client', () => {
  let client: MatrixClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = createMatrixClient({
      homeserverUrl: 'https://matrix.matrix-os.com',
      accessToken: 'test-token-123',
      fetch: fetchMock,
    });
  });

  describe('sendMessage', () => {
    it('sends a text message to a room', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ event_id: '$event123' }),
      });

      const result = await client.sendMessage('!room:matrix-os.com', 'Hello world');

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('/_matrix/client/v3/rooms/!room:matrix-os.com/send/m.room.message/');
      expect(opts.method).toBe('PUT');
      expect(opts.headers['Authorization']).toBe('Bearer test-token-123');
      const body = JSON.parse(opts.body);
      expect(body.msgtype).toBe('m.text');
      expect(body.body).toBe('Hello world');
      expect(result.eventId).toBe('$event123');
    });

    it('throws on failed send', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ errcode: 'M_FORBIDDEN', error: 'Not in room' }),
      });

      await expect(client.sendMessage('!room:matrix-os.com', 'Hello')).rejects.toThrow('M_FORBIDDEN');
    });
  });

  describe('createDM', () => {
    it('creates a direct message room with another user', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ room_id: '!newroom:matrix-os.com' }),
      });

      const result = await client.createDM('@alice:matrix-os.com');

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('/_matrix/client/v3/createRoom');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      expect(body.invite).toContain('@alice:matrix-os.com');
      expect(body.is_direct).toBe(true);
      expect(result.roomId).toBe('!newroom:matrix-os.com');
    });
  });

  describe('joinRoom', () => {
    it('joins an existing room', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ room_id: '!room:matrix-os.com' }),
      });

      const result = await client.joinRoom('!room:matrix-os.com');

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('/_matrix/client/v3/join/!room:matrix-os.com');
      expect(opts.method).toBe('POST');
      expect(result.roomId).toBe('!room:matrix-os.com');
    });
  });

  describe('getRoomMessages', () => {
    it('fetches messages from a room', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          chunk: [
            {
              event_id: '$ev1',
              sender: '@alice:matrix-os.com',
              content: { msgtype: 'm.text', body: 'Hello' },
              origin_server_ts: 1700000000000,
            },
          ],
          end: 'token_end',
        }),
      });

      const result = await client.getRoomMessages('!room:matrix-os.com', { limit: 10 });

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('/_matrix/client/v3/rooms/!room:matrix-os.com/messages');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].sender).toBe('@alice:matrix-os.com');
      expect(result.messages[0].body).toBe('Hello');
      expect(result.end).toBe('token_end');
    });
  });

  describe('whoami', () => {
    it('returns current user info', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user_id: '@hamed:matrix-os.com' }),
      });

      const result = await client.whoami();
      expect(result.userId).toBe('@hamed:matrix-os.com');

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('/_matrix/client/v3/account/whoami');
    });
  });

  describe('sendCustomEvent', () => {
    it('sends a custom event type for AI-to-AI messaging', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ event_id: '$aievent1' }),
      });

      const result = await client.sendCustomEvent(
        '!room:matrix-os.com',
        'm.matrix_os.ai_request',
        { query: 'What is the weather?', context: {} },
      );

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('/_matrix/client/v3/rooms/!room:matrix-os.com/send/m.matrix_os.ai_request/');
      expect(opts.method).toBe('PUT');
      const body = JSON.parse(opts.body);
      expect(body.query).toBe('What is the weather?');
      expect(result.eventId).toBe('$aievent1');
    });
  });
});
