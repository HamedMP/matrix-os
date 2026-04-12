import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as Y from 'yjs';

import {
  GroupSync,
  type GroupSyncErrorCode,
} from '../../packages/gateway/src/group-sync.js';
import { GroupDocCache } from '../../packages/gateway/src/group-doc-cache.js';
import type { GroupManifest } from '../../packages/gateway/src/group-types.js';
import type { MatrixClient } from '../../packages/gateway/src/matrix-client.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<GroupManifest> = {}): GroupManifest {
  return {
    room_id: '!testroom:matrix-os.com',
    name: 'Test Group',
    slug: 'test-group',
    owner_handle: '@alice:matrix-os.com',
    joined_at: 1,
    schema_version: 1,
    ...overrides,
  };
}

interface FakeState {
  sendCalls: Array<{ eventType: string; content: Record<string, unknown> }>;
  sendShouldFail: boolean;
}

function makeFakeClient(): { client: MatrixClient; state: FakeState } {
  const state: FakeState = { sendCalls: [], sendShouldFail: false };
  const client: MatrixClient = {
    sendMessage: vi.fn(),
    createDM: vi.fn(),
    joinRoom: vi.fn(),
    getRoomMessages: vi.fn(),
    whoami: vi.fn(),
    async sendCustomEvent(_roomId, eventType, content) {
      state.sendCalls.push({ eventType, content });
      if (state.sendShouldFail) throw new Error('offline');
      return { eventId: `$${state.sendCalls.length}` };
    },
    sync: vi.fn(),
    createRoom: vi.fn(),
    inviteToRoom: vi.fn(),
    kickFromRoom: vi.fn(),
    leaveRoom: vi.fn(),
    getRoomState: vi.fn().mockResolvedValue(null),
    getAllRoomStateEvents: vi.fn().mockResolvedValue([]),
    setRoomState: vi.fn(),
    getRoomMembers: vi.fn(),
    getPowerLevels: vi.fn(),
    setPowerLevels: vi.fn(),
  };
  return { client, state };
}

async function scaffoldApp(home: string, group: string, app: string): Promise<void> {
  await mkdir(join(home, 'groups', group, 'apps', app), { recursive: true });
  await writeFile(
    join(home, 'groups', group, 'apps', app, 'matrix.json'),
    JSON.stringify({ slug: app, name: app, version: '1.0.0' }),
  );
  await mkdir(join(home, 'groups', group, 'data', app), { recursive: true });
}

async function makeTmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'group-sync-res-test-'));
}

function encodeYjsDelta(mutator: (doc: Y.Doc) => void): string {
  const doc = new Y.Doc();
  const prior = Y.encodeStateVector(doc);
  mutator(doc);
  const update = Y.encodeStateAsUpdate(doc, prior);
  return Buffer.from(update).toString('base64');
}

// ---------------------------------------------------------------------------
// state.bin 5 MB hard cap → state_overflow
// ---------------------------------------------------------------------------

