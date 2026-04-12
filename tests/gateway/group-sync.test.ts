import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as Y from 'yjs';

import {
  GroupSync,
  type GroupSyncOptions,
  type GroupSyncErrorCode,
} from '../../packages/gateway/src/group-sync.js';
import type { GroupManifest } from '../../packages/gateway/src/group-types.js';
import type { MatrixClient, MatrixRawEvent } from '../../packages/gateway/src/matrix-client.js';
import { MatrixContentTooLargeError } from '../../packages/gateway/src/matrix-client.js';

// ---------------------------------------------------------------------------
// Test fixtures & fakes
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<GroupManifest> = {}): GroupManifest {
  return {
    room_id: '!testroom:matrix-os.com',
    name: 'Test Group',
    slug: 'test-group',
    owner_handle: '@alice:matrix-os.com',
    joined_at: 1_712_780_000_000,
    schema_version: 1,
    ...overrides,
  };
}

interface FakeClientState {
  sendCalls: Array<{ roomId: string; eventType: string; content: Record<string, unknown> }>;
  sendShouldFail: boolean;
  sendFailError: Error | null;
  state: Map<string, Record<string, unknown>>; // `${eventType}|${stateKey}` → content
  stateEvents: Array<{ type: string; state_key: string; content: Record<string, unknown>; event_id?: string; sender?: string; origin_server_ts?: number }>;
}

function makeFakeMatrixClient(): { client: MatrixClient; state: FakeClientState } {
  const state: FakeClientState = {
    sendCalls: [],
    sendShouldFail: false,
    sendFailError: null,
    state: new Map(),
    stateEvents: [],
  };

  const client: MatrixClient = {
    sendMessage: vi.fn(),
    createDM: vi.fn(),
    joinRoom: vi.fn(),
    getRoomMessages: vi.fn().mockResolvedValue({ messages: [], end: '', chunk: [] }),
    whoami: vi.fn().mockResolvedValue({ userId: '@alice:matrix-os.com' }),
    async sendCustomEvent(roomId, eventType, content) {
      state.sendCalls.push({ roomId, eventType, content });
      if (state.sendShouldFail) {
        throw state.sendFailError ?? new Error('fake send failure');
      }
      return { eventId: `$fake-${state.sendCalls.length}` };
    },
    sync: vi.fn(),
    createRoom: vi.fn(),
    inviteToRoom: vi.fn(),
    kickFromRoom: vi.fn(),
    leaveRoom: vi.fn(),
    async getRoomState(_roomId, eventType, stateKey) {
      return state.state.get(`${eventType}|${stateKey}`) ?? null;
    },
    async getAllRoomStateEvents(_roomId, eventType) {
      if (eventType) {
        return state.stateEvents.filter((e) => e.type === eventType);
      }
      return state.stateEvents;
    },
    async setRoomState(_roomId, eventType, stateKey, content) {
      state.state.set(`${eventType}|${stateKey}`, content);
      const entry = {
        type: eventType,
        state_key: stateKey,
        content,
        event_id: `$state-${state.stateEvents.length}`,
        sender: '@alice:matrix-os.com',
        origin_server_ts: Date.now(),
      };
      // replace existing entry with same (type, state_key)
      const idx = state.stateEvents.findIndex((e) => e.type === eventType && e.state_key === stateKey);
      if (idx >= 0) state.stateEvents[idx] = entry;
      else state.stateEvents.push(entry);
      return { eventId: entry.event_id };
    },
    getRoomMembers: vi.fn().mockResolvedValue([]),
    getPowerLevels: vi.fn().mockResolvedValue({ users: { '@alice:matrix-os.com': 100 }, users_default: 0 }),
    setPowerLevels: vi.fn(),
  };

  return { client, state };
}

interface RegisteredHandler {
  roomId: string;
  eventType: string;
  handler: (event: MatrixRawEvent, roomId: string) => Promise<void> | void;
}

