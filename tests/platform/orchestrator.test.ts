import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import pg from 'pg';
import { type PlatformDB, getContainer } from '../../packages/platform/src/db.js';
import { createOrchestrator, type Orchestrator } from '../../packages/platform/src/orchestrator.js';

function createMockDocker() {
  const mockContainer = {
    id: 'mock-container-id',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };

  const docker = {
    listNetworks: vi.fn().mockResolvedValue([{ Name: 'matrixos-net' }]),
    createNetwork: vi.fn().mockResolvedValue({}),
    createContainer: vi.fn().mockResolvedValue(mockContainer),
    getContainer: vi.fn().mockReturnValue(mockContainer),
    pull: vi.fn().mockResolvedValue(undefined),
  };

  return { docker, mockContainer };
}

describe('platform/orchestrator', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  it('provisions a container', async () => {
    const { docker } = createMockDocker();
    const orch = createOrchestrator({ db, docker: docker as any });

    const record = await orch.provision('alice', 'clerk_1');
    expect(record.handle).toBe('alice');
    expect(record.status).toBe('running');
    expect(record.containerId).toBe('mock-container-id');
    expect(record.port).toBeGreaterThanOrEqual(4001);
    expect(record.shellPort).toBeGreaterThanOrEqual(3001);

    expect(docker.createContainer).toHaveBeenCalledOnce();
    const createArgs = docker.createContainer.mock.calls[0][0];
    expect(createArgs.Env).toContain('MATRIX_HANDLE=alice');
    expect(createArgs.Env).toContain('MATRIX_USER_ID=clerk_1');
    expect(createArgs.name).toBe('matrixos-alice');
  });

  it('uses platform internal auth helpers instead of injecting PLATFORM_DATABASE_URL', async () => {
    const { docker } = createMockDocker();
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ rows: [{ 1: 1 }] }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const clientSpy = vi.spyOn(pg, 'Client').mockImplementation(function MockClient() {
      return mockClient as any;
    } as unknown as typeof pg.Client);
    const orch = createOrchestrator({
      db,
      docker: docker as any,
      postgresUrl: 'postgres://postgres@db:5432',
      platformSecret: 'platform-secret-123',
    });

    await orch.provision('alice', 'clerk_1');

    const createArgs = docker.createContainer.mock.calls[0][0];
    expect(createArgs.Env).toContain('DATABASE_URL=postgres://postgres@db:5432/matrixos_alice');
    expect(createArgs.Env).toContain('PLATFORM_INTERNAL_URL=http://distro-platform-1:9000');
    expect(createArgs.Env.some((value: string) => value.startsWith('UPGRADE_TOKEN='))).toBe(true);
    expect(createArgs.Env.some((value: string) => value.startsWith('MATRIX_AUTH_TOKEN='))).toBe(true);
    expect(createArgs.Env.some((value: string) => value.startsWith('MATRIX_CODE_PROXY_TOKEN='))).toBe(true);
    expect(createArgs.Env.some((value: string) => value.startsWith('PLATFORM_DATABASE_URL='))).toBe(false);
    clientSpy.mockRestore();
  });

  it('passes MATRIX_USER_ID on upgrade so home-mirror keeps its R2 prefix', async () => {
    const { docker, mockContainer } = createMockDocker();
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('bob', 'user_2abc');
    docker.createContainer.mockClear();
    mockContainer.start.mockClear();

    await orch.upgrade('bob');

    expect(docker.createContainer).toHaveBeenCalledOnce();
    const upgradeArgs = docker.createContainer.mock.calls[0][0];
    expect(upgradeArgs.Env).toContain('MATRIX_USER_ID=user_2abc');
    expect(upgradeArgs.Env).toContain('MATRIX_HANDLE=bob');
  });

  it('passes MATRIX_USER_ID on rolling restart', async () => {
    const { docker } = createMockDocker();
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('carol', 'user_2def');
    docker.createContainer.mockClear();

    await orch.rollingRestart();

    expect(docker.createContainer).toHaveBeenCalledOnce();
    const restartArgs = docker.createContainer.mock.calls[0][0];
    expect(restartArgs.Env).toContain('MATRIX_USER_ID=user_2def');
    expect(restartArgs.Env).toContain('MATRIX_HANDLE=carol');
  });

  // Silent-failure #12: a missing clerkUserId on the DB record would
  // cause buildEnv to drop MATRIX_USER_ID, regressing e5b72dc (home-mirror
  // would fall back to the handle-prefixed R2 key). upgrade must refuse.
  it('upgrade throws if the container record has no clerkUserId', async () => {
    const { docker } = createMockDocker();
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('dan', 'user_2ghi');
    // Simulate legacy DB row: blank out clerkUserId directly in the DB
    // bypassing the type-safe insert path.
    await db.executor
      .updateTable('containers')
      .set({ clerk_user_id: '' })
      .where('handle', '=', 'dan')
      .execute();

    await expect(orch.upgrade('dan')).rejects.toThrow(
      /No clerkUserId in container record for handle 'dan'/,
    );
    // Also sanity: no container was recreated.
    expect(docker.createContainer).toHaveBeenCalledOnce(); // the provision call
  });

  it('rollingRestart skips-with-failure for a record missing clerkUserId', async () => {
    const { docker } = createMockDocker();
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('erin', 'user_2jkl');
    await orch.provision('frank', 'user_2mno');
    // Corrupt one record to simulate partial-failure state.
    await db.executor
      .updateTable('containers')
      .set({ clerk_user_id: '' })
      .where('handle', '=', 'erin')
      .execute();
    docker.createContainer.mockClear();

    const result = await orch.rollingRestart();

    // The good record should still be restarted; the bad one reported as failed.
    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    const failure = result.results.find((r) => r.status === 'failed');
    expect(failure?.handle).toBe('erin');
    expect(failure?.error).toMatch(/No clerkUserId in container record for handle 'erin'/);
  });

  it('rejects duplicate handles', async () => {
    const { docker } = createMockDocker();
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('alice', 'clerk_1');
    await expect(orch.provision('alice', 'clerk_2')).rejects.toThrow('already exists');
  });

  it('releases allocated ports when container creation fails', async () => {
    const { docker } = createMockDocker();
    docker.createContainer.mockRejectedValueOnce(new Error('create failed'));
    const orch = createOrchestrator({ db, docker: docker as any });

    await expect(orch.provision('alice', 'clerk_1')).rejects.toThrow('create failed');
    expect(await getContainer(db, 'alice')).toBeUndefined();

    const record = await orch.provision('bob', 'clerk_2');
    expect(record.port).toBe(4001);
    expect(record.shellPort).toBe(4002);
  });

  it('releases reserved ports and avoids starting a container when the initial DB insert fails', async () => {
    const firstContainer = {
      id: 'container-1',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const secondContainer = {
      id: 'container-2',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const { docker } = createMockDocker();
    docker.createContainer
      .mockResolvedValueOnce(firstContainer)
      .mockResolvedValueOnce(secondContainer)
      .mockResolvedValueOnce({
        id: 'container-3',
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      });
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('alice', 'clerk_1');
    await expect(orch.provision('bob', 'clerk_1')).rejects.toThrow();
    expect(secondContainer.start).not.toHaveBeenCalled();
    expect(secondContainer.remove).not.toHaveBeenCalled();

    const record = await orch.provision('carol', 'clerk_3');
    expect(record.port).toBe(4003);
    expect(record.shellPort).toBe(4004);
  });

  it('creates network if not exists', async () => {
    const { docker } = createMockDocker();
    docker.listNetworks.mockResolvedValue([]);
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('alice', 'clerk_1');
    expect(docker.createNetwork).toHaveBeenCalledWith({ Name: 'matrixos-net', Driver: 'bridge' });
  });

  it('uses a sanitized database identifier for per-user Postgres databases', async () => {
    const { docker } = createMockDocker();
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({}),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const clientSpy = vi.spyOn(pg, 'Client').mockImplementation(function MockClient() {
      return mockClient as any;
    } as unknown as typeof pg.Client);
    const orch = createOrchestrator({
      db,
      docker: docker as any,
      postgresUrl: 'postgres://postgres@db:5432',
    });

    await orch.provision('alice-admin.prod', 'clerk_1');

    expect(clientSpy).toHaveBeenCalledWith({
      connectionString: 'postgres://postgres@db:5432/matrixos',
      connectionTimeoutMillis: 10_000,
    });

    expect(mockClient.query).toHaveBeenNthCalledWith(
      1,
      'SELECT 1 FROM pg_database WHERE datname = $1',
      ['matrixos_alice_admin_prod'],
    );
    expect(mockClient.query).toHaveBeenNthCalledWith(
      2,
      'CREATE DATABASE "matrixos_alice_admin_prod"',
    );

    clientSpy.mockRestore();
  });

  it('uses a Postgres connection timeout when dropping a user database', async () => {
    const { docker } = createMockDocker();
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ rows: [{ 1: 1 }] }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const clientSpy = vi.spyOn(pg, 'Client').mockImplementation(function MockClient() {
      return mockClient as any;
    } as unknown as typeof pg.Client);
    const orch = createOrchestrator({
      db,
      docker: docker as any,
      postgresUrl: 'postgres://postgres@db:5432',
    });

    await orch.provision('alice', 'clerk_1');
    await orch.destroy('alice');

    expect(clientSpy).toHaveBeenCalledWith({
      connectionString: 'postgres://postgres@db:5432/matrixos',
      connectionTimeoutMillis: 10_000,
    });
    expect(mockClient.query).toHaveBeenCalledWith('DROP DATABASE IF EXISTS "matrixos_alice"');

    clientSpy.mockRestore();
  });

  it('starts a stopped container', async () => {
    const { docker, mockContainer } = createMockDocker();
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('alice', 'clerk_1');
    await orch.stop('alice');
    mockContainer.start.mockClear();

    await orch.start('alice');
    expect(mockContainer.start).toHaveBeenCalledOnce();
    expect((await orch.getInfo('alice'))!.status).toBe('running');
  });

  it('no-ops when starting an already running container', async () => {
    const { docker, mockContainer } = createMockDocker();
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('alice', 'clerk_1');
    mockContainer.start.mockClear();

    await orch.start('alice');
    expect(mockContainer.start).not.toHaveBeenCalled();
  });

  it('stops a running container', async () => {
    const { docker, mockContainer } = createMockDocker();
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('alice', 'clerk_1');
    await orch.stop('alice');

    expect(mockContainer.stop).toHaveBeenCalledOnce();
    expect((await orch.getInfo('alice'))!.status).toBe('stopped');
  });

  it('destroys a container and releases ports', async () => {
    const { docker, mockContainer } = createMockDocker();
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('alice', 'clerk_1');
    await orch.destroy('alice');

    expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    expect(await orch.getInfo('alice')).toBeUndefined();
  });

  it('logs cleanup failures during destroy instead of swallowing them', async () => {
    const { docker, mockContainer } = createMockDocker();
    mockContainer.stop.mockRejectedValueOnce(new Error('stop failed'));
    mockContainer.remove.mockRejectedValueOnce(new Error('remove failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('alice', 'clerk_1');
    await orch.destroy('alice');

    expect(warnSpy).toHaveBeenCalledWith(
      '[orchestrator] Failed to stop container for alice:',
      'stop failed',
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[orchestrator] Failed to remove container for alice:',
      'remove failed',
    );
    expect(await orch.getInfo('alice')).toBeUndefined();
  });

  it('lists containers with optional status filter', async () => {
    const { docker } = createMockDocker();
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('alice', 'clerk_1');
    await orch.provision('bob', 'clerk_2');
    await orch.stop('bob');

    expect(await orch.listAll()).toHaveLength(2);
    expect(await orch.listAll('running')).toHaveLength(1);
    expect(await orch.listAll('stopped')).toHaveLength(1);
  });

  it('throws when operating on non-existent handle', async () => {
    const { docker } = createMockDocker();
    const orch = createOrchestrator({ db, docker: docker as any });

    await expect(orch.start('ghost')).rejects.toThrow('No container');
    await expect(orch.stop('ghost')).rejects.toThrow('No container');
    await expect(orch.destroy('ghost')).rejects.toThrow('No container');
  });

  it('upgrades a container (pull + recreate)', async () => {
    const { docker, mockContainer } = createMockDocker();
    const newMockContainer = {
      id: 'new-container-id',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('alice', 'clerk_1');
    const before = (await orch.getInfo('alice'))!;
    expect(before.containerId).toBe('mock-container-id');

    docker.createContainer.mockResolvedValue(newMockContainer);

    const after = await orch.upgrade('alice');
    expect(docker.pull).toHaveBeenCalled();
    expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    expect(after.containerId).toBe('new-container-id');
    expect(after.status).toBe('running');
    expect(after.port).toBe(before.port);
  });

  it('syncStates reconciles DB with Docker state', async () => {
    const { docker, mockContainer } = createMockDocker();
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('alice', 'clerk_1');
    expect((await orch.getInfo('alice'))!.status).toBe('running');

    docker.getContainer.mockReturnValue({
      ...mockContainer,
      inspect: vi.fn().mockResolvedValue({ State: { Running: false } }),
    });

    await orch.syncStates();
    expect((await orch.getInfo('alice'))!.status).toBe('stopped');
  });

  it('syncStates marks container stopped when Docker inspect fails', async () => {
    const { docker, mockContainer } = createMockDocker();
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('alice', 'clerk_1');

    docker.getContainer.mockReturnValue({
      ...mockContainer,
      inspect: vi.fn().mockRejectedValue(new Error('no such container')),
    });

    await orch.syncStates();
    expect((await orch.getInfo('alice'))!.status).toBe('stopped');
  });

  describe('rollingRestart', () => {
    it('upgrades all running containers sequentially', async () => {
      const { docker, mockContainer } = createMockDocker();
      let containerId = 0;
      docker.createContainer.mockImplementation(async () => ({
        id: `container-${++containerId}`,
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      }));
      const orch = createOrchestrator({ db, docker: docker as any });

      await orch.provision('alice', 'clerk_1');
      await orch.provision('bob', 'clerk_2');
      await orch.provision('charlie', 'clerk_3');
      await orch.stop('charlie');

      const result = await orch.rollingRestart();

      expect(result.total).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.results).toHaveLength(2);
      expect(result.results.every((r) => r.status === 'upgraded')).toBe(true);
      expect(docker.pull).toHaveBeenCalledOnce();
    });

    it('skips stopped containers', async () => {
      const { docker } = createMockDocker();
      const orch = createOrchestrator({ db, docker: docker as any });

      await orch.provision('alice', 'clerk_1');
      await orch.stop('alice');

      const result = await orch.rollingRestart();

      expect(result.total).toBe(0);
      expect(result.succeeded).toBe(0);
      expect(result.skipped).toEqual(['alice']);
    });

    it('continues on failure and reports errors', async () => {
      const { docker } = createMockDocker();
      let callCount = 0;
      docker.createContainer.mockImplementation(async () => {
        callCount++;
        if (callCount === 3) throw new Error('disk full');
        return {
          id: `container-${callCount}`,
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        };
      });
      const orch = createOrchestrator({ db, docker: docker as any });

      await orch.provision('alice', 'clerk_1');
      await orch.provision('bob', 'clerk_2');

      const result = await orch.rollingRestart();

      expect(result.total).toBe(2);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.results.find((r) => r.status === 'failed')?.error).toBe('disk full');
    });

    it('returns empty result when no containers exist', async () => {
      const { docker } = createMockDocker();
      const orch = createOrchestrator({ db, docker: docker as any });

      const result = await orch.rollingRestart();

      expect(result.total).toBe(0);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
      expect(docker.pull).not.toHaveBeenCalled();
    });
  });
});
