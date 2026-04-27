import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
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
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

describe('platform/db', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  it('inserts and retrieves a container', async () => {
    await insertContainer(db, {
      handle: 'alice',
      clerkUserId: 'clerk_1',
      containerId: 'ctr_abc',
      port: 4001,
      shellPort: 3001,
      status: 'running',
    });

    const c = await getContainer(db, 'alice');
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

  it('retrieves container by clerk user id', async () => {
    await insertContainer(db, {
      handle: 'bob',
      clerkUserId: 'clerk_2',
      containerId: null,
      port: 4002,
      shellPort: 3002,
      status: 'provisioning',
    });

    const c = await getContainerByClerkId(db, 'clerk_2');
    expect(c).toBeDefined();
    expect(c!.handle).toBe('bob');
  });

  it('returns undefined for non-existent container', async () => {
    await expect(getContainer(db, 'nobody')).resolves.toBeUndefined();
    await expect(getContainerByClerkId(db, 'no_clerk')).resolves.toBeUndefined();
  });

  it('updates container status', async () => {
    await insertContainer(db, {
      handle: 'alice',
      clerkUserId: 'clerk_1',
      containerId: null,
      port: 4001,
      shellPort: 3001,
      status: 'provisioning',
    });

    await updateContainerStatus(db, 'alice', 'running', 'ctr_xyz');
    const c = await getContainer(db, 'alice');
    expect(c!.status).toBe('running');
    expect(c!.containerId).toBe('ctr_xyz');
  });

  it('updates container status without container_id', async () => {
    await insertContainer(db, {
      handle: 'alice',
      clerkUserId: 'clerk_1',
      containerId: 'ctr_old',
      port: 4001,
      shellPort: 3001,
      status: 'running',
    });

    await updateContainerStatus(db, 'alice', 'stopped');
    const c = await getContainer(db, 'alice');
    expect(c!.status).toBe('stopped');
    expect(c!.containerId).toBe('ctr_old');
  });

  it('updates last_active timestamp', async () => {
    await insertContainer(db, {
      handle: 'alice',
      clerkUserId: 'clerk_1',
      containerId: null,
      port: 4001,
      shellPort: 3001,
      status: 'running',
    });

    const before = (await getContainer(db, 'alice'))!.lastActive;
    await updateLastActive(db, 'alice');
    const after = (await getContainer(db, 'alice'))!.lastActive;
    expect(after).toBeTruthy();
    expect(after >= before).toBe(true);
  });

  it('lists containers with optional status filter', async () => {
    await insertContainer(db, { handle: 'a', clerkUserId: 'c1', containerId: null, port: 4001, shellPort: 3001, status: 'running' });
    await insertContainer(db, { handle: 'b', clerkUserId: 'c2', containerId: null, port: 4002, shellPort: 3002, status: 'stopped' });
    await insertContainer(db, { handle: 'c', clerkUserId: 'c3', containerId: null, port: 4003, shellPort: 3003, status: 'running' });

    await expect(listContainers(db)).resolves.toHaveLength(3);
    await expect(listContainers(db, 'running')).resolves.toHaveLength(2);
    await expect(listContainers(db, 'stopped')).resolves.toHaveLength(1);
  });

  it('deletes a container', async () => {
    await insertContainer(db, { handle: 'alice', clerkUserId: 'c1', containerId: null, port: 4001, shellPort: 3001, status: 'running' });
    await deleteContainer(db, 'alice');
    await expect(getContainer(db, 'alice')).resolves.toBeUndefined();
  });

  it('allocates sequential ports', async () => {
    const p1 = await allocatePort(db, 4001, 'alice');
    expect(p1).toBe(4001);

    const p2 = await allocatePort(db, 4001, 'bob');
    expect(p2).toBe(4002);

    // Same handle returns same port
    const p1again = await allocatePort(db, 4001, 'alice');
    expect(p1again).toBe(4001);
  });

  it('releases ports', async () => {
    await allocatePort(db, 4001, 'alice');
    await allocatePort(db, 4001, 'bob');
    await releasePort(db, 'alice');

    // Bob still holds 4002, so carol gets 4003
    const p = await allocatePort(db, 4001, 'carol');
    expect(p).toBe(4003);
  });

  it('enforces unique clerk_user_id', async () => {
    await insertContainer(db, { handle: 'alice', clerkUserId: 'clerk_1', containerId: null, port: 4001, shellPort: 3001, status: 'running' });
    await expect(
      insertContainer(db, { handle: 'bob', clerkUserId: 'clerk_1', containerId: null, port: 4002, shellPort: 3002, status: 'running' }),
    ).rejects.toThrow();
  });
});
