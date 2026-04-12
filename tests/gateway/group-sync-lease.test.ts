import { describe, it, expect, beforeEach, vi } from 'vitest';

import { SnapshotLeaseManager } from '../../packages/gateway/src/group-snapshot-lease.js';
import type { MatrixClient } from '../../packages/gateway/src/matrix-client.js';

/**
 * Tests for SnapshotLeaseManager — lease acquisition, grace period,
 * inbound lease invalidation, race property.
 *
 * Spec §C snapshot_lease + spike §9.4 constants:
 *   - state_key = `{app_slug}` (NOT `""` — that was a spec typo)
 *   - lease_id = ULID matching the snapshot_id the writer publishes
 *   - GROUP_SYNC_SNAPSHOT_LEASE_MS          = 60000
 *   - GROUP_SYNC_SNAPSHOT_LEASE_GRACE_MS    = 10000
 */

interface FakeState {
  // `${eventType}|${stateKey}` → content
  state: Map<string, Record<string, unknown>>;
  setCalls: Array<{ eventType: string; stateKey: string; content: Record<string, unknown> }>;
}

function makeFakeClient(): { client: MatrixClient; state: FakeState } {
  const state: FakeState = {
    state: new Map(),
    setCalls: [],
  };
  const client: MatrixClient = {
    sendMessage: vi.fn(),
    createDM: vi.fn(),
    joinRoom: vi.fn(),
    getRoomMessages: vi.fn(),
    whoami: vi.fn(),
    sendCustomEvent: vi.fn(),
    sync: vi.fn(),
    createRoom: vi.fn(),
    inviteToRoom: vi.fn(),
    kickFromRoom: vi.fn(),
    leaveRoom: vi.fn(),
    async getRoomState(_roomId, eventType, stateKey) {
      return state.state.get(`${eventType}|${stateKey}`) ?? null;
    },
    async getAllRoomStateEvents(_roomId, eventType) {
      const out: Array<{
        type: string;
        state_key: string;
        content: Record<string, unknown>;
      }> = [];
      for (const [key, value] of state.state) {
        const [type, ...rest] = key.split('|');
        const stateKey = rest.join('|');
        if (eventType && type !== eventType) continue;
        out.push({ type: type!, state_key: stateKey, content: value });
      }
      return out;
    },
    async setRoomState(_roomId, eventType, stateKey, content) {
      state.setCalls.push({ eventType, stateKey, content });
      state.state.set(`${eventType}|${stateKey}`, content);
      return { eventId: `$state-${state.setCalls.length}` };
    },
    getRoomMembers: vi.fn(),
    getPowerLevels: vi.fn(),
    setPowerLevels: vi.fn(),
  };
  return { client, state };
}

const ROOM = '!room:matrix-os.com';
const APP = 'notes';

