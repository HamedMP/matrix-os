import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  createPlatformDb,
  type PlatformDB,
  insertContainer,
  getContainer,
  getContainerByClerkId,
  updateContainerStatus,
  updateLastActive,
  listContainers,
  deleteContainer,
  allocatePort,
  releasePort,
} from '../../packages/platform/src/db.js';

describe('platform/db', () => {
  let tmpDir: string;
  let db: PlatformDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'platform-db-'));
    db = createPlatformDb(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts and retrieves a container', () => {
    insertContainer(db, {
      handle: 'alice',
      clerkUserId: 'clerk_1',
      containerId: 'ctr_abc',
      port: 4001,
      shellPort: 3001,
      status: 'running',
    });

    const c = getContainer(db, 'alice');
    expect(c).toBeDefined();
    expect(c!.handle).toBe('alice');
    expect(c!.clerkUserId).toBe('clerk_1');
    expect(c!.containerId).toBe('ctr_abc');
    expect(c!.port).toBe(4001);
    expect(c!.shellPort).toBe(3001);
    expect(c!.status).toBe('running');
    expect(c!.createdAt).toBeTruthy();
    expect(c!.lastActive).toBeTruthy();
  });

  it('retrieves container by clerk user id', () => {
    insertContainer(db, {
      handle: 'bob',
      clerkUserId: 'clerk_2',
      containerId: null,
      port: 4002,
      shellPort: 3002,
      status: 'provisioning',
    });

    const c = getContainerByClerkId(db, 'clerk_2');
    expect(c).toBeDefined();
    expect(c!.handle).toBe('bob');
  });

  it('returns undefined for non-existent container', () => {
    expect(getContainer(db, 'nobody')).toBeUndefined();
    expect(getContainerByClerkId(db, 'no_clerk')).toBeUndefined();
  });

  it('updates container status', () => {
    insertContainer(db, {
      handle: 'alice',
      clerkUserId: 'clerk_1',
      containerId: null,
      port: 4001,
      shellPort: 3001,
      status: 'provisioning',
    });

    updateContainerStatus(db, 'alice', 'running', 'ctr_xyz');
    const c = getContainer(db, 'alice');
    expect(c!.status).toBe('running');
    expect(c!.containerId).toBe('ctr_xyz');
  });

  it('updates container status without container_id', () => {
    insertContainer(db, {
      handle: 'alice',
      clerkUserId: 'clerk_1',
      containerId: 'ctr_old',
      port: 4001,
      shellPort: 3001,
      status: 'running',
    });

    updateContainerStatus(db, 'alice', 'stopped');
    const c = getContainer(db, 'alice');
    expect(c!.status).toBe('stopped');
    expect(c!.containerId).toBe('ctr_old');
  });

  it('updates last_active timestamp', () => {
    insertContainer(db, {
      handle: 'alice',
      clerkUserId: 'clerk_1',
      containerId: null,
      port: 4001,
      shellPort: 3001,
      status: 'running',
    });

    const before = getContainer(db, 'alice')!.lastActive;
    updateLastActive(db, 'alice');
    const after = getContainer(db, 'alice')!.lastActive;
    expect(after).toBeTruthy();
    expect(after >= before).toBe(true);
  });

  it('lists containers with optional status filter', () => {
    insertContainer(db, { handle: 'a', clerkUserId: 'c1', containerId: null, port: 4001, shellPort: 3001, status: 'running' });
    insertContainer(db, { handle: 'b', clerkUserId: 'c2', containerId: null, port: 4002, shellPort: 3002, status: 'stopped' });
    insertContainer(db, { handle: 'c', clerkUserId: 'c3', containerId: null, port: 4003, shellPort: 3003, status: 'running' });

    expect(listContainers(db)).toHaveLength(3);
    expect(listContainers(db, 'running')).toHaveLength(2);
    expect(listContainers(db, 'stopped')).toHaveLength(1);
  });

  it('deletes a container', () => {
    insertContainer(db, { handle: 'alice', clerkUserId: 'c1', containerId: null, port: 4001, shellPort: 3001, status: 'running' });
    deleteContainer(db, 'alice');
    expect(getContainer(db, 'alice')).toBeUndefined();
  });

  it('allocates sequential ports', () => {
    const p1 = allocatePort(db, 4001, 'alice');
    expect(p1).toBe(4001);

    const p2 = allocatePort(db, 4001, 'bob');
    expect(p2).toBe(4002);

    // Same handle returns same port
    const p1again = allocatePort(db, 4001, 'alice');
    expect(p1again).toBe(4001);
  });

  it('releases ports', () => {
    allocatePort(db, 4001, 'alice');
    allocatePort(db, 4001, 'bob');
    releasePort(db, 'alice');

    // Bob still holds 4002, so carol gets 4003
    const p = allocatePort(db, 4001, 'carol');
    expect(p).toBe(4003);
  });

  it('enforces unique clerk_user_id', () => {
    insertContainer(db, { handle: 'alice', clerkUserId: 'clerk_1', containerId: null, port: 4001, shellPort: 3001, status: 'running' });
    expect(() => {
      insertContainer(db, { handle: 'bob', clerkUserId: 'clerk_1', containerId: null, port: 4002, shellPort: 3002, status: 'running' });
    }).toThrow();
  });
});