function makeFakeSyncHub(): {
  hub: {
    registerEventHandler: (
      roomId: string,
      eventType: string,
      handler: (event: MatrixRawEvent, roomId: string) => Promise<void> | void,
    ) => { dispose(): void };
  };
  handlers: RegisteredHandler[];
  deliver(roomId: string, event: MatrixRawEvent): Promise<void>;
} {
  const handlers: RegisteredHandler[] = [];
  const hub = {
    registerEventHandler(
      roomId: string,
      eventType: string,
      handler: (event: MatrixRawEvent, roomId: string) => Promise<void> | void,
    ) {
      const entry: RegisteredHandler = { roomId, eventType, handler };
      handlers.push(entry);
      return {
        dispose() {
          const i = handlers.indexOf(entry);
          if (i >= 0) handlers.splice(i, 1);
        },
      };
    },
  };
  async function deliver(roomId: string, event: MatrixRawEvent): Promise<void> {
    // Match the hub's per-room serial dispatch contract.
    for (const h of handlers.filter((x) => x.roomId === roomId && x.eventType === event.type)) {
      await h.handler(event, roomId);
    }
  }
  return { hub, handlers, deliver };
}

async function makeTmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'group-sync-test-'));
}

async function scaffoldApp(homePath: string, groupSlug: string, appSlug: string): Promise<string> {
  const appDir = join(homePath, 'groups', groupSlug, 'apps', appSlug);
  await mkdir(appDir, { recursive: true });
  await writeFile(
    join(appDir, 'matrix.json'),
    JSON.stringify({ slug: appSlug, name: appSlug, version: '1.0.0' }),
  );
  await mkdir(join(homePath, 'groups', groupSlug, 'data', appSlug), { recursive: true });
  return appDir;
}

function encodeYjsUpdateFromDoc(mutator: (doc: Y.Doc) => void): string {
  const doc = new Y.Doc();
  const priorState = Y.encodeStateVector(doc);
  mutator(doc);
  const update = Y.encodeStateAsUpdate(doc, priorState);
  return Buffer.from(update).toString('base64');
}

function defaultOptions(
  homePath: string,
  manifest: GroupManifest,
  overrides: Partial<GroupSyncOptions> = {},
): GroupSyncOptions {
  const { client } = makeFakeMatrixClient();
  return {
    manifest,
    homePath,
    matrixClient: client,
    env: { /* defaults taken from constants */ },
    selfHandle: '@alice:matrix-os.com',
    clockNow: () => 1_712_780_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GroupSync — hydrate()', () => {
  let home: string;

  beforeEach(async () => {
    home = await makeTmpHome();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('creates an empty Y.Doc for an app with no state.bin', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client } = makeFakeMatrixClient();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
    });
    await sync.hydrate();

    const doc = sync.getDoc('notes');
    expect(doc).toBeInstanceOf(Y.Doc);
    // Empty doc: no keys
    const map = doc.getMap('kv');
    expect(Array.from(map.keys())).toEqual([]);
  });

  it('restores Y.Doc state from an existing state.bin', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');

    // Pre-populate state.bin with a real Yjs doc containing "greeting" → "hello"
    const priming = new Y.Doc();
    priming.getMap('kv').set('greeting', 'hello');
    const primed = Y.encodeStateAsUpdate(priming);
    const stateBinPath = join(home, 'groups', manifest.slug, 'data', 'notes', 'state.bin');
    await writeFile(stateBinPath, primed);

    const { client } = makeFakeMatrixClient();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
    });
    await sync.hydrate();

    const doc = sync.getDoc('notes');
    expect(doc.getMap('kv').get('greeting')).toBe('hello');
  });

  it('throws a typed error when state.bin is corrupt', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const stateBinPath = join(home, 'groups', manifest.slug, 'data', 'notes', 'state.bin');
    await writeFile(stateBinPath, Buffer.from([0xff, 0xff, 0xff, 0x00, 0xde, 0xad]));

    const { client } = makeFakeMatrixClient();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
    });

    await expect(sync.hydrate()).rejects.toThrow();
  });

  it('hydrate() with fresh=true skips any existing (corrupt) state.bin and starts empty', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const stateBinPath = join(home, 'groups', manifest.slug, 'data', 'notes', 'state.bin');
    await writeFile(stateBinPath, Buffer.from([0xff, 0xff, 0xff]));

    const { client } = makeFakeMatrixClient();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
      fresh: true,
    });
    await sync.hydrate();

    const doc = sync.getDoc('notes');
    expect(Array.from(doc.getMap('kv').keys())).toEqual([]);
  });
});