describe('SnapshotLeaseManager — tryAcquire', () => {
  let now: number;
  let advance: (ms: number) => void;

  beforeEach(() => {
    now = 1_000_000;
    advance = (ms) => {
      now += ms;
    };
  });

  it('writes a lease and returns lease_id when no lease exists', async () => {
    const { client, state } = makeFakeClient();
    const mgr = new SnapshotLeaseManager({
      matrixClient: client,
      roomId: ROOM,
      selfHandle: '@alice:matrix-os.com',
      clockNow: () => now,
    });

    const result = await mgr.tryAcquire(APP);
    expect(result).not.toBeNull();
    expect(typeof result!.leaseId).toBe('string');
    // ULID: 26 chars Crockford Base32
    expect(result!.leaseId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // A setRoomState call was made with state_key = APP (spec §C typo fix).
    expect(state.setCalls.length).toBe(1);
    const call = state.setCalls[0]!;
    expect(call.eventType).toBe(`m.matrix_os.app.${APP}.snapshot_lease`);
    expect(call.stateKey).toBe(APP);
    expect(call.content.writer).toBe('@alice:matrix-os.com');
    expect(call.content.lease_id).toBe(result!.leaseId);
    expect(typeof call.content.expires_at).toBe('number');
    // Default lease is 60s (GROUP_SYNC_SNAPSHOT_LEASE_MS).
    expect(call.content.expires_at).toBe(now + 60_000);
  });

  it('reuses the existing lease_id when self-held and still valid', async () => {
    const { client } = makeFakeClient();
    const mgr = new SnapshotLeaseManager({
      matrixClient: client,
      roomId: ROOM,
      selfHandle: '@alice:matrix-os.com',
      clockNow: () => now,
    });

    const first = await mgr.tryAcquire(APP);
    expect(first).not.toBeNull();

    // 5 seconds later, the same self acquires → should reuse.
    advance(5_000);
    const second = await mgr.tryAcquire(APP);
    expect(second).not.toBeNull();
    expect(second!.leaseId).toBe(first!.leaseId);
  });

  it('returns null when another writer holds a valid lease', async () => {
    const { client, state } = makeFakeClient();
    // Preload a foreign lease that expires in 30s.
    state.state.set(`m.matrix_os.app.${APP}.snapshot_lease|${APP}`, {
      v: 1,
      writer: '@bob:matrix-os.com',
      lease_id: '01HYYYYYYYYYYYYYYYYYYYYYYY',
      acquired_at: now,
      expires_at: now + 30_000,
    });

    const mgr = new SnapshotLeaseManager({
      matrixClient: client,
      roomId: ROOM,
      selfHandle: '@alice:matrix-os.com',
      clockNow: () => now,
    });
    const result = await mgr.tryAcquire(APP);
    expect(result).toBeNull();
  });

  it('takes over only AFTER expires_at + GROUP_SYNC_SNAPSHOT_LEASE_GRACE_MS', async () => {
    const { client, state } = makeFakeClient();
    state.state.set(`m.matrix_os.app.${APP}.snapshot_lease|${APP}`, {
      v: 1,
      writer: '@bob:matrix-os.com',
      lease_id: '01HYYYYYYYYYYYYYYYYYYYYYYY',
      acquired_at: now - 60_000,
      expires_at: now, // just expired
    });

    const mgr = new SnapshotLeaseManager({
      matrixClient: client,
      roomId: ROOM,
      selfHandle: '@alice:matrix-os.com',
      clockNow: () => now,
    });

    // Not yet past the grace period.
    let result = await mgr.tryAcquire(APP);
    expect(result).toBeNull();

    // Still within grace period.
    advance(5_000);
    result = await mgr.tryAcquire(APP);
    expect(result).toBeNull();

    // Past the grace period.
    advance(6_000); // total 11 s past expires_at
    result = await mgr.tryAcquire(APP);
    expect(result).not.toBeNull();
  });

  it('inbound lease from another writer invalidates in-flight self lease', async () => {
    const { client, state } = makeFakeClient();
    const mgr = new SnapshotLeaseManager({
      matrixClient: client,
      roomId: ROOM,
      selfHandle: '@alice:matrix-os.com',
      clockNow: () => now,
    });

    const first = await mgr.tryAcquire(APP);
    expect(first).not.toBeNull();
    expect(mgr.holdsLease(APP)).toBe(true);

    // Inbound lease event from Bob observed on /sync — should invalidate.
    mgr.observeLease(APP, {
      v: 1,
      writer: '@bob:matrix-os.com',
      lease_id: '01HYYYYYYYYYYYYYYYYYYYYYYZ',
      acquired_at: now,
      expires_at: now + 60_000,
    });

    expect(mgr.holdsLease(APP)).toBe(false);
  });

  it('race property: 100 iterations, exactly one of two contenders wins a fresh slot', async () => {
    for (let iter = 0; iter < 100; iter++) {
      const sharedState = new Map<string, Record<string, unknown>>();
      const setCalls: Array<{ writer: string }> = [];
      const nowIter = 2_000_000 + iter * 1_000_000;

      function makeSharedClient(): MatrixClient {
        return {
          sendMessage: vi.fn(),
          createDM: vi.fn(),
          joinRoom: vi.fn(),
          getRoomMessages: vi.fn(),
          whoami: vi.fn(),
          sendCustomEvent: vi.fn(),
          sync: vi.fn(),
          createRoom: vi.fn(),
          inviteToRoom: vi.fn(),
          kickFromRoom: vi.fn(),
          leaveRoom: vi.fn(),
          async getRoomState(_roomId, eventType, stateKey) {
            return sharedState.get(`${eventType}|${stateKey}`) ?? null;
          },
          getAllRoomStateEvents: vi.fn().mockResolvedValue([]),
          async setRoomState(_roomId, eventType, stateKey, content) {
            // Matrix LWW: last writer wins. We simulate that the homeserver
            // serializes these; whichever setRoomState runs second overwrites.
            setCalls.push({ writer: (content as { writer: string }).writer });
            sharedState.set(`${eventType}|${stateKey}`, content);
            return { eventId: `$${setCalls.length}` };
          },
          getRoomMembers: vi.fn(),
          getPowerLevels: vi.fn(),
          setPowerLevels: vi.fn(),
        };
      }

      const aliceMgr = new SnapshotLeaseManager({
        matrixClient: makeSharedClient(),
        roomId: ROOM,
        selfHandle: '@alice:matrix-os.com',
        clockNow: () => nowIter,
      });
      const bobMgr = new SnapshotLeaseManager({
        matrixClient: makeSharedClient(),
        roomId: ROOM,
        selfHandle: '@bob:matrix-os.com',
        clockNow: () => nowIter,
      });

      // Both race. The winner is determined by who sets state last on the
      // shared homeserver (Matrix LWW semantics). Both calls succeed from
      // their local perspective.
      const [aliceResult, bobResult] = await Promise.all([
        aliceMgr.tryAcquire(APP),
        bobMgr.tryAcquire(APP),
      ]);

      // Both MAY return non-null (both believe they acquired). After the
      // dust settles, whoever observes the other's event via observeLease
      // will stand down. To check convergence, observe each other's leases:
      const finalLease = sharedState.get(`m.matrix_os.app.${APP}.snapshot_lease|${APP}`);
      expect(finalLease).toBeDefined();
      const winner = (finalLease as { writer: string }).writer;

      // After observing the final lease, at most one manager should still
      // think it holds.
      if (aliceResult !== null) {
        aliceMgr.observeLease(APP, finalLease as {
          v: number;
          writer: string;
          lease_id: string;
          acquired_at: number;
          expires_at: number;
        });
      }
      if (bobResult !== null) {
        bobMgr.observeLease(APP, finalLease as {
          v: number;
          writer: string;
          lease_id: string;
          acquired_at: number;
          expires_at: number;
        });
      }

      const aliceHolds = aliceMgr.holdsLease(APP);
      const bobHolds = bobMgr.holdsLease(APP);
      // Exactly one (or zero) holds; never both.
      expect(Number(aliceHolds) + Number(bobHolds)).toBeLessThanOrEqual(1);
      // The winner is whoever matches the final lease.
      if (winner === '@alice:matrix-os.com') {
        expect(aliceHolds).toBe(true);
      } else if (winner === '@bob:matrix-os.com') {
        expect(bobHolds).toBe(true);
      }
    }
  });
});