describe('Per-app resource caps — state.bin', () => {
  let home: string;

  beforeEach(async () => {
    home = await makeTmpHome();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('rejects local mutation that pushes state.bin past GROUP_STATE_MAX_BYTES with state_overflow onError', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client } = makeFakeClient();

    const errors: Array<{ code: GroupSyncErrorCode; detail: Record<string, unknown> }> = [];
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
      env: { GROUP_STATE_MAX_BYTES: 1024 }, // 1 KB cap so we can blow through it
      onError: (code, detail) => errors.push({ code, detail }),
    });
    await sync.hydrate();

    // First few small mutations — these should succeed.
    await sync.applyLocalMutation('notes', (doc) => {
      doc.getMap('kv').set('k1', 'small');
    });

    // Now a large mutation that blows through the cap.
    const big = 'x'.repeat(4000);
    await sync.applyLocalMutation('notes', (doc) => {
      doc.getMap('kv').set('big', big);
    });

    const overflow = errors.filter((e) => e.code === 'state_overflow');
    expect(overflow.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects inbound remote op that would exceed state.bin cap', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client } = makeFakeClient();

    const errors: Array<{ code: GroupSyncErrorCode }> = [];
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
      env: { GROUP_STATE_MAX_BYTES: 512 },
      onError: (code) => errors.push({ code }),
    });
    await sync.hydrate();

    const updateB64 = encodeYjsDelta((doc) => {
      doc.getMap('kv').set('big', 'y'.repeat(4000));
    });

    await sync.applyRemoteOp('notes', {
      type: 'm.matrix_os.app.notes.op',
      event_id: '$big',
      sender: '@bob:matrix-os.com',
      origin_server_ts: 1,
      content: {
        v: 1,
        update: updateB64,
        lamport: 1,
        client_id: 'bob',
        origin: '@bob:matrix-os.com',
        ts: 1,
      },
    });

    const overflow = errors.filter((e) => e.code === 'state_overflow');
    expect(overflow.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// log.jsonl 5 MB / 30-day rotation
// ---------------------------------------------------------------------------

describe('Per-app resource caps — log.jsonl rotation', () => {
  let home: string;

  beforeEach(async () => {
    home = await makeTmpHome();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('rotates log.jsonl when it exceeds GROUP_LOG_MAX_BYTES; new log starts fresh', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client } = makeFakeClient();

    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
      env: { GROUP_LOG_MAX_BYTES: 200 }, // tiny so rotation happens quickly
    });
    await sync.hydrate();

    // Write 5 ops — each adds ~100 bytes to log.jsonl → forces rotation.
    for (let i = 0; i < 5; i++) {
      const updateB64 = encodeYjsDelta((doc) => doc.getMap('kv').set(`k${i}`, `v${i}`));
      await sync.applyRemoteOp('notes', {
        type: 'm.matrix_os.app.notes.op',
        event_id: `$op-${i}`,
        sender: '@bob:matrix-os.com',
        origin_server_ts: i,
        content: {
          v: 1,
          update: updateB64,
          lamport: i,
          client_id: 'bob',
          origin: '@bob:matrix-os.com',
          ts: i,
        },
      });
    }

    const logPath = join(home, 'groups', manifest.slug, 'data', 'notes', 'log.jsonl');
    const logText = await readFile(logPath, 'utf-8');
    const byteLen = Buffer.byteLength(logText, 'utf-8');
    expect(byteLen).toBeLessThanOrEqual(200 * 3); // post-rotation should be small-ish
  });
});

// ---------------------------------------------------------------------------
// quarantine.jsonl 100-event drop-oldest
// ---------------------------------------------------------------------------

describe('Per-app resource caps — quarantine cap', () => {
  let home: string;

  beforeEach(async () => {
    home = await makeTmpHome();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('caps quarantine.jsonl at GROUP_QUARANTINE_MAX with drop-oldest', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client } = makeFakeClient();

    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
      env: { GROUP_QUARANTINE_MAX: 5 },
    });
    await sync.hydrate();

    // Push 10 bad ops — each should be quarantined, cap trims to 5.
    for (let i = 0; i < 10; i++) {
      await sync.applyRemoteOp('notes', {
        type: 'm.matrix_os.app.notes.op',
        event_id: `$bad-${i}`,
        sender: '@bob:matrix-os.com',
        origin_server_ts: i,
        content: {
          v: 1,
          update: '!!invalid!!',
          lamport: i,
          client_id: 'bob',
          origin: '@bob:matrix-os.com',
          ts: i,
        },
      });
    }

    const qPath = join(home, 'groups', manifest.slug, 'data', 'notes', 'quarantine.jsonl');
    const text = await readFile(qPath, 'utf-8');
    const lines = text.trim().split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(5);

    // Drop-oldest: the retained entries should be the NEWEST five.
    const reasons = lines.map((l) => {
      const parsed = JSON.parse(l);
      return parsed.event_id as string;
    });
    expect(reasons).toEqual(['$bad-5', '$bad-6', '$bad-7', '$bad-8', '$bad-9']);
  });
});

