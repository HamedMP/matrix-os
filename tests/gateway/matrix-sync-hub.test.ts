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
  });
});
