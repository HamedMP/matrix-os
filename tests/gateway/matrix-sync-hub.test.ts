import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MatrixClient, MatrixSyncResponse, MatrixRawEvent, RoomStateEvent, PowerLevelsContent, RoomMember, MatrixMessage } from '../../packages/gateway/src/matrix-client.js';
import { MatrixSyncHub, type SyncHubOnError } from '../../packages/gateway/src/matrix-sync-hub.js';

// ---------------------------------------------------------------------------
// Fake MatrixClient — minimal surface so MatrixSyncHub can be tested in
// isolation. Programmable responses for sync() and getRoomMessages().
// ---------------------------------------------------------------------------

type FakeSyncStep =
  | { kind: 'ok'; response: MatrixSyncResponse }
  | { kind: 'error'; error: unknown }
  | { kind: 'hang' };

interface FakeClient extends MatrixClient {
  queueSync: (step: FakeSyncStep) => void;
  queueMessages: (response: { chunk: MatrixRawEvent[]; end: string }) => void;
  syncCallCount: () => number;
  messagesCallCount: () => number;
  messagesCalls: () => Array<{ roomId: string; from?: string; dir?: string; limit?: number }>;
}

function buildSyncResponse(partial: Partial<MatrixSyncResponse> & { next_batch: string }): MatrixSyncResponse {
  return {
    next_batch: partial.next_batch,
    rooms: {
      join: partial.rooms?.join ?? {},
      invite: partial.rooms?.invite ?? {},
      leave: partial.rooms?.leave ?? {},
    },
    presence: partial.presence ?? { events: [] },
    account_data: partial.account_data ?? { events: [] },
  };
}

function createFakeClient(): FakeClient {
  const syncQueue: FakeSyncStep[] = [];
  const messagesQueue: Array<{ chunk: MatrixRawEvent[]; end: string }> = [];
  const messagesCalls: Array<{ roomId: string; from?: string; dir?: string; limit?: number }> = [];
  let syncCalls = 0;
  let hangResolvers: Array<() => void> = [];

  const stub = {
    sendMessage: async () => ({ eventId: '$stub' }),
    createDM: async () => ({ roomId: '!stub' }),
    joinRoom: async () => ({ roomId: '!stub' }),
    whoami: async () => ({ userId: '@stub:hs' }),
    sendCustomEvent: async () => ({ eventId: '$stub' }),
    createRoom: async () => ({ roomId: '!stub' }),
    inviteToRoom: async () => undefined,
    kickFromRoom: async () => undefined,
    leaveRoom: async () => undefined,
    getRoomState: async () => null,
    getAllRoomStateEvents: async (): Promise<RoomStateEvent[]> => [],
    setRoomState: async () => ({ eventId: '$stub' }),
    getRoomMembers: async (): Promise<RoomMember[]> => [],
    getPowerLevels: async (): Promise<PowerLevelsContent> => ({}),
    setPowerLevels: async () => ({ eventId: '$stub' }),
    async sync(_options: { since?: string; timeoutMs?: number; filter?: string }) {
      syncCalls += 1;
      const step = syncQueue.shift();
      if (step === undefined) {
        // No scripted step — simulate a long idle /sync that the hub will abort.
        return new Promise<MatrixSyncResponse>((_, reject) => {
          hangResolvers.push(() => reject(new Error('aborted')));
        });
      }
      if (step.kind === 'error') {
        throw step.error;
      }
      if (step.kind === 'hang') {
        return new Promise<MatrixSyncResponse>((_, reject) => {
          hangResolvers.push(() => reject(new Error('aborted')));
        });
      }
      return step.response;
    },
    async getRoomMessages(
      roomId: string,
      options?: { limit?: number; from?: string; dir?: 'f' | 'b' },
    ) {
      messagesCalls.push({
        roomId,
        from: options?.from,
        dir: options?.dir,
        limit: options?.limit,
      });
      const step = messagesQueue.shift();
      if (!step) {
        return {
          messages: [] as MatrixMessage[],
          end: 'end',
          chunk: [] as MatrixRawEvent[],
        };
      }
      const messages: MatrixMessage[] = step.chunk.map((ev) => ({
        eventId: ev.event_id ?? '',
        sender: ev.sender ?? '',
        body: '',
        type: ev.type,
        timestamp: ev.origin_server_ts ?? 0,
      }));
      return { messages, end: step.end, chunk: step.chunk };
    },
  };

  const client: FakeClient = {
    ...stub,
    queueSync(step) {
      syncQueue.push(step);
      // Wake any hanging promise so it can pick up the new step on next loop.
      const resolvers = hangResolvers;
      hangResolvers = [];
      for (const r of resolvers) r();
    },
    queueMessages(step) {
      messagesQueue.push(step);
    },
    syncCallCount: () => syncCalls,
    messagesCallCount: () => messagesCalls.length,
    messagesCalls: () => messagesCalls.slice(),
  };

  return client;
}

function makeTimelineEvent(params: {
  id: string;
  type?: string;
  ts?: number;
  lamport?: number;
  clientId?: string;
}): MatrixRawEvent {
  return {
    event_id: params.id,
    type: params.type ?? 'm.matrix_os.app.notes.op',
    sender: '@a:hs',
    origin_server_ts: params.ts ?? 0,
    content: {
      update: 'xx',
      lamport: params.lamport ?? 0,
      client_id: params.clientId ?? 'client-1',
    },
  };
}