// ---------------------------------------------------------------------------
// Outbound op size cap + chunking (T035a)
// ---------------------------------------------------------------------------

describe('Op size cap + chunking', () => {
  let home: string;

  beforeEach(async () => {
    home = await makeTmpHome();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('emits a single event with no chunk_seq for a small update', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client, state } = makeFakeClient();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
    });
    await sync.hydrate();

    await sync.applyLocalMutation('notes', (doc) => doc.getMap('kv').set('k', 'v'));

    expect(state.sendCalls.length).toBe(1);
    const content = state.sendCalls[0]!.content;
    expect(content.chunk_seq).toBeUndefined();
  });

  it('splits a large update into N ≤ 32KB fragments with chunk_seq envelope', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client, state } = makeFakeClient();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
      env: { GROUP_STATE_MAX_BYTES: 10 * 1024 * 1024 },
    });
    await sync.hydrate();

    // Build a mutation whose raw Yjs update is well over 32 KB.
    await sync.applyLocalMutation('notes', (doc) => {
      const arr = doc.getArray<string>('tasks');
      const big: string[] = [];
      for (let i = 0; i < 2_000; i++) big.push('x'.repeat(100));
      arr.push(big);
    });

    expect(state.sendCalls.length).toBeGreaterThan(1);
    const fragments = state.sendCalls.slice();
    for (const call of fragments) {
      expect(call.eventType).toBe('m.matrix_os.app.notes.op');
      const seq = call.content.chunk_seq as { index: number; count: number; group_id: string } | undefined;
      expect(seq).toBeDefined();
      expect(seq!.count).toBe(fragments.length);
    }
    // All fragments share the same group_id.
    const groupIds = new Set(
      fragments.map((f) => (f.content.chunk_seq as { group_id: string }).group_id),
    );
    expect(groupIds.size).toBe(1);
    // Indices are 0..N-1 in emission order.
    fragments.forEach((f, i) => {
      expect((f.content.chunk_seq as { index: number }).index).toBe(i);
    });
  });

  it('rejects oversize updates (>1MB raw) with op_too_large onError', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client } = makeFakeClient();
    const errors: Array<{ code: GroupSyncErrorCode }> = [];
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
      env: { GROUP_STATE_MAX_BYTES: 50 * 1024 * 1024 },
      onError: (code) => errors.push({ code }),
    });
    await sync.hydrate();

    // Create an update larger than 1 MB raw.
    await sync.applyLocalMutation('notes', (doc) => {
      const arr = doc.getArray<string>('tasks');
      const big: string[] = [];
      for (let i = 0; i < 30_000; i++) big.push('x'.repeat(100));
      arr.push(big);
    });

    const tooLarge = errors.filter((e) => e.code === 'op_too_large');
    expect(tooLarge.length).toBeGreaterThanOrEqual(1);
  });

  it('reassembles inbound fragments into a single Yjs update by group_id', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client, state } = makeFakeClient();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
      env: { GROUP_STATE_MAX_BYTES: 10 * 1024 * 1024 },
    });
    await sync.hydrate();

    // Generate a large local mutation to capture its chunk_seq fragments.
    await sync.applyLocalMutation('notes', (doc) => {
      const arr = doc.getArray<string>('tasks');
      const big: string[] = [];
      for (let i = 0; i < 2_000; i++) big.push('y'.repeat(100));
      arr.push(big);
    });
    const fragments = state.sendCalls.slice();
    expect(fragments.length).toBeGreaterThan(1);

    // Now simulate a fresh peer receiving those same fragments.
    await scaffoldApp(home, 'other-group', 'notes');
    const peerSync = new GroupSync({
      manifest: { ...manifest, slug: 'other-group', room_id: '!other:m.com' },
      homePath: home,
      matrixClient: makeFakeClient().client,
      selfHandle: '@peer:matrix-os.com',
      env: { GROUP_STATE_MAX_BYTES: 10 * 1024 * 1024 },
    });
    await peerSync.hydrate();

    // Deliver out of order: last then first then middles.
    const reordered = [fragments[fragments.length - 1]!, fragments[0]!, ...fragments.slice(1, -1)];
    for (let i = 0; i < reordered.length; i++) {
      await peerSync.applyRemoteOp('notes', {
        type: 'm.matrix_os.app.notes.op',
        event_id: `$frag-${i}`,
        sender: '@alice:matrix-os.com',
        origin_server_ts: i,
        content: reordered[i]!.content,
      });
    }

    // Doc should have the tasks array populated.
    const arr = peerSync.getDoc('notes').getArray('tasks');
    expect(arr.length).toBe(2_000);
  });

  it('drops partial fragment groups after TTL expiry with a logged warning', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client } = makeFakeClient();
    let now = 1_000_000;
    const errors: Array<{ code: GroupSyncErrorCode; detail: Record<string, unknown> }> = [];
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
      clockNow: () => now,
      onError: (code, detail) => errors.push({ code, detail }),
    });
    await sync.hydrate();

    // Synthesize a fragment with chunk_seq but DO NOT send the peer.
    await sync.applyRemoteOp('notes', {
      type: 'm.matrix_os.app.notes.op',
      event_id: '$frag-0',
      sender: '@bob:matrix-os.com',
      origin_server_ts: 1,
      content: {
        v: 1,
        update: 'AAAA',
        lamport: 1,
        client_id: 'bob',
        origin: '@bob:matrix-os.com',
        ts: 1,
        chunk_seq: { index: 0, count: 3, group_id: '01HZABCDEFGHJKMNPQRSTVWXYZ' },
      },
    });

    // Advance beyond TTL (60s) and call tick to GC.
    now += 61_000;
    sync.tickFragmentGc();

    const timeouts = errors.filter(
      (e) =>
        typeof e.detail.reason === 'string' && (e.detail.reason as string).includes('fragment_timeout'),
    );
    expect(timeouts.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// In-memory Y.Doc LRU eviction (T035c)
// ---------------------------------------------------------------------------

describe('GroupDocCache — LRU eviction', () => {
  it('evicts the least-recently-accessed app when total bytes exceed cap', async () => {
    const cache = new GroupDocCache({ maxBytes: 150 });
    // Fake sizes: each entry reports a size via a getter.
    const a = { size: 80 };
    const b = { size: 80 };
    const c = { size: 80 };
    const evicted: string[] = [];

    cache.onEvict((slug) => {
      evicted.push(slug);
    });

    cache.put('a', a);
    cache.put('b', b);
    // At this point total=160, > 150 cap — "a" (least recent) evicted.
    expect(evicted).toEqual(['a']);

    // Touching "b" bumps its recency above "c" after insert.
    cache.get('b');
    cache.put('c', c);
    // total=160, evict least recent which is... b was more recent than c at
    // insert time, but we just touched b, so c is LRU. Wait — c was just
    // inserted so it's newest. b was touched, making it newer than... nothing.
    // The order now is: b=touched, c=just-inserted.
    // With b=80, c=80, total=160 > 150. Least recent is b (touched before c).
    expect(evicted).toEqual(['a', 'b']);
  });

  it('put/get/has/delete maintain correct cache size bookkeeping', async () => {
    const cache = new GroupDocCache({ maxBytes: 10_000 });
    const a = { size: 100 };
    cache.put('a', a);
    expect(cache.has('a')).toBe(true);
    expect(cache.get('a')).toBe(a);
    expect(cache.totalBytes()).toBe(100);

    cache.delete('a');
    expect(cache.has('a')).toBe(false);
    expect(cache.totalBytes()).toBe(0);
  });
});
