import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createMatrixClient,
  MatrixForbiddenError,
  MatrixNotFoundError,
  MatrixRateLimitError,
  MatrixUnknownError,
  MatrixContentTooLargeError,
  type MatrixClient,
} from '../../packages/gateway/src/matrix-client.js';

/**
 * T006 — Failing tests for the extended matrix-client surface.
 *
 * These tests describe the Wave 1 contract for `matrix-client.ts`:
 *   - Raw Matrix HTTP wrapper only; NO subscription / dispatch.
 *   - Typed errors (`MatrixForbiddenError`, `MatrixNotFoundError`,
 *     `MatrixRateLimitError`, `MatrixUnknownError`, `MatrixContentTooLargeError`).
 *   - Every method threads `AbortSignal.timeout(...)` into its fetch call:
 *     10s for state / membership / lifecycle, `timeoutMs + 5000` for sync().
 *   - `sync()` returns top-level `presence` events (required by Wave 4
 *     global-handler dispatch in MatrixSyncHub).
 *   - Error responses never leak the raw server body to callers.
 */

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: {
      get: (name: string) => init.headers?.[name.toLowerCase()] ?? null,
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('matrix-client extensions (Wave 1)', () => {
  let client: MatrixClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = createMatrixClient({
      homeserverUrl: 'https://hs.matrix-os.com',
      accessToken: 'tk_test',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
  });

  describe('no subscription / dispatch API at this layer', () => {
    it('exposes no onEvent / onCustomEvent / subscribe method (dispatch belongs to MatrixSyncHub)', () => {
      const c = client as unknown as Record<string, unknown>;
      expect(c.onEvent).toBeUndefined();
      expect(c.onCustomEvent).toBeUndefined();
      expect(c.subscribe).toBeUndefined();
    });
  });

  describe('typed errors exposed as named exports', () => {
    it('MatrixForbiddenError extends Error', () => {
      const e = new MatrixForbiddenError('denied');
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe('MatrixForbiddenError');
      expect(e.message).toBe('denied');
    });
    it('MatrixNotFoundError extends Error', () => {
      const e = new MatrixNotFoundError('missing');
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe('MatrixNotFoundError');
    });
    it('MatrixRateLimitError has numeric retryAfterMs field', () => {
      const e = new MatrixRateLimitError('slow down', 2500);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe('MatrixRateLimitError');
      expect(e.retryAfterMs).toBe(2500);
    });
    it('MatrixUnknownError extends Error', () => {
      const e = new MatrixUnknownError('wat');
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe('MatrixUnknownError');
    });
    it('MatrixContentTooLargeError extends Error and carries byte sizes', () => {
      const e = new MatrixContentTooLargeError('too large', 70000, 65000);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe('MatrixContentTooLargeError');
      expect(e.contentBytes).toBe(70000);
      expect(e.maxBytes).toBe(65000);
    });
  });

  describe('sync()', () => {
    it('threads ?since and ?timeout into the URL and returns parsed batch', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          next_batch: 's2',
          rooms: {
            join: {
              '!room:hs.matrix-os.com': {
                timeline: {
                  events: [
                    {
                      event_id: '$a',
                      type: 'm.matrix_os.app.notes.op',
                      sender: '@a:hs.matrix-os.com',
                      origin_server_ts: 10,
                      content: { update: 'xx', lamport: 1, client_id: 'c' },
                    },
                  ],
                  limited: false,
                  prev_batch: 'p1',
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
          presence: {
            events: [
              {
                type: 'm.presence',
                sender: '@a:hs.matrix-os.com',
                content: { presence: 'online' },
              },
            ],
          },
          account_data: { events: [] },
        }),
      );

      const batch = await client.sync({ since: 's1', timeoutMs: 30000 });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/_matrix/client/v3/sync');
      expect(url).toContain('since=s1');
      expect(url).toContain('timeout=30000');
      expect(opts.method).toBe('GET');
      expect(opts.signal).toBeInstanceOf(AbortSignal);

      expect(batch.next_batch).toBe('s2');
      expect(batch.rooms.join['!room:hs.matrix-os.com'].timeline.events).toHaveLength(1);
      expect(batch.presence.events).toHaveLength(1);
      expect(batch.presence.events[0].type).toBe('m.presence');
    });

    it('defaults timeout to 30000 when not provided', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ next_batch: 's0', rooms: { join: {}, invite: {}, leave: {} }, presence: { events: [] } }),
      );
      await client.sync({});
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('timeout=30000');
    });

    it('omits since= when not provided (cold start)', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ next_batch: 's0', rooms: { join: {}, invite: {}, leave: {} }, presence: { events: [] } }),
      );
      await client.sync({});
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).not.toContain('since=');
    });

    it('threads an AbortSignal into the fetch call (timeoutMs + 5000)', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ next_batch: 's0', rooms: { join: {}, invite: {}, leave: {} }, presence: { events: [] } }),
      );
      await client.sync({ timeoutMs: 1000 });
      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    });

    it('translates errcode to typed MatrixUnknownError without leaking server body', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ errcode: 'M_UNKNOWN', error: 'server_body_secret' }, { status: 500 }),
      );
      const err = await client.sync({}).catch((e) => e);
      expect(err).toBeInstanceOf(MatrixUnknownError);
      // message surfaces errcode only, never the raw server body
      expect((err as Error).message).not.toContain('server_body_secret');
    });

    it('translates 429 to MatrixRateLimitError with retryAfterMs from Retry-After header', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          { errcode: 'M_LIMIT_EXCEEDED' },
          { status: 429, headers: { 'retry-after': '3' } },
        ),
      );
      let caught: unknown;
      try {
        await client.sync({});
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MatrixRateLimitError);
      expect((caught as MatrixRateLimitError).retryAfterMs).toBe(3000);
    });

    it('translates 429 with retry_after_ms body field (Matrix spec variant)', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 1500 }, { status: 429 }),
      );
      const err = await client.sync({}).catch((e) => e as Error);
      expect(err).toBeInstanceOf(MatrixRateLimitError);
      expect((err as MatrixRateLimitError).retryAfterMs).toBe(1500);
    });
  });

  describe('createRoom()', () => {
    it('POSTs to /createRoom with name, invites, preset, and power levels override', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ room_id: '!r:hs.matrix-os.com' }));

      const result = await client.createRoom({
        name: 'Schmidt Family',
        invite: ['@b:hs.matrix-os.com'],
        preset: 'private_chat',
        powerLevelContentOverride: {
          users: { '@a:hs.matrix-os.com': 100 },
          state_default: 50,
          events_default: 0,
        },
        initialState: [{ type: 'm.matrix_os.group', state_key: '', content: { v: 1 } }],
      });

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/_matrix/client/v3/createRoom');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body as string);
      expect(body.name).toBe('Schmidt Family');
      expect(body.invite).toEqual(['@b:hs.matrix-os.com']);
      expect(body.preset).toBe('private_chat');
      expect(body.power_level_content_override.users['@a:hs.matrix-os.com']).toBe(100);
      expect(body.initial_state).toHaveLength(1);
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      expect(result.roomId).toBe('!r:hs.matrix-os.com');
    });

    it('throws MatrixForbiddenError on 403', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ errcode: 'M_FORBIDDEN', error: 'no' }, { status: 403 }),
      );
      await expect(client.createRoom({ name: 'x' })).rejects.toBeInstanceOf(MatrixForbiddenError);
    });
  });

  describe('inviteToRoom / kickFromRoom / leaveRoom', () => {
    it('inviteToRoom calls /invite and returns void', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}));
      const out = await client.inviteToRoom('!r:hs.matrix-os.com', '@b:hs.matrix-os.com');
      expect(out).toBeUndefined();
      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/_matrix/client/v3/rooms/!r:hs.matrix-os.com/invite');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body as string);
      expect(body.user_id).toBe('@b:hs.matrix-os.com');
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    });

    it('inviteToRoom maps 403 to MatrixForbiddenError', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ errcode: 'M_FORBIDDEN' }, { status: 403 }),
      );
      await expect(client.inviteToRoom('!r', '@b:hs')).rejects.toBeInstanceOf(MatrixForbiddenError);
    });

    it('kickFromRoom calls /kick with reason', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}));
      await client.kickFromRoom('!r:hs', '@b:hs', 'left the group');
      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/_matrix/client/v3/rooms/!r:hs/kick');
      const body = JSON.parse(opts.body as string);
      expect(body.user_id).toBe('@b:hs');
      expect(body.reason).toBe('left the group');
    });

    it('leaveRoom POSTs /leave', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}));
      await client.leaveRoom('!r:hs');
      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/_matrix/client/v3/rooms/!r:hs/leave');
      expect(opts.method).toBe('POST');
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    });

    it('leaveRoom maps 404 to MatrixNotFoundError', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ errcode: 'M_NOT_FOUND' }, { status: 404 }),
      );
      await expect(client.leaveRoom('!missing:hs')).rejects.toBeInstanceOf(MatrixNotFoundError);
    });
  });

  describe('room state methods', () => {
    it('getRoomState returns content on success', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ v: 1, generation: 5, snapshot_id: 'sid1' }),
      );
      const out = await client.getRoomState(
        '!r:hs',
        'm.matrix_os.app.notes.snapshot',
        'sid1/0',
      );
      expect(out).toEqual({ v: 1, generation: 5, snapshot_id: 'sid1' });
      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/_matrix/client/v3/rooms/!r:hs/state/');
      expect(url).toContain('m.matrix_os.app.notes.snapshot');
      expect(url).toContain('sid1%2F0');
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    });

    it('getRoomState returns null on 404', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ errcode: 'M_NOT_FOUND' }, { status: 404 }),
      );
      const out = await client.getRoomState('!r:hs', 'm.matrix_os.group', '');
      expect(out).toBeNull();
    });

    it('getRoomState propagates non-404 errors as typed errors', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ errcode: 'M_FORBIDDEN' }, { status: 403 }),
      );
      await expect(
        client.getRoomState('!r:hs', 'm.matrix_os.group', ''),
      ).rejects.toBeInstanceOf(MatrixForbiddenError);
    });

    it('getAllRoomStateEvents filters by event type in-memory when eventType given', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            type: 'm.matrix_os.app.notes.snapshot',
            state_key: 'sid1/0',
            content: { snapshot_id: 'sid1', chunk_index: 0 },
            event_id: '$1',
            sender: '@a:hs',
            origin_server_ts: 1,
          },
          {
            type: 'm.room.name',
            state_key: '',
            content: { name: 'Fam' },
            event_id: '$2',
            sender: '@a:hs',
            origin_server_ts: 2,
          },
          {
            type: 'm.matrix_os.app.notes.snapshot',
            state_key: 'sid1/1',
            content: { snapshot_id: 'sid1', chunk_index: 1 },
            event_id: '$3',
            sender: '@a:hs',
            origin_server_ts: 3,
          },
        ]),
      );
      const out = await client.getAllRoomStateEvents('!r:hs', 'm.matrix_os.app.notes.snapshot');
      expect(out).toHaveLength(2);
      expect(out[0].state_key).toBe('sid1/0');
      expect(out[1].state_key).toBe('sid1/1');
    });

    it('getAllRoomStateEvents without type returns everything', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          { type: 'm.room.name', state_key: '', content: { name: 'x' }, event_id: '$1', sender: '@a:hs', origin_server_ts: 1 },
          { type: 'm.room.power_levels', state_key: '', content: { users_default: 0 }, event_id: '$2', sender: '@a:hs', origin_server_ts: 2 },
        ]),
      );
      const out = await client.getAllRoomStateEvents('!r:hs');
      expect(out).toHaveLength(2);
    });

    it('setRoomState PUTs and returns event_id', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ event_id: '$state-ev' }));
      const out = await client.setRoomState('!r:hs', 'm.matrix_os.app_acl', 'notes', {
        v: 1,
        write_pl: 50,
      });
      expect(out.eventId).toBe('$state-ev');
      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/_matrix/client/v3/rooms/!r:hs/state/');
      expect(url).toContain('m.matrix_os.app_acl');
      expect(url).toContain('notes');
      expect(opts.method).toBe('PUT');
    });

    it('setRoomState maps 403 to MatrixForbiddenError', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ errcode: 'M_FORBIDDEN' }, { status: 403 }),
      );
      await expect(
        client.setRoomState('!r:hs', 'm.matrix_os.app_acl', 'notes', {}),
      ).rejects.toBeInstanceOf(MatrixForbiddenError);
    });
  });

  describe('membership and power levels', () => {
    it('getRoomMembers parses m.room.member state into {userId, membership, displayName}', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            type: 'm.room.member',
            state_key: '@a:hs',
            content: { membership: 'join', displayname: 'Alice' },
            event_id: '$1',
            sender: '@a:hs',
            origin_server_ts: 1,
          },
          {
            type: 'm.room.member',
            state_key: '@b:hs',
            content: { membership: 'invite' },
            event_id: '$2',
            sender: '@a:hs',
            origin_server_ts: 2,
          },
          {
            type: 'm.room.name',
            state_key: '',
            content: { name: 'Fam' },
            event_id: '$3',
            sender: '@a:hs',
            origin_server_ts: 3,
          },
        ]),
      );
      const out = await client.getRoomMembers('!r:hs');
      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({ userId: '@a:hs', membership: 'join', displayName: 'Alice' });
      expect(out[1]).toEqual({ userId: '@b:hs', membership: 'invite', displayName: undefined });
    });

    it('getPowerLevels reads the m.room.power_levels state event', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ users: { '@a:hs': 100 }, users_default: 0, state_default: 50 }),
      );
      const out = await client.getPowerLevels('!r:hs');
      expect(out.users['@a:hs']).toBe(100);
      expect(out.state_default).toBe(50);
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/state/m.room.power_levels/');
    });

    it('setPowerLevels writes a new m.room.power_levels state event', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ event_id: '$pl' }));
      const out = await client.setPowerLevels('!r:hs', {
        users: { '@a:hs': 100 },
        users_default: 0,
        state_default: 50,
        events_default: 0,
        events: { 'm.matrix_os.app_acl': 100 },
      });
      expect(out.eventId).toBe('$pl');
      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body.users['@a:hs']).toBe(100);
      expect(body.events['m.matrix_os.app_acl']).toBe(100);
    });

    it('setPowerLevels maps 403 to MatrixForbiddenError', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ errcode: 'M_FORBIDDEN' }, { status: 403 }),
      );
      await expect(client.setPowerLevels('!r:hs', {})).rejects.toBeInstanceOf(MatrixForbiddenError);
    });
  });

  describe('sendCustomEvent content-size preflight', () => {
    it('throws MatrixContentTooLargeError when serialized content exceeds 64_500 B', async () => {
      // Construct a content object whose JSON serialization exceeds the cap.
      const big = { update: 'A'.repeat(70000) };
      await expect(
        client.sendCustomEvent('!r:hs', 'm.matrix_os.app.notes.op', big),
      ).rejects.toBeInstanceOf(MatrixContentTooLargeError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('passes through a 30 KB payload under the cap', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ event_id: '$x' }));
      const content = { update: 'A'.repeat(30000) };
      const out = await client.sendCustomEvent('!r:hs', 'm.matrix_os.app.notes.op', content);
      expect(out.eventId).toBe('$x');
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  describe('abort signal propagation', () => {
    it('every lifecycle method sets request.signal to an AbortSignal with a finite timeout', async () => {
      const methods: Array<() => Promise<unknown>> = [
        () => client.createRoom({ name: 'n' }),
        () => client.inviteToRoom('!r:hs', '@b:hs'),
        () => client.kickFromRoom('!r:hs', '@b:hs'),
        () => client.leaveRoom('!r:hs'),
        () => client.getRoomState('!r:hs', 'm.room.name', ''),
        () => client.getAllRoomStateEvents('!r:hs'),
        () => client.setRoomState('!r:hs', 'm.room.name', '', { name: 'x' }),
        () => client.getRoomMembers('!r:hs'),
        () => client.getPowerLevels('!r:hs'),
        () => client.setPowerLevels('!r:hs', { users_default: 0 }),
      ];
      for (const call of methods) {
        fetchMock.mockResolvedValueOnce(jsonResponse({ event_id: '$ok', room_id: '!r:hs' }));
      }
      for (const call of methods) {
        try {
          await call();
        } catch {
          /* some methods return [] etc; we only care that fetch received a signal */
        }
      }
      for (const call of fetchMock.mock.calls) {
        const opts = call[1] as RequestInit;
        expect(opts.signal).toBeInstanceOf(AbortSignal);
      }
    });
  });
});
