import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as fc from 'fast-check';
import * as Y from 'yjs';

import { GroupSync } from '../../packages/gateway/src/group-sync.js';
import type { GroupManifest } from '../../packages/gateway/src/group-types.js';
import type { MatrixClient } from '../../packages/gateway/src/matrix-client.js';

/**
 * Convergence property test (T028 + spike §8 Q3).
 *
 * Three simulated GroupSync instances exchange local mutations via a shared
 * fake Matrix bus. After every instance has applied every peer's ops, all
 * three must converge to the SAME final doc state.
 *
 * Spike §8 Q3 confirmed byte-level equality holds for Yjs convergence, so
 * we check both JSON equality (semantic) AND byte equality (stronger) to
 * catch subtle bugs in our persistence ordering.
 *
 * 200 random sequences per run.
 */

interface FakeBus {
  pending: Map<string, Array<{ appSlug: string; content: Record<string, unknown> }>>;
}

function makeBus(): FakeBus {
  return { pending: new Map() };
}

function makeBusClient(
  bus: FakeBus,
  selfId: string,
  peerIds: string[],
): MatrixClient {
  return {
    sendMessage: vi.fn(),
    createDM: vi.fn(),
    joinRoom: vi.fn(),
    getRoomMessages: vi.fn(),
    whoami: vi.fn(),
    async sendCustomEvent(_roomId, eventType, content) {
      const m = /^m\.matrix_os\.app\.([^.]+)\.op$/.exec(eventType);
      if (!m) return { eventId: '' };
      const appSlug = m[1]!;
      for (const peer of peerIds) {
        if (peer === selfId) continue;
        const list = bus.pending.get(peer) ?? [];
        list.push({ appSlug, content });
        bus.pending.set(peer, list);
      }
      return { eventId: '' };
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
}

function makeManifest(slug: string): GroupManifest {
  return {
    room_id: '!shared:matrix-os.com',
    name: slug,
    slug,
    owner_handle: '@alice:matrix-os.com',
    joined_at: 1,
    schema_version: 1,
  };
}

async function scaffoldApp(home: string, group: string, app: string): Promise<void> {
  await mkdir(join(home, 'groups', group, 'apps', app), { recursive: true });
  await writeFile(
    join(home, 'groups', group, 'apps', app, 'matrix.json'),
    JSON.stringify({ slug: app, name: app, version: '1.0.0' }),
  );
  await mkdir(join(home, 'groups', group, 'data', app), { recursive: true });
}

async function drainBus(
  bus: FakeBus,
  peerIds: string[],
  syncs: Map<string, GroupSync>,
): Promise<void> {
  let anyDelivered = true;
  while (anyDelivered) {
    anyDelivered = false;
    for (const peer of peerIds) {
      const list = bus.pending.get(peer);
      if (!list || list.length === 0) continue;
      const snapshot = list.slice();
      bus.pending.set(peer, []);
      const sync = syncs.get(peer)!;
      for (let i = 0; i < snapshot.length; i++) {
        const { appSlug, content } = snapshot[i]!;
        await sync.applyRemoteOp(appSlug, {
          type: `m.matrix_os.app.${appSlug}.op`,
          event_id: `$${peer}-${i}`,
          sender: '@ignored:matrix-os.com',
          origin_server_ts: 1,
          content,
        });
      }
      anyDelivered = true;
    }
  }
}

describe('GroupSync convergence property T028', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'group-sync-conflict-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('three peers converge byte-equal after 200 random mutation sequences', { timeout: 30_000 }, async () => {
    const PEERS = ['peer-a', 'peer-b', 'peer-c'];

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            peer: fc.constantFrom(...PEERS),
            key: fc
              .string({ minLength: 1, maxLength: 8 })
              .filter((s) => /^[a-z0-9]+$/i.test(s)),
            value: fc.string({ maxLength: 16 }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        async (mutations) => {
          const iterHome = await mkdtemp(join(tmpdir(), 'gs-conflict-iter-'));
          try {
            const bus = makeBus();
            const syncs = new Map<string, GroupSync>();
            for (const peer of PEERS) {
              bus.pending.set(peer, []);
              await scaffoldApp(iterHome, peer, 'notes');
              const client = makeBusClient(bus, peer, PEERS);
              const sync = new GroupSync({
                manifest: makeManifest(peer),
                homePath: iterHome,
                matrixClient: client,
                selfHandle: `@${peer}:matrix-os.com`,
              });
              await sync.hydrate();
              syncs.set(peer, sync);
            }

            for (const mut of mutations) {
              const sync = syncs.get(mut.peer)!;
              await sync.applyLocalMutation('notes', (doc) => {
                doc.getMap('kv').set(mut.key, mut.value);
              });
              await drainBus(bus, PEERS, syncs);
            }
            await drainBus(bus, PEERS, syncs);

            // Byte equality of the full state is the strongest convergence
            // check — spike §8 Q3 confirmed it holds in practice. Y.Doc
            // `toJSON()` is NOT safe: it only materializes types that have
            // been accessed via `getMap`/`getArray`, so a fresh peer that
            // only applied an update will return `{}` until someone calls
            // `getMap('kv')` explicitly. Byte-level `encodeStateAsUpdate`
            // is deterministic and independent of access patterns.
            const bytes = PEERS.map((p) =>
              Buffer.from(Y.encodeStateAsUpdate(syncs.get(p)!.getDoc('notes'))),
            );
            for (let i = 1; i < bytes.length; i++) {
              if (!bytes[i]!.equals(bytes[0]!)) {
                throw new Error(`byte-level divergence at peer${i}`);
              }
            }

            // Also check semantic equality by forcing materialization of
            // the shared map on every peer BEFORE serializing.
            const jsons = PEERS.map((p) => {
              const doc = syncs.get(p)!.getDoc('notes');
              doc.getMap('kv'); // materialize
              return JSON.stringify(doc.toJSON());
            });
            for (let i = 1; i < jsons.length; i++) {
              if (jsons[i] !== jsons[0]) {
                throw new Error(
                  `semantic divergence peer0 vs peer${i}: ${jsons[0]} vs ${jsons[i]}`,
                );
              }
            }
          } finally {
            await rm(iterHome, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('GroupSync cold-start performance T033', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gs-perf-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('hydrates a 1000-mutation state.bin in under 1 second', async () => {
    const manifest = makeManifest('perf-group');
    await scaffoldApp(home, manifest.slug, 'notes');

    const seed = new Y.Doc();
    seed.transact(() => {
      const arr = seed.getArray<string>('items');
      for (let i = 0; i < 1000; i++) arr.push([`item-${i}`]);
    });
    const bytes = Y.encodeStateAsUpdate(seed);
    const stateBinPath = join(home, 'groups', manifest.slug, 'data', 'notes', 'state.bin');
    await writeFile(stateBinPath, bytes);

    const start = Date.now();
    const sync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: (null as unknown) as MatrixClient,
      selfHandle: '@alice:matrix-os.com',
    });
    await sync.hydrate();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);

    const doc = sync.getDoc('notes');
    expect(doc.getArray('items').length).toBe(1000);
  });

  it('corrupt state.bin falls back to fresh hydrate when caller sets fresh=true', async () => {
    const manifest = makeManifest('perf-corrupt');
    await scaffoldApp(home, manifest.slug, 'notes');

    const stateBinPath = join(home, 'groups', manifest.slug, 'data', 'notes', 'state.bin');
    await writeFile(stateBinPath, Buffer.from([0xff, 0x00, 0xde, 0xad, 0xbe, 0xef]));

    const firstSync = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: (null as unknown) as MatrixClient,
      selfHandle: '@alice:matrix-os.com',
    });
    await expect(firstSync.hydrate()).rejects.toThrow();

    const fresh = new GroupSync({
      manifest,
      homePath: home,
      matrixClient: (null as unknown) as MatrixClient,
      selfHandle: '@alice:matrix-os.com',
      fresh: true,
    });
    await fresh.hydrate();
    expect(fresh.getDoc('notes').getArray('items').length).toBe(0);
  });
});