describe('GroupSync — applyRemoteOp', () => {
  let home: string;

  beforeEach(async () => {
    home = await makeTmpHome();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('decodes base64, applies Y.applyUpdate, persists state.bin atomically, and appends log.jsonl', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client } = makeFakeMatrixClient();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
    });
    await sync.hydrate();

    const updateB64 = encodeYjsUpdateFromDoc((doc) => {
      doc.getMap('kv').set('note1', 'hello');
    });

    await sync.applyRemoteOp('notes', {
      type: 'm.matrix_os.app.notes.op',
      event_id: '$op-1',
      sender: '@bob:matrix-os.com',
      origin_server_ts: 1_712_780_000_100,
      content: {
        v: 1,
        update: updateB64,
        lamport: 1,
        client_id: 'bob-1',
        origin: '@bob:matrix-os.com',
        ts: 1_712_780_000_100,
      },
    });

    // State applied in memory
    expect(sync.getDoc('notes').getMap('kv').get('note1')).toBe('hello');
    // state.bin persisted
    const stateBinPath = join(home, 'groups', manifest.slug, 'data', 'notes', 'state.bin');
    expect(existsSync(stateBinPath)).toBe(true);
    const bytes = await readFile(stateBinPath);
    const verify = new Y.Doc();
    Y.applyUpdate(verify, bytes);
    expect(verify.getMap('kv').get('note1')).toBe('hello');

    // log.jsonl appended
    const logPath = join(home, 'groups', manifest.slug, 'data', 'notes', 'log.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const logText = await readFile(logPath, 'utf-8');
    const lines = logText.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.event_id).toBe('$op-1');
    expect(entry.sender).toBe('@bob:matrix-os.com');

    // last_sync.json updated
    const lastSyncPath = join(home, 'groups', manifest.slug, 'data', 'notes', 'last_sync.json');
    expect(existsSync(lastSyncPath)).toBe(true);
    const lastSync = JSON.parse(await readFile(lastSyncPath, 'utf-8'));
    expect(lastSync.last_event_id).toBe('$op-1');
  });

  it('persists state.bin BEFORE last_sync.json (crash recovery invariant)', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client } = makeFakeMatrixClient();
    const writeOrder: string[] = [];
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
      debugOnWrite: (path) => {
        if (path.endsWith('state.bin')) writeOrder.push('state.bin');
        else if (path.endsWith('last_sync.json')) writeOrder.push('last_sync.json');
        else if (path.endsWith('log.jsonl')) writeOrder.push('log.jsonl');
      },
    });
    await sync.hydrate();

    const updateB64 = encodeYjsUpdateFromDoc((doc) => {
      doc.getMap('kv').set('note1', 'hi');
    });

    await sync.applyRemoteOp('notes', {
      type: 'm.matrix_os.app.notes.op',
      event_id: '$op-1',
      sender: '@alice:matrix-os.com',
      origin_server_ts: 1,
      content: {
        v: 1,
        update: updateB64,
        lamport: 1,
        client_id: 'alice-1',
        origin: '@alice:matrix-os.com',
        ts: 1,
      },
    });

    const stateIdx = writeOrder.indexOf('state.bin');
    const lastSyncIdx = writeOrder.indexOf('last_sync.json');
    expect(stateIdx).toBeGreaterThanOrEqual(0);
    expect(lastSyncIdx).toBeGreaterThanOrEqual(0);
    expect(stateIdx).toBeLessThan(lastSyncIdx);
  });

  it('fires onChange listeners after applying a remote op', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client } = makeFakeMatrixClient();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
    });
    await sync.hydrate();

    const calls: Array<{ origin: 'remote' | 'local' }> = [];
    sync.onChange('notes', (info) => {
      calls.push({ origin: info.origin });
    });

    const updateB64 = encodeYjsUpdateFromDoc((doc) => {
      doc.getMap('kv').set('k', 'v');
    });
    await sync.applyRemoteOp('notes', {
      type: 'm.matrix_os.app.notes.op',
      event_id: '$op-1',
      sender: '@bob:matrix-os.com',
      origin_server_ts: 1,
      content: {
        v: 1,
        update: updateB64,
        lamport: 1,
        client_id: 'bob-1',
        origin: '@bob:matrix-os.com',
        ts: 1,
      },
    });

    expect(calls.length).toBe(1);
    expect(calls[0]!.origin).toBe('remote');
  });

  it('writes bad updates to quarantine.jsonl and does not crash', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client } = makeFakeMatrixClient();
    const errorCalls: Array<{ code: GroupSyncErrorCode }> = [];
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
      onError: (code, _detail) => {
        errorCalls.push({ code });
      },
    });
    await sync.hydrate();

    // Non-base64 garbage update field — should fail schema or decode.
    await sync.applyRemoteOp('notes', {
      type: 'm.matrix_os.app.notes.op',
      event_id: '$bad-1',
      sender: '@bob:matrix-os.com',
      origin_server_ts: 1,
      content: {
        v: 1,
        update: '!!!not_base64!!!',
        lamport: 1,
        client_id: 'bob-1',
        origin: '@bob:matrix-os.com',
        ts: 1,
      },
    });

    // Must not crash. Doc remains empty.
    expect(Array.from(sync.getDoc('notes').getMap('kv').keys())).toEqual([]);

    const quarantinePath = join(
      home,
      'groups',
      manifest.slug,
      'data',
      'notes',
      'quarantine.jsonl',
    );
    expect(existsSync(quarantinePath)).toBe(true);
    const quarText = await readFile(quarantinePath, 'utf-8');
    expect(quarText.length).toBeGreaterThan(0);
  });
});

