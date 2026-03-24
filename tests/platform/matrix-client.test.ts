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

  describe('config.fetch fallback', () => {
    it('uses globalThis.fetch when fetch is not provided', () => {
      const clientNoFetch = createMatrixClient({
        homeserverUrl: 'https://matrix.matrix-os.com',
        accessToken: 'test-token',
      });
      expect(clientNoFetch).toBeDefined();
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

  describe('sendMessage error without errcode', () => {
    it('throws M_UNKNOWN when errcode is missing from error response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Internal Server Error' }),
      });

      await expect(client.sendMessage('!room:matrix-os.com', 'Hello')).rejects.toThrow('M_UNKNOWN');
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

  describe('createDM error', () => {
    it('throws on failed createDM', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ errcode: 'M_FORBIDDEN', error: 'Not allowed' }),
      });

      await expect(client.createDM('@bob:matrix-os.com')).rejects.toThrow('M_FORBIDDEN');
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

  describe('joinRoom error', () => {
    it('throws on failed joinRoom', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ errcode: 'M_NOT_FOUND', error: 'Room not found' }),
      });

      await expect(client.joinRoom('!bad:matrix-os.com')).rejects.toThrow('M_NOT_FOUND');
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

  describe('getRoomMessages optional params', () => {
    it('fetches without limit or from (no options)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          chunk: [],
          end: 'token_end',
        }),
      });

      const result = await client.getRoomMessages('!room:matrix-os.com');

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('dir=b');
      expect(url).not.toContain('limit=');
      expect(url).not.toContain('from=');
      expect(result.messages).toHaveLength(0);
    });

    it('includes from parameter when provided', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          chunk: [],
          end: 'token_next',
        }),
      });

      await client.getRoomMessages('!room:matrix-os.com', { from: 'token_abc' });

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('from=token_abc');
    });

    it('handles messages with missing body and msgtype', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          chunk: [
            {
              event_id: '$ev1',
              sender: '@alice:matrix-os.com',
              content: {},
              origin_server_ts: 1700000000000,
            },
          ],
          end: 'token_end',
        }),
      });

      const result = await client.getRoomMessages('!room:matrix-os.com');

      expect(result.messages[0].body).toBe('');
      expect(result.messages[0].type).toBe('unknown');
    });

    it('throws on error response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ errcode: 'M_FORBIDDEN', error: 'Access denied' }),
      });

      await expect(client.getRoomMessages('!room:matrix-os.com')).rejects.toThrow('M_FORBIDDEN');
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

  describe('whoami error', () => {
    it('throws on error response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ errcode: 'M_UNKNOWN_TOKEN', error: 'Expired token' }),
      });

      await expect(client.whoami()).rejects.toThrow('M_UNKNOWN_TOKEN');
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

  describe('sendCustomEvent error', () => {
    it('throws on error response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ errcode: 'M_FORBIDDEN', error: 'Not in room' }),
      });

      await expect(
        client.sendCustomEvent('!room:matrix-os.com', 'm.custom', { data: 1 }),
      ).rejects.toThrow('M_FORBIDDEN');
    });
  });
});