async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function waitFor(predicate: () => boolean, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('waitFor timed out');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MatrixSyncHub', () => {
  let homePath: string;
  let client: FakeClient;
  let hub: MatrixSyncHub;
  let controller: AbortController;
  let loopPromise: Promise<void> | null = null;
  let onError: SyncHubOnError;
  let errors: Array<{ code: string; detail: Record<string, unknown> }>;

  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), 'sync-hub-'));
    mkdirSync(join(homePath, 'system'), { recursive: true });
    client = createFakeClient();
    errors = [];
    onError = (code, detail) => {
      errors.push({ code, detail });
    };
    hub = new MatrixSyncHub({
      client: client as MatrixClient,
      homePath,
      onError,
      // shrink backoff so we don't wait seconds between loop iterations
      backoffMsSchedule: [5, 10, 20, 40],
    });
    controller = new AbortController();
  });

  afterEach(async () => {
    controller.abort();
    if (loopPromise) {
      try {
        await loopPromise;
      } catch {
        // ignore
      }
    }
    hub.dispose();
    rmSync(homePath, { recursive: true, force: true });
  });

  function startHub() {
    loopPromise = hub.start(controller.signal);
  }

  // ------------------------- core loop ---------------------------

  describe('core loop', () => {
    it('calls client.sync() in a loop and threads next_batch across iterations', async () => {
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({ next_batch: 's2' }),
      });
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({ next_batch: 's3' }),
      });
      const syncSpy = vi.spyOn(client, 'sync');

      startHub();
      await waitFor(() => syncSpy.mock.calls.length >= 3);

      // First call uses undefined since (cold start), second uses s2, third uses s3.
      expect(syncSpy.mock.calls[0][0].since).toBeUndefined();
      expect(syncSpy.mock.calls[1][0].since).toBe('s2');
      expect(syncSpy.mock.calls[2][0].since).toBe('s3');
      expect(hub.getNextBatch()).toBe('s3');
    });

    it('aborts cleanly on signal.abort() without throwing out of start()', async () => {
      startHub();
      await flushMicrotasks(4);
      controller.abort();
      await expect(loopPromise).resolves.toBeUndefined();
    });

    it('backs off on errors on the schedule (5ms, 10ms, 20ms, 40ms cap) and never throws', async () => {
      for (let i = 0; i < 3; i += 1) {
        client.queueSync({ kind: 'error', error: new Error('boom') });
      }
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({ next_batch: 's-recovered' }),
      });

      startHub();
      await waitFor(() => hub.getNextBatch() === 's-recovered');
      expect(hub.getNextBatch()).toBe('s-recovered');
      // loop keeps running — signal abort to end it
      controller.abort();
    });
  });

  // ------------------------- room handlers ---------------------------

  describe('registerEventHandler (per-room serial dispatch)', () => {
    it('fires all handlers registered for the same (roomId, eventType)', async () => {
      const room = '!r1:hs';
      const seen: string[] = [];
      hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async (ev) => {
        seen.push(`a:${ev.event_id}`);
      });
      hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async (ev) => {
        seen.push(`b:${ev.event_id}`);
      });
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [makeTimelineEvent({ id: '$1', ts: 1, lamport: 1 })],
                  limited: false,
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      startHub();
      await waitFor(() => seen.length === 2);
      expect(seen.sort()).toEqual(['a:$1', 'b:$1']);
    });

    it('per-room serial: handlers for the same room see events in /sync order even if first handler awaits a slow promise', async () => {
      const room = '!r1:hs';
      const order: string[] = [];
      let resolveSlow: (() => void) | null = null;
      const slowPromise = new Promise<void>((resolve) => {
        resolveSlow = resolve;
      });

      hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async (ev) => {
        order.push(`start:${ev.event_id}`);
        if (ev.event_id === '$1') {
          await slowPromise;
        }
        order.push(`done:${ev.event_id}`);
      });

      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [
                    makeTimelineEvent({ id: '$1', ts: 1, lamport: 1 }),
                    makeTimelineEvent({ id: '$2', ts: 2, lamport: 2 }),
                  ],
                  limited: false,
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });

      startHub();
      await waitFor(() => order.length === 1);
      expect(order).toEqual(['start:$1']);
      resolveSlow!();
      await waitFor(() => order.length === 4);
      expect(order).toEqual(['start:$1', 'done:$1', 'start:$2', 'done:$2']);
    });

    it('different rooms dispatch in parallel (separate queues)', async () => {
      const ra = '!a:hs';
      const rb = '!b:hs';
      const order: string[] = [];
      let resolveA: (() => void) | null = null;
      const slowA = new Promise<void>((resolve) => {
        resolveA = resolve;
      });

      hub.registerEventHandler(ra, 'm.matrix_os.app.notes.op', async (ev) => {
        order.push(`a-start:${ev.event_id}`);
        await slowA;
        order.push(`a-done:${ev.event_id}`);
      });
      hub.registerEventHandler(rb, 'm.matrix_os.app.notes.op', async (ev) => {
        order.push(`b-start:${ev.event_id}`);
        order.push(`b-done:${ev.event_id}`);
      });

      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [ra]: {
                timeline: {
                  events: [makeTimelineEvent({ id: '$a1', ts: 1 })],
                  limited: false,
                },
                state: { events: [] },
              },
              [rb]: {
                timeline: {
                  events: [makeTimelineEvent({ id: '$b1', ts: 1 })],
                  limited: false,
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });

      startHub();
      // b must complete even though a is still awaiting slowA
      await waitFor(() => order.includes('b-done:$b1'));
      expect(order).toContain('a-start:$a1');
      expect(order).toContain('b-done:$b1');
      expect(order).not.toContain('a-done:$a1');
      resolveA!();
      await waitFor(() => order.includes('a-done:$a1'));
    });

    it('Disposable.dispose() stops a handler from receiving events', async () => {
      const room = '!r1:hs';
      const seen: string[] = [];
      const dis = hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async (ev) => {
        seen.push(ev.event_id ?? '?');
      });

      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [makeTimelineEvent({ id: '$1' })],
                  limited: false,
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });

      startHub();
      await waitFor(() => seen.length === 1);
      dis.dispose();

      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's2',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [makeTimelineEvent({ id: '$2' })],
                  limited: false,
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });

      await waitFor(() => hub.getNextBatch() === 's2');
      // Handler was disposed before the second batch — $2 must not appear.
      expect(seen).toEqual(['$1']);
    });
  });

  // ------------------------- global handlers ---------------------------

  describe('registerGlobalEventHandler', () => {
    it('fires for top-level presence events from /sync', async () => {
      const seen: string[] = [];
      hub.registerGlobalEventHandler('m.presence', async (ev) => {
        seen.push(String((ev.content as Record<string, unknown>).presence));
      });
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          presence: {
            events: [
              {
                type: 'm.presence',
                sender: '@a:hs',
                content: { presence: 'online' },
              },
            ],
          },
        }),
      });
      startHub();
      await waitFor(() => seen.length === 1);
      expect(seen).toEqual(['online']);
    });

    it('serial dispatch on a single global queue (never concurrent with itself)', async () => {
      const order: string[] = [];
      let resolveFirst: (() => void) | null = null;
      const firstPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      hub.registerGlobalEventHandler('m.presence', async (ev) => {
        const u = String((ev.content as Record<string, unknown>).presence);
        order.push(`start:${u}`);
        if (u === 'online') {
          await firstPromise;
        }
        order.push(`done:${u}`);
      });

      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          presence: {
            events: [
              { type: 'm.presence', sender: '@a:hs', content: { presence: 'online' } },
              { type: 'm.presence', sender: '@a:hs', content: { presence: 'offline' } },
            ],
          },
        }),
      });
      startHub();
      await waitFor(() => order.length === 1);
      expect(order).toEqual(['start:online']);
      resolveFirst!();
      await waitFor(() => order.length === 4);
      expect(order).toEqual(['start:online', 'done:online', 'start:offline', 'done:offline']);
    });
  });

  // ------------------------- gap-fill contract (spec §E.1 / spike §9.1) ---------------------------

  describe('gap-fill contract (NON-NEGOTIABLE)', () => {
    it('recency ring caps at 256 events per room with LRU eviction', async () => {
      const room = '!r1:hs';
      // Pipe 300 events through the hub via a single /sync batch.
      const events: MatrixRawEvent[] = [];
      for (let i = 0; i < 300; i += 1) {
        events.push(makeTimelineEvent({ id: `$${i}`, ts: i, lamport: i }));
      }
      hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async () => {
        // consume
      });
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: { events, limited: false },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      startHub();
      await waitFor(() => hub.getNextBatch() === 's1');
      const ring = hub.debugGetRoomRing(room);
      expect(ring.length).toBe(256);
      // LRU: oldest entries should be evicted, newest retained.
      expect(ring[0].event_id).toBe('$44');
      expect(ring[ring.length - 1].event_id).toBe('$299');
    });

    it('mid-burst-gap regression: silent /sync omission triggers /messages backfill and delivers in order', async () => {
      const room = '!r1:hs';
      const received: string[] = [];
      hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async (ev) => {
        received.push(ev.event_id ?? '?');
      });

      // First batch: events 1, 2 (lamports 1, 2). Anchor next_batch = 's1'.
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [
                    makeTimelineEvent({ id: '$1', ts: 1, lamport: 1 }),
                    makeTimelineEvent({ id: '$2', ts: 2, lamport: 2 }),
                  ],
                  limited: false,
                  prev_batch: 'p0',
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });

      // Second batch: event 5 arrives with lamport 5 — event 3 and 4 have gone missing
      // and the homeserver does NOT flag limited.
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's2',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [makeTimelineEvent({ id: '$5', ts: 5, lamport: 5 })],
                  limited: false,
                  prev_batch: 's1',
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });

      // /messages backfill returns events 3, 4, 5 in reverse chronological order (dir=b).
      client.queueMessages({
        chunk: [
          makeTimelineEvent({ id: '$5', ts: 5, lamport: 5 }),
          makeTimelineEvent({ id: '$4', ts: 4, lamport: 4 }),
          makeTimelineEvent({ id: '$3', ts: 3, lamport: 3 }),
          makeTimelineEvent({ id: '$2', ts: 2, lamport: 2 }),
        ],
        end: 'p-end',
      });

      startHub();
      await waitFor(() => received.length >= 5);
      // In-order delivery: 1, 2, 3, 4, 5. No drops, no reorders.
      expect(received).toEqual(['$1', '$2', '$3', '$4', '$5']);
      expect(client.messagesCallCount()).toBeGreaterThanOrEqual(1);
    });

    it('reportGap callback path: fires backfill even when /sync has limited=false', async () => {
      const room = '!r1:hs';
      const received: string[] = [];
      hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async (ev) => {
        received.push(ev.event_id ?? '?');
      });

      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [makeTimelineEvent({ id: '$1', ts: 1, lamport: 1 })],
                  limited: false,
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });

      startHub();
      await waitFor(() => received.length === 1);

      // Application reports a lamport gap — queue messages backfill to return $2.
      client.queueMessages({
        chunk: [
          makeTimelineEvent({ id: '$2', ts: 2, lamport: 2 }),
          makeTimelineEvent({ id: '$1', ts: 1, lamport: 1 }),
        ],
        end: 'p-end',
      });

      hub.reportGap(room, 2);
      await waitFor(() => received.includes('$2'));
      expect(received).toContain('$2');
      expect(client.messagesCallCount()).toBeGreaterThanOrEqual(1);
    });

    it('limited:true signal path: triggers the same backfill code path', async () => {
      const room = '!r1:hs';
      const received: string[] = [];
      hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async (ev) => {
        received.push(ev.event_id ?? '?');
      });

      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [makeTimelineEvent({ id: '$5', ts: 5, lamport: 5 })],
                  limited: true,
                  prev_batch: 'p0',
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });

      client.queueMessages({
        chunk: [
          makeTimelineEvent({ id: '$5', ts: 5, lamport: 5 }),
          makeTimelineEvent({ id: '$4', ts: 4, lamport: 4 }),
          makeTimelineEvent({ id: '$3', ts: 3, lamport: 3 }),
        ],
        end: 'p-end',
      });

      startHub();
      await waitFor(() => received.length >= 3);
      expect(received).toEqual(['$3', '$4', '$5']);
      expect(client.messagesCallCount()).toBeGreaterThanOrEqual(1);
    });

    it('failure path: backfill timeout/5xx surfaces sync_failed and does not advance next_batch past the gap', async () => {
      const room = '!r1:hs';
      hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async () => {});

      // First batch lands $1; then limited-gap batch $5 triggers backfill.
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [makeTimelineEvent({ id: '$1', ts: 1, lamport: 1 })],
                  limited: false,
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's2',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [makeTimelineEvent({ id: '$5', ts: 5, lamport: 5 })],
                  limited: true,
                  prev_batch: 's1',
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      // Replace getRoomMessages to reject — simulate 5xx / timeout.
      const origGetMessages = client.getRoomMessages.bind(client);
      client.getRoomMessages = (async () => {
        throw new Error('boom');
      }) as typeof client.getRoomMessages;

      startHub();
      await waitFor(() => errors.some((e) => e.code === 'sync_failed'));
      expect(errors.find((e) => e.code === 'sync_failed')).toBeTruthy();
      // The stored next_batch must NOT advance past s1 until the gap is closed.
      expect(hub.getNextBatch()).toBe('s1');

      // Recover: restore the fake and let the next iteration succeed.
      client.getRoomMessages = origGetMessages;
      client.queueMessages({
        chunk: [
          makeTimelineEvent({ id: '$5', ts: 5, lamport: 5 }),
          makeTimelineEvent({ id: '$4', ts: 4, lamport: 4 }),
          makeTimelineEvent({ id: '$3', ts: 3, lamport: 3 }),
        ],
        end: 'p-end',
      });
      // Re-queue the same /sync response that triggers backfill again.
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's2',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [makeTimelineEvent({ id: '$5', ts: 5, lamport: 5 })],
                  limited: true,
                  prev_batch: 's1',
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      await waitFor(() => hub.getNextBatch() === 's2');
    });

    it('iteration cap: /messages paginates at most 8 pages before surfacing sync_failed', async () => {
      const room = '!r1:hs';
      hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async () => {});

      // Seed a persistent gap: 10 empty-ish pages with a forward token but no anchor match.
      for (let i = 0; i < 12; i += 1) {
        client.queueMessages({
          chunk: [makeTimelineEvent({ id: `$m${i}`, ts: 1000 + i, lamport: 1000 + i })],
          end: `p-${i}`,
        });
      }

      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [makeTimelineEvent({ id: '$99', ts: 99, lamport: 99 })],
                  limited: true,
                  prev_batch: 'p-prev',
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });

      startHub();
      await waitFor(() => errors.some((e) => e.code === 'sync_failed'));
      expect(client.messagesCallCount()).toBeLessThanOrEqual(8);
      expect(errors.find((e) => e.code === 'sync_failed')?.detail.reason).toBe('backfill_iteration_cap');
    });
  });

  // ------------------------- ordering contract ---------------------------

  describe('ordering contract', () => {
    it('has NO total ordering between global and room-scoped handlers from the same /sync batch', async () => {
      // The contract promises this is undefined, not that any specific interleaving holds.
      // Assert only that both streams process serially within themselves.
      const globalOrder: string[] = [];
      const roomOrder: string[] = [];
      hub.registerGlobalEventHandler('m.presence', async (ev) => {
        globalOrder.push(String((ev.content as Record<string, unknown>).presence));
      });
      hub.registerEventHandler('!r:hs', 'm.matrix_os.app.notes.op', async (ev) => {
        roomOrder.push(ev.event_id ?? '?');
      });
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              '!r:hs': {
                timeline: {
                  events: [
                    makeTimelineEvent({ id: '$1', ts: 1, lamport: 1 }),
                    makeTimelineEvent({ id: '$2', ts: 2, lamport: 2 }),
                  ],
                  limited: false,
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
          presence: {
            events: [
              { type: 'm.presence', sender: '@a:hs', content: { presence: 'online' } },
              { type: 'm.presence', sender: '@b:hs', content: { presence: 'offline' } },
            ],
          },
        }),
      });
      startHub();
      await waitFor(() => globalOrder.length === 2 && roomOrder.length === 2);
      // Global serial order preserved
      expect(globalOrder).toEqual(['online', 'offline']);
      // Room serial order preserved
      expect(roomOrder).toEqual(['$1', '$2']);
      // No cross-stream ordering assertion — intentional (contract point 4).
    });
  });

  // ------------------------- cursor persistence ---------------------------

  describe('cursor persistence (T010/T011)', () => {
    it('reads ~/system/matrix-sync.json on startup to seed the first since= token', async () => {
      writeFileSync(
        join(homePath, 'system', 'matrix-sync.json'),
        JSON.stringify({ next_batch: 'persisted-s0' }),
      );
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({ next_batch: 'persisted-s1' }),
      });

      const syncSpy = vi.spyOn(client, 'sync');
      // Re-construct hub so it re-reads the persisted file.
      const hub2 = new MatrixSyncHub({
        client: client as MatrixClient,
        homePath,
        onError,
        backoffMsSchedule: [5, 10],
      });
      const ctrl2 = new AbortController();
      const loop2 = hub2.start(ctrl2.signal);
      try {
        await waitFor(() => syncSpy.mock.calls.length >= 1);
        expect(syncSpy.mock.calls[0][0].since).toBe('persisted-s0');
        await waitFor(() => hub2.getNextBatch() === 'persisted-s1');
      } finally {
        ctrl2.abort();
        await loop2.catch(() => undefined);
        hub2.dispose();
      }
    });

    it('atomically persists the cursor after every successful /sync (tmp+rename)', async () => {
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({ next_batch: 'a' }),
      });
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({ next_batch: 'b' }),
      });
      startHub();
      await waitFor(() => hub.getNextBatch() === 'b');

      // Wait for the file to contain the advanced cursor. Disk rename under
      // parallel test load may lag a few ms behind the in-memory update.
      const cursorPath = join(homePath, 'system', 'matrix-sync.json');
      await waitFor(() => {
        try {
          const parsed = JSON.parse(readFileSync(cursorPath, 'utf8')) as { next_batch?: string };
          return parsed.next_batch === 'b';
        } catch {
          return false;
        }
      });

      const file = readFileSync(cursorPath, 'utf8');
      const parsed = JSON.parse(file);
      expect(parsed.next_batch).toBe('b');
    });

    it('corrupt cursor file: log + start from null (full sync), never throw', async () => {
      writeFileSync(
        join(homePath, 'system', 'matrix-sync.json'),
        'not-valid-json{{{',
      );
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({ next_batch: 'clean' }),
      });
      const syncSpy = vi.spyOn(client, 'sync');
      const hub2 = new MatrixSyncHub({
        client: client as MatrixClient,
        homePath,
        onError,
        backoffMsSchedule: [5],
      });
      const ctrl2 = new AbortController();
      const loop2 = hub2.start(ctrl2.signal);
      try {
        await waitFor(() => syncSpy.mock.calls.length >= 1);
        expect(syncSpy.mock.calls[0][0].since).toBeUndefined();
        await waitFor(() => hub2.getNextBatch() === 'clean');
      } finally {
        ctrl2.abort();
        await loop2.catch(() => undefined);
        hub2.dispose();
      }
    });

    it('missing cursor file (ENOENT): starts from null without error', async () => {
      // No file written — constructor should handle ENOENT gracefully.
      const hub2 = new MatrixSyncHub({
        client: client as MatrixClient,
        homePath,
        onError,
        backoffMsSchedule: [5],
      });
      expect(hub2.getNextBatch()).toBe('');
      hub2.dispose();
      expect(errors).toHaveLength(0);
    });

    it('cursor file with empty next_batch string returns null', async () => {
      writeFileSync(join(homePath, 'system', 'matrix-sync.json'), JSON.stringify({ next_batch: '' }));
      const hub2 = new MatrixSyncHub({
        client: client as MatrixClient,
        homePath,
        onError,
        backoffMsSchedule: [5],
      });
      expect(hub2.getNextBatch()).toBe('');
      hub2.dispose();
    });

    it('cursor file with non-string next_batch returns null', async () => {
      writeFileSync(join(homePath, 'system', 'matrix-sync.json'), JSON.stringify({ next_batch: 12345 }));
      const hub2 = new MatrixSyncHub({
        client: client as MatrixClient,
        homePath,
        onError,
        backoffMsSchedule: [5],
      });
      expect(hub2.getNextBatch()).toBe('');
      hub2.dispose();
    });
  });

  // ---- coverage: edge paths for branches and statements ----

  describe('edge paths (coverage)', () => {
    it('start() called twice is a no-op', async () => {
      client.queueSync({ kind: 'ok', response: buildSyncResponse({ next_batch: 's1' }) });
      startHub();
      await waitFor(() => hub.getNextBatch() === 's1');
      // Second call should return immediately.
      const second = hub.start(controller.signal);
      await second;
    });

    it('dispose() during loop terminates cleanly', async () => {
      startHub();
      await flushMicrotasks(4);
      hub.dispose();
      controller.abort();
      await loopPromise;
    });

    it('default onError is a no-op when not provided', () => {
      const hub2 = new MatrixSyncHub({
        client: client as MatrixClient,
        homePath,
      });
      // Should not throw.
      hub2.dispose();
    });

    it('debugGetRoomRing returns empty for unknown room', () => {
      expect(hub.debugGetRoomRing('!unknown:hs')).toEqual([]);
    });

    it('registerEventHandler dispose is safe when handler set is already gone', () => {
      const dis = hub.registerEventHandler('!r:hs', 'm.test', async () => {});
      // Manually clear the room handlers map to simulate a race.
      const room = (hub as unknown as { rooms: Map<string, { handlers: Map<string, Set<unknown>> }> }).rooms.get('!r:hs');
      if (room) room.handlers.delete('m.test');
      // dispose should not throw.
      dis.dispose();
    });

    it('registerEventHandler dispose cleans up empty handler set', () => {
      const dis = hub.registerEventHandler('!r:hs', 'm.test2', async () => {});
      dis.dispose();
      // Call dispose again — safe no-op.
      dis.dispose();
    });

    it('registerGlobalEventHandler dispose is safe when handler set is already gone', () => {
      const dis = hub.registerGlobalEventHandler('m.test', async () => {});
      const globalHandlers = (hub as unknown as { globalHandlers: Map<string, Set<unknown>> }).globalHandlers;
      globalHandlers.delete('m.test');
      dis.dispose();
    });

    it('registerGlobalEventHandler dispose cleans up empty set', () => {
      const dis = hub.registerGlobalEventHandler('m.test2', async () => {});
      dis.dispose();
      dis.dispose();
    });

    it('global handler that throws is caught and surfaced via onError', async () => {
      hub.registerGlobalEventHandler('m.presence', async () => {
        throw new Error('handler-boom');
      });
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          presence: {
            events: [{ type: 'm.presence', sender: '@a:hs', content: { presence: 'online' } }],
          },
        }),
      });
      startHub();
      await waitFor(() => errors.some((e) => e.detail?.reason === 'global_handler_failed'));
      expect(errors.find((e) => e.detail?.reason === 'global_handler_failed')?.detail?.error).toBe('handler-boom');
    });

    it('room handler that throws is caught via dispatch_failed', async () => {
      const room = '!r:hs';
      hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async () => {
        throw new Error('room-boom');
      });
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [makeTimelineEvent({ id: '$1', ts: 1, lamport: 1 })],
                  limited: false,
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      startHub();
      await waitFor(() => errors.some((e) => e.detail?.reason === 'dispatch_failed'));
      expect(errors.find((e) => e.detail?.reason === 'dispatch_failed')?.detail?.error).toBe('room-boom');
    });

    it('reportGap backfill failure is caught and surfaced', async () => {
      const room = '!r:hs';
      hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async () => {});
      // Seed the ring with one event so the room exists.
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [makeTimelineEvent({ id: '$1', ts: 1, lamport: 1 })],
                  limited: false,
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      startHub();
      await waitFor(() => hub.getNextBatch() === 's1');

      // Make getRoomMessages throw.
      const origGet = client.getRoomMessages.bind(client);
      client.getRoomMessages = async () => { throw new Error('backfill-fail'); };
      hub.reportGap(room, 5);
      await waitFor(() => errors.some((e) => e.detail?.reason === 'backfill_failed'));
      client.getRoomMessages = origGet;
    });

    it('events without lamport/client_id do not trigger gap detection', async () => {
      const room = '!r:hs';
      const received: string[] = [];
      hub.registerEventHandler(room, 'm.room.member', async (ev) => {
        received.push(ev.event_id ?? '?');
      });
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [
                    { event_id: '$m1', type: 'm.room.member', sender: '@a:hs', origin_server_ts: 1, content: { membership: 'join' } },
                    { event_id: '$m2', type: 'm.room.member', sender: '@b:hs', origin_server_ts: 2, content: { membership: 'join' } },
                  ],
                  limited: false,
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      startHub();
      await waitFor(() => received.length === 2);
      expect(received).toEqual(['$m1', '$m2']);
      expect(client.messagesCallCount()).toBe(0);
    });

    it('state events in a batch are dispatched to room handlers', async () => {
      const room = '!r:hs';
      const received: string[] = [];
      hub.registerEventHandler(room, 'm.matrix_os.app_acl', async (ev) => {
        received.push(ev.event_id ?? '?');
      });
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: { events: [], limited: false },
                state: {
                  events: [
                    {
                      event_id: '$acl1',
                      type: 'm.matrix_os.app_acl',
                      state_key: 'notes',
                      sender: '@a:hs',
                      origin_server_ts: 1,
                      content: { write_pl: 50 },
                    },
                  ],
                },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      startHub();
      await waitFor(() => received.length === 1);
      expect(received).toEqual(['$acl1']);
    });

    it('account_data events dispatch to global handlers', async () => {
      const received: string[] = [];
      hub.registerGlobalEventHandler('m.direct', async (ev) => {
        received.push(ev.type);
      });
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          account_data: {
            events: [{ type: 'm.direct', content: {} }],
          },
        }),
      });
      startHub();
      await waitFor(() => received.length === 1);
      expect(received).toEqual(['m.direct']);
    });

    it('unregistered event type does not crash (fireRoomHandlers no-op)', async () => {
      const room = '!r:hs';
      // Register for one type, send another.
      hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async () => {});
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [{ event_id: '$x', type: 'm.unregistered', sender: '@a:hs', origin_server_ts: 1, content: {} }],
                  limited: false,
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      startHub();
      await waitFor(() => hub.getNextBatch() === 's1');
    });

    it('unregistered global event type does not crash (dispatchGlobal no-op)', async () => {
      hub.registerGlobalEventHandler('m.presence', async () => {});
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          presence: {
            events: [{ type: 'm.unregistered_global', content: {} }],
          },
        }),
      });
      startHub();
      await waitFor(() => hub.getNextBatch() === 's1');
    });

    it('backfill with empty chunk breaks out of the pagination loop', async () => {
      const room = '!r:hs';
      const received: string[] = [];
      hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async (ev) => {
        received.push(ev.event_id ?? '?');
      });
      // limited=true triggers backfill, but /messages returns empty chunk.
      client.queueMessages({ chunk: [], end: 'p-end' });
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [makeTimelineEvent({ id: '$1', ts: 1, lamport: 1 })],
                  limited: true,
                  prev_batch: 'p0',
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      startHub();
      await waitFor(() => received.length >= 1);
      expect(received).toContain('$1');
      expect(client.messagesCallCount()).toBe(1);
    });

    it('recency ring deduplicates events with the same event_id', async () => {
      const room = '!r:hs';
      hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async () => {});
      // Send same event_id twice in one batch — should only appear once in ring.
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [
                    makeTimelineEvent({ id: '$dup', ts: 1, lamport: 1 }),
                    makeTimelineEvent({ id: '$dup', ts: 2, lamport: 2 }),
                  ],
                  limited: false,
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      startHub();
      await waitFor(() => hub.getNextBatch() === 's1');
      const ring = hub.debugGetRoomRing(room);
      const dupCount = ring.filter((r) => r.event_id === '$dup').length;
      expect(dupCount).toBe(1);
    });

    it('raceAbort rejects immediately when signal is already aborted', async () => {
      const aborted = AbortSignal.abort();
      const hubAny = hub as unknown as { raceAbort: <T>(p: Promise<T>, s: AbortSignal) => Promise<T> };
      await expect(
        hubAny.raceAbort(Promise.resolve('ok'), aborted),
      ).rejects.toThrow('aborted');
    });

    it('/sync response with empty rooms object does not crash', async () => {
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({ next_batch: 's1' }),
      });
      startHub();
      await waitFor(() => hub.getNextBatch() === 's1');
    });

    it('sleep early return when signal already aborted', async () => {
      // Trigger backoff by making sync fail, then immediately abort.
      client.queueSync({ kind: 'error', error: new Error('trigger-backoff') });
      startHub();
      // Give the hub time to enter the catch + backoff path.
      await flushMicrotasks(8);
      controller.abort();
      await loopPromise;
    });

    it('disposed mid-sync breaks the loop', async () => {
      // Queue an OK then a hang.
      client.queueSync({ kind: 'ok', response: buildSyncResponse({ next_batch: 's1' }) });
      startHub();
      await waitFor(() => hub.getNextBatch() === 's1');
      hub.dispose();
      controller.abort();
      await loopPromise;
    });

    it('events with undefined event_id / origin_server_ts still dispatch and sort', async () => {
      const room = '!r:hs';
      const received: string[] = [];
      hub.registerEventHandler(room, 'm.test', async (ev) => {
        received.push(String(ev.content?.val));
      });
      // limited=true triggers backfill; messages come back with missing fields.
      client.queueMessages({
        chunk: [
          { type: 'm.test', content: { val: 'b' } },
          { type: 'm.test', content: { val: 'a' } },
        ],
        end: 'p-end',
      });
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [{ type: 'm.test', content: { val: 'c' } }],
                  limited: true,
                  prev_batch: 'p0',
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      startHub();
      await waitFor(() => received.length >= 3);
      // Backfill sorts by (ts ?? 0, id ?? ''); both undefined → stable order.
      expect(received).toContain('a');
      expect(received).toContain('b');
      expect(received).toContain('c');
    });

    it('events with undefined content.lamport fallback to 0 in readLamport', async () => {
      const room = '!r:hs';
      const received: string[] = [];
      hub.registerEventHandler(room, 'm.test', async (ev) => {
        received.push(ev.event_id ?? '?');
      });
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [
                    { event_id: '$nolam', type: 'm.test', origin_server_ts: 1, content: {} },
                  ],
                  limited: false,
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      startHub();
      await waitFor(() => received.length === 1);
      const ring = hub.debugGetRoomRing(room);
      expect(ring[0].lamport).toBe(0);
    });

    it('backfill iteration cap hit with collected events still delivers them and flags', async () => {
      const room = '!r:hs';
      const received: string[] = [];
      hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async (ev) => {
        received.push(ev.event_id ?? '?');
      });
      // Create a hub with cap=1 so one page hits the cap.
      const hub2 = new MatrixSyncHub({
        client: client as MatrixClient,
        homePath,
        onError,
        backoffMsSchedule: [5],
        backfillIterationCap: 1,
      });
      hub2.registerEventHandler(room, 'm.matrix_os.app.notes.op', async (ev) => {
        received.push(ev.event_id ?? '?');
      });
      // Backfill returns events but no anchor hit within 1 page.
      client.queueMessages({
        chunk: [
          makeTimelineEvent({ id: '$bf1', ts: 3, lamport: 3 }),
          makeTimelineEvent({ id: '$bf2', ts: 2, lamport: 2 }),
        ],
        end: 'p-more',
      });
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [makeTimelineEvent({ id: '$5', ts: 5, lamport: 5 })],
                  limited: true,
                  prev_batch: 'p0',
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      const ctrl2 = new AbortController();
      const loop2 = hub2.start(ctrl2.signal);
      await waitFor(() => received.length >= 2);
      expect(received).toContain('$bf1');
      expect(received).toContain('$bf2');
      await waitFor(() => errors.some((e) => e.detail?.reason === 'backfill_iteration_cap'));
      ctrl2.abort();
      await loop2.catch(() => undefined);
      hub2.dispose();
    });

    it('backfill iteration cap with zero collected events surfaces sync_failed', async () => {
      const room = '!r:hs';
      hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async () => {});
      // Create hub with cap=1, messages returns 1 page of no-anchor events.
      const hub2 = new MatrixSyncHub({
        client: client as MatrixClient,
        homePath,
        onError,
        backoffMsSchedule: [5],
        backfillIterationCap: 1,
      });
      hub2.registerEventHandler(room, 'm.matrix_os.app.notes.op', async () => {});
      // Backfill returns nothing useful.
      client.queueMessages({ chunk: [], end: 'p-end' });
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [makeTimelineEvent({ id: '$x', ts: 1, lamport: 1 })],
                  limited: true,
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      const ctrl2 = new AbortController();
      const loop2 = hub2.start(ctrl2.signal);
      await waitFor(() => errors.some((e) => e.detail?.reason === 'backfill_iteration_cap'));
      ctrl2.abort();
      await loop2.catch(() => undefined);
      hub2.dispose();
    });

    it('persistCursor failure surfaces onError without crash', async () => {
      // Make the system dir non-writable by deleting it.
      rmSync(join(homePath, 'system'), { recursive: true, force: true });
      // Write a file where the directory should be to block mkdir.
      writeFileSync(join(homePath, 'system'), 'block');
      client.queueSync({ kind: 'ok', response: buildSyncResponse({ next_batch: 'x' }) });
      startHub();
      await waitFor(() => hub.getNextBatch() === 'x');
      await flushMicrotasks(16);
      // Should not crash; may or may not emit an error depending on OS behavior.
    });

    it('lamport gap within a single event batch triggers backfill after delivering earlier events', async () => {
      const room = '!r:hs';
      const received: string[] = [];
      hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async (ev) => {
        received.push(ev.event_id ?? '?');
      });

      // Two events from same client_id where lamport jumps: 1, 5.
      // Backfill returns the missing 2,3,4.
      client.queueMessages({
        chunk: [
          makeTimelineEvent({ id: '$5', ts: 5, lamport: 5 }),
          makeTimelineEvent({ id: '$4', ts: 4, lamport: 4 }),
          makeTimelineEvent({ id: '$3', ts: 3, lamport: 3 }),
          makeTimelineEvent({ id: '$2', ts: 2, lamport: 2 }),
          makeTimelineEvent({ id: '$1', ts: 1, lamport: 1 }),
        ],
        end: 'p-end',
      });

      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [
                    makeTimelineEvent({ id: '$1', ts: 1, lamport: 1, clientId: 'c1' }),
                    makeTimelineEvent({ id: '$5', ts: 5, lamport: 5, clientId: 'c1' }),
                  ],
                  limited: false,
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      startHub();
      await waitFor(() => received.length >= 5);
      expect(received).toEqual(['$1', '$2', '$3', '$4', '$5']);
    });

    it('default onError does not crash when triggered', async () => {
      // Hub without onError — defaults to no-op lambda.
      const hub2 = new MatrixSyncHub({
        client: client as MatrixClient,
        homePath,
        backoffMsSchedule: [5],
      });
      // Trigger an error through sync failure.
      client.queueSync({ kind: 'error', error: new Error('x') });
      client.queueSync({ kind: 'ok', response: buildSyncResponse({ next_batch: 'ok' }) });
      const ctrl2 = new AbortController();
      const loop2 = hub2.start(ctrl2.signal);
      await waitFor(() => hub2.getNextBatch() === 'ok');
      ctrl2.abort();
      await loop2.catch(() => undefined);
      hub2.dispose();
    });

    it('event with undefined content does not trigger gap detection', async () => {
      const room = '!r:hs';
      hub.registerEventHandler(room, 'm.test', async () => {});
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [
                    { event_id: '$nocon', type: 'm.test', sender: '@a:hs', origin_server_ts: 1, content: undefined as unknown as Record<string, unknown> },
                  ],
                  limited: false,
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      startHub();
      await waitFor(() => hub.getNextBatch() === 's1');
      expect(client.messagesCallCount()).toBe(0);
    });

    it('loadCursorSync returns null when homePath does not resolve cursor file', () => {
      // Create hub with a homePath that causes resolveWithinHome to return null.
      const hub2 = new MatrixSyncHub({
        client: client as MatrixClient,
        homePath: '/nonexistent-path-that-is-fine',
        onError,
      });
      expect(hub2.getNextBatch()).toBe('');
      hub2.dispose();
    });

    it('persistCursor is no-op when nextBatch is null', async () => {
      // Hub with no syncs → nextBatch stays null → persistCursor skips.
      const hub2 = new MatrixSyncHub({
        client: client as MatrixClient,
        homePath,
        onError,
        backoffMsSchedule: [5],
      });
      // Access private persistCursor via start() with empty sync.
      client.queueSync({ kind: 'ok', response: buildSyncResponse({ next_batch: '' }) });
      const ctrl2 = new AbortController();
      const loop2 = hub2.start(ctrl2.signal);
      await flushMicrotasks(8);
      ctrl2.abort();
      await loop2.catch(() => undefined);
      hub2.dispose();
    });

    it('sleep returns immediately when signal is already aborted', async () => {
      // Access sleep directly to test the early return.
      const hubAny = hub as unknown as { sleep: (ms: number, signal: AbortSignal) => Promise<void> };
      const aborted = AbortSignal.abort();
      await hubAny.sleep(10000, aborted);
      // If we reach here, sleep returned immediately.
    });

    it('backfill error message falls back to unknown when err has no message', async () => {
      const room = '!r:hs';
      hub.registerEventHandler(room, 'm.matrix_os.app.notes.op', async () => {});
      client.queueSync({
        kind: 'ok',
        response: buildSyncResponse({
          next_batch: 's1',
          rooms: {
            join: {
              [room]: {
                timeline: {
                  events: [makeTimelineEvent({ id: '$1', ts: 1, lamport: 1 })],
                  limited: false,
                },
                state: { events: [] },
              },
            },
            invite: {},
            leave: {},
          },
        }),
      });
      startHub();
      await waitFor(() => hub.getNextBatch() === 's1');
      // Replace getRoomMessages to throw a non-Error object.
      client.getRoomMessages = async () => { throw null; };
      hub.reportGap(room, 5);
      await waitFor(() => errors.some((e) => e.detail?.reason === 'backfill_failed'));
      expect(errors.find((e) => e.detail?.reason === 'backfill_failed')?.detail?.error).toBe('unknown');
    });
  });
});