describe('GroupSync — applyLocalMutation', () => {
  let home: string;

  beforeEach(async () => {
    home = await makeTmpHome();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('encodes a Yjs delta, sends it via matrixClient, and persists on success', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client, state: clientState } = makeFakeMatrixClient();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
    });
    await sync.hydrate();

    await sync.applyLocalMutation('notes', (doc) => {
      doc.getMap('kv').set('note1', 'hello');
    });

    // A single sendCustomEvent was made with the right event type
    expect(clientState.sendCalls.length).toBe(1);
    const call = clientState.sendCalls[0]!;
    expect(call.eventType).toBe('m.matrix_os.app.notes.op');
    expect(call.roomId).toBe(manifest.room_id);
    expect(typeof call.content.update).toBe('string');

    // Doc was updated in memory
    expect(sync.getDoc('notes').getMap('kv').get('note1')).toBe('hello');

    // state.bin persisted
    const stateBinPath = join(home, 'groups', manifest.slug, 'data', 'notes', 'state.bin');
    expect(existsSync(stateBinPath)).toBe(true);
  });

  it('appends to queue.jsonl on send failure (not state.bin lost)', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client, state: clientState } = makeFakeMatrixClient();
    clientState.sendShouldFail = true;
    clientState.sendFailError = new Error('network down');

    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
    });
    await sync.hydrate();

    await sync.applyLocalMutation('notes', (doc) => {
      doc.getMap('kv').set('note1', 'hello');
    });

    const queuePath = join(home, 'groups', manifest.slug, 'data', 'notes', 'queue.jsonl');
    expect(existsSync(queuePath)).toBe(true);
    const text = await readFile(queuePath, 'utf-8');
    expect(text.trim().split('\n').length).toBeGreaterThanOrEqual(1);

    // Local doc still reflects the change (CRDT-optimistic)
    expect(sync.getDoc('notes').getMap('kv').get('note1')).toBe('hello');
  });

  it('fires onChange listeners with origin=local after a local mutation', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client } = makeFakeMatrixClient();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
    });
    await sync.hydrate();

    const origins: Array<'local' | 'remote'> = [];
    sync.onChange('notes', (info) => origins.push(info.origin));

    await sync.applyLocalMutation('notes', (doc) => {
      doc.getMap('kv').set('k', 'v');
    });

    expect(origins).toContain('local');
  });
});

