import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createPlatformDb, type PlatformDB, getContainer } from '../../packages/platform/src/db.js';
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
  let tmpDir: string;
  let db: PlatformDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'platform-orch-'));
    db = createPlatformDb(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
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

  it('rejects duplicate handles', async () => {
    const { docker } = createMockDocker();
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('alice', 'clerk_1');
    await expect(orch.provision('alice', 'clerk_2')).rejects.toThrow('already exists');
  });

  it('creates network if not exists', async () => {
    const { docker } = createMockDocker();
    docker.listNetworks.mockResolvedValue([]);
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('alice', 'clerk_1');
    expect(docker.createNetwork).toHaveBeenCalledWith({ Name: 'matrixos-net', Driver: 'bridge' });
  });

  it('starts a stopped container', async () => {
    const { docker, mockContainer } = createMockDocker();
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('alice', 'clerk_1');
    await orch.stop('alice');
    mockContainer.start.mockClear();

    await orch.start('alice');
    expect(mockContainer.start).toHaveBeenCalledOnce();
    expect(orch.getInfo('alice')!.status).toBe('running');
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
    expect(orch.getInfo('alice')!.status).toBe('stopped');
  });

  it('destroys a container and releases ports', async () => {
    const { docker, mockContainer } = createMockDocker();
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('alice', 'clerk_1');
    await orch.destroy('alice');

    expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    expect(orch.getInfo('alice')).toBeUndefined();
  });

  it('lists containers with optional status filter', async () => {
    const { docker } = createMockDocker();
    const orch = createOrchestrator({ db, docker: docker as any });

    await orch.provision('alice', 'clerk_1');
    await orch.provision('bob', 'clerk_2');
    await orch.stop('bob');

    expect(orch.listAll()).toHaveLength(2);
    expect(orch.listAll('running')).toHaveLength(1);
    expect(orch.listAll('stopped')).toHaveLength(1);
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
    const before = orch.getInfo('alice')!;
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
    expect(orch.getInfo('alice')!.status).toBe('running');

    docker.getContainer.mockReturnValue({
      ...mockContainer,
      inspect: vi.fn().mockResolvedValue({ State: { Running: false } }),
    });

    await orch.syncStates();
    expect(orch.getInfo('alice')!.status).toBe('stopped');
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
    expect(orch.getInfo('alice')!.status).toBe('stopped');
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