describe('GroupSync — queue & offline replay', () => {
  let home: string;

  beforeEach(async () => {
    home = await makeTmpHome();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('drainQueue() replays queued ops in order, oldest first', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client, state: clientState } = makeFakeMatrixClient();

    // Start with network down, make 3 mutations.
    clientState.sendShouldFail = true;
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
    });
    await sync.hydrate();
    await sync.applyLocalMutation('notes', (doc) => doc.getMap('kv').set('k1', 'v1'));
    await sync.applyLocalMutation('notes', (doc) => doc.getMap('kv').set('k2', 'v2'));
    await sync.applyLocalMutation('notes', (doc) => doc.getMap('kv').set('k3', 'v3'));

    expect(clientState.sendCalls.length).toBe(3); // all attempted, all failed
    const initialFailedCount = clientState.sendCalls.length;

    // Network returns. Drain queue.
    clientState.sendShouldFail = false;
    await sync.drainQueue();

    // Queue replayed in order. New send calls appended — 3 replayed events.
    const replayed = clientState.sendCalls.slice(initialFailedCount);
    expect(replayed.length).toBe(3);
    // All replayed events are `m.matrix_os.app.notes.op`.
    for (const call of replayed) {
      expect(call.eventType).toBe('m.matrix_os.app.notes.op');
    }

    // queue.jsonl is empty/absent after drain.
    const queuePath = join(home, 'groups', manifest.slug, 'data', 'notes', 'queue.jsonl');
    const queueExists = existsSync(queuePath);
    if (queueExists) {
      const text = await readFile(queuePath, 'utf-8');
      expect(text.trim().length).toBe(0);
    }
  });

  it('drainQueue() leaves ops in queue if send fails during replay', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client, state: clientState } = makeFakeMatrixClient();

    clientState.sendShouldFail = true;
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
    });
    await sync.hydrate();
    await sync.applyLocalMutation('notes', (doc) => doc.getMap('kv').set('k1', 'v1'));
    await sync.applyLocalMutation('notes', (doc) => doc.getMap('kv').set('k2', 'v2'));

    // Still offline — drain should be a no-op.
    await sync.drainQueue();

    const queuePath = join(home, 'groups', manifest.slug, 'data', 'notes', 'queue.jsonl');
    expect(existsSync(queuePath)).toBe(true);
    const text = await readFile(queuePath, 'utf-8');
    const lines = text.trim().split('\n');
    expect(lines.length).toBe(2);
  });

  it('enforces 10000-event queue cap with drop-oldest and logged warning', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client, state: clientState } = makeFakeMatrixClient();

    clientState.sendShouldFail = true;
    const errorCalls: Array<{ code: GroupSyncErrorCode; detail: Record<string, unknown> }> = [];
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
      env: { GROUP_SYNC_QUEUE_MAX: 3 }, // tiny cap so the test is fast
      onError: (code, detail) => errorCalls.push({ code, detail }),
    });
    await sync.hydrate();

    for (let i = 0; i < 5; i++) {
      await sync.applyLocalMutation('notes', (doc) => doc.getMap('kv').set(`k${i}`, `v${i}`));
    }

    const queuePath = join(home, 'groups', manifest.slug, 'data', 'notes', 'queue.jsonl');
    expect(existsSync(queuePath)).toBe(true);
    const text = await readFile(queuePath, 'utf-8');
    const lines = text
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    // Cap is 3, so after 5 mutations only 3 remain (drop-oldest).
    expect(lines.length).toBe(3);

    // At least one onError was a queue-cap eviction.
    const evictions = errorCalls.filter(
      (c) =>
        typeof c.detail.reason === 'string' &&
        (c.detail.reason as string).includes('queue_evicted'),
    );
    expect(evictions.length).toBeGreaterThanOrEqual(1);
  });

  it('exponential backoff schedule drops to a 30 s cap', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client } = makeFakeMatrixClient();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
    });
    await sync.hydrate();

    // getNextBackoffMs(attempt) returns 1s/2s/4s/8s/16s/30s/30s/30s...
    expect(sync.getNextBackoffMs(0)).toBe(1_000);
    expect(sync.getNextBackoffMs(1)).toBe(2_000);
    expect(sync.getNextBackoffMs(2)).toBe(4_000);
    expect(sync.getNextBackoffMs(3)).toBe(8_000);
    expect(sync.getNextBackoffMs(4)).toBe(16_000);
    expect(sync.getNextBackoffMs(5)).toBe(30_000);
    expect(sync.getNextBackoffMs(6)).toBe(30_000);
    expect(sync.getNextBackoffMs(100)).toBe(30_000);
  });

  it('escalates via onError after 30 minutes of persistent failures', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client, state: clientState } = makeFakeMatrixClient();
    clientState.sendShouldFail = true;

    let now = 1_000_000;
    const errorCalls: Array<{ code: GroupSyncErrorCode; detail: Record<string, unknown> }> = [];
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
      clockNow: () => now,
      onError: (code, detail) => errorCalls.push({ code, detail }),
    });
    await sync.hydrate();

    // First failure — records start time.
    await sync.applyLocalMutation('notes', (doc) => doc.getMap('kv').set('k1', 'v1'));

    // Advance 29 minutes — still offline escalation only, not sync_failed yet.
    now += 29 * 60 * 1000;
    await sync.applyLocalMutation('notes', (doc) => doc.getMap('kv').set('k2', 'v2'));
    let persistentErrors = errorCalls.filter(
      (c) =>
        c.code === 'sync_failed' &&
        typeof c.detail.reason === 'string' &&
        (c.detail.reason as string).includes('persistent'),
    );
    expect(persistentErrors.length).toBe(0);

    // Advance past 30 minutes — escalation should fire.
    now += 2 * 60 * 1000; // total 31 minutes since first failure
    await sync.applyLocalMutation('notes', (doc) => doc.getMap('kv').set('k3', 'v3'));
    persistentErrors = errorCalls.filter(
      (c) =>
        c.code === 'sync_failed' &&
        typeof c.detail.reason === 'string' &&
        (c.detail.reason as string).includes('persistent'),
    );
    expect(persistentErrors.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Snapshot reader — loadLatestSnapshot
// ---------------------------------------------------------------------------

function seedSnapshotChunks(
  clientState: FakeClientState,
  appSlug: string,
  params: {
    snapshotId: string;
    generation: number;
    chunks: string[]; // base64 chunk payloads
    takenAtEventId?: string;
    writtenBy?: string;
  },
): void {
  const snapshotType = `m.matrix_os.app.${appSlug}.snapshot`;
  for (let i = 0; i < params.chunks.length; i++) {
    const content = {
      v: 1,
      snapshot_id: params.snapshotId,
      generation: params.generation,
      chunk_index: i,
      chunk_count: params.chunks.length,
      state: params.chunks[i]!,
      taken_at_event_id: params.takenAtEventId ?? '$last',
      taken_at: 1,
      written_by: params.writtenBy ?? '@alice:matrix-os.com',
    };
    const stateKey = `${params.snapshotId}/${i}`;
    clientState.stateEvents.push({
      type: snapshotType,
      state_key: stateKey,
      content,
      event_id: `$snap-${params.snapshotId}-${i}`,
      sender: params.writtenBy ?? '@alice:matrix-os.com',
      origin_server_ts: Date.now(),
    });
    clientState.state.set(`${snapshotType}|${stateKey}`, content);
  }
}

function makeYjsSnapshot(mutator: (doc: Y.Doc) => void): { bytes: Uint8Array; base64: string } {
  const doc = new Y.Doc();
  mutator(doc);
  const bytes = Y.encodeStateAsUpdate(doc);
  return { bytes, base64: Buffer.from(bytes).toString('base64') };
}

describe('GroupSync — loadLatestSnapshot', () => {
  let home: string;

  beforeEach(async () => {
    home = await makeTmpHome();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('returns null when no snapshot state events are present', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client } = makeFakeMatrixClient();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
    });
    await sync.hydrate();

    const result = await sync.loadLatestSnapshot('notes');
    expect(result).toBeNull();
  });

  it('assembles and decodes a single-chunk snapshot into a Uint8Array', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client, state: clientState } = makeFakeMatrixClient();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
    });
    await sync.hydrate();

    const snap = makeYjsSnapshot((doc) => {
      doc.getMap('kv').set('greeting', 'hello');
    });
    seedSnapshotChunks(clientState, 'notes', {
      snapshotId: '01HXYZABCDEFGHJKMNPQRSTVWX',
      generation: 1,
      chunks: [snap.base64],
    });

    const result = await sync.loadLatestSnapshot('notes');
    expect(result).not.toBeNull();
    const verify = new Y.Doc();
    Y.applyUpdate(verify, result!);
    expect(verify.getMap('kv').get('greeting')).toBe('hello');
  });

  it('assembles multi-chunk snapshots in chunk_index order', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client, state: clientState } = makeFakeMatrixClient();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
    });
    await sync.hydrate();

    const snap = makeYjsSnapshot((doc) => {
      const arr = doc.getArray<string>('tasks');
      arr.push(['buy milk', 'walk dog', 'call mom']);
    });

    // Split into 3 chunks of roughly equal size.
    const parts: string[] = [];
    const step = Math.ceil(snap.base64.length / 3);
    for (let i = 0; i < snap.base64.length; i += step) {
      parts.push(snap.base64.slice(i, i + step));
    }
    expect(parts.length).toBe(3);

    seedSnapshotChunks(clientState, 'notes', {
      snapshotId: '01HXYZABCDEFGHJKMNPQRSTVWY',
      generation: 42,
      chunks: parts,
    });

    const result = await sync.loadLatestSnapshot('notes');
    expect(result).not.toBeNull();
    // Round-trip equality: decode + re-encode gives the same snapshot bytes.
    const decoded = new Y.Doc();
    Y.applyUpdate(decoded, result!);
    const reEncoded = Y.encodeStateAsUpdate(decoded);
    const originalDecoded = new Y.Doc();
    Y.applyUpdate(originalDecoded, snap.bytes);
    const originalReEncoded = Y.encodeStateAsUpdate(originalDecoded);
    expect(Buffer.from(reEncoded).equals(Buffer.from(originalReEncoded))).toBe(true);
  });

  it('picks the highest generation among complete snapshot sets', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client, state: clientState } = makeFakeMatrixClient();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
    });
    await sync.hydrate();

    const oldSnap = makeYjsSnapshot((doc) => doc.getMap('kv').set('phase', 'old'));
    const newSnap = makeYjsSnapshot((doc) => doc.getMap('kv').set('phase', 'new'));

    seedSnapshotChunks(clientState, 'notes', {
      snapshotId: '01HXYZABCDEFGHJKMNPQRST001',
      generation: 1,
      chunks: [oldSnap.base64],
    });
    seedSnapshotChunks(clientState, 'notes', {
      snapshotId: '01HXYZABCDEFGHJKMNPQRST002',
      generation: 5,
      chunks: [newSnap.base64],
    });

    const result = await sync.loadLatestSnapshot('notes');
    expect(result).not.toBeNull();
    const verify = new Y.Doc();
    Y.applyUpdate(verify, result!);
    expect(verify.getMap('kv').get('phase')).toBe('new');
  });

  it('rejects mixed chunk sets per §C atomicity contract', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client, state: clientState } = makeFakeMatrixClient();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
    });
    await sync.hydrate();

    // Valid older snapshot, 1 chunk.
    const older = makeYjsSnapshot((doc) => doc.getMap('kv').set('tag', 'older'));
    seedSnapshotChunks(clientState, 'notes', {
      snapshotId: '01HXYZABCDEFGHJKMNPQRST999',
      generation: 1,
      chunks: [older.base64],
    });

    // Mixed chunk set: {A,0} {B,1} {A,2}, both claiming chunk_count=3 but
    // with different snapshot_ids. Readers must drop both and fall back.
    const A = '01HXYZABCDEFGHJKMNPQRSTAAA';
    const B = '01HXYZABCDEFGHJKMNPQRSTBBB';
    const snapshotType = 'm.matrix_os.app.notes.snapshot';
    clientState.stateEvents.push({
      type: snapshotType,
      state_key: `${A}/0`,
      content: {
        v: 1,
        snapshot_id: A,
        generation: 10,
        chunk_index: 0,
        chunk_count: 3,
        state: 'AAAA',
        taken_at_event_id: '$',
        taken_at: 1,
        written_by: '@alice:matrix-os.com',
      },
    });
    clientState.stateEvents.push({
      type: snapshotType,
      state_key: `${B}/1`,
      content: {
        v: 1,
        snapshot_id: B,
        generation: 10,
        chunk_index: 1,
        chunk_count: 3,
        state: 'BBBB',
        taken_at_event_id: '$',
        taken_at: 1,
        written_by: '@bob:matrix-os.com',
      },
    });
    clientState.stateEvents.push({
      type: snapshotType,
      state_key: `${A}/2`,
      content: {
        v: 1,
        snapshot_id: A,
        generation: 10,
        chunk_index: 2,
        chunk_count: 3,
        state: 'CCCC',
        taken_at_event_id: '$',
        taken_at: 1,
        written_by: '@alice:matrix-os.com',
      },
    });

    const result = await sync.loadLatestSnapshot('notes');
    // Must fall back to older complete snapshot (generation 1), NOT assemble
    // the mixed set. Some implementations may return null; both are OK per
    // the spec, but using the older snapshot is preferred.
    if (result === null) {
      // Acceptable per spec — loader bailed to "null" which means "fall back
      // to full timeline replay".
      return;
    }
    const verify = new Y.Doc();
    Y.applyUpdate(verify, result);
    expect(verify.getMap('kv').get('tag')).toBe('older');
  });

  it('skips incomplete chunk sets (missing chunk_index)', async () => {
    const manifest = makeManifest();
    await scaffoldApp(home, manifest.slug, 'notes');
    const { client, state: clientState } = makeFakeMatrixClient();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: client,
      selfHandle: '@alice:matrix-os.com',
    });
    await sync.hydrate();

    // Only chunks 0 and 2 for a snapshot claiming chunk_count=3.
    const snapshotType = 'm.matrix_os.app.notes.snapshot';
    const snapshotId = '01HXYZABCDEFGHJKMNPQRST111';
    clientState.stateEvents.push({
      type: snapshotType,
      state_key: `${snapshotId}/0`,
      content: {
        v: 1,
        snapshot_id: snapshotId,
        generation: 1,
        chunk_index: 0,
        chunk_count: 3,
        state: 'AAAA',
        taken_at_event_id: '$',
        taken_at: 1,
        written_by: '@alice:matrix-os.com',
      },
    });
    clientState.stateEvents.push({
      type: snapshotType,
      state_key: `${snapshotId}/2`,
      content: {
        v: 1,
        snapshot_id: snapshotId,
        generation: 1,
        chunk_index: 2,
        chunk_count: 3,
        state: 'CCCC',
        taken_at_event_id: '$',
        taken_at: 1,
        written_by: '@alice:matrix-os.com',
      },
    });

    const result = await sync.loadLatestSnapshot('notes');
    expect(result).toBeNull();
  });
});
