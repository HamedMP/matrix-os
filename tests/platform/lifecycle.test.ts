import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createPlatformDb, type PlatformDB, insertContainer, getContainer, updateContainerStatus } from '../../packages/platform/src/db.js';
import { createLifecycleManager } from '../../packages/platform/src/lifecycle.js';
import type { Orchestrator } from '../../packages/platform/src/orchestrator.js';

function createMockOrchestrator(): Orchestrator {
  return {
    provision: vi.fn(),
    start: vi.fn().mockImplementation(async (handle: string) => {
      // The real orchestrator updates DB status; we simulate it
    }),
    stop: vi.fn().mockImplementation(async (handle: string) => {
      // Simulated
    }),
    destroy: vi.fn(),
    upgrade: vi.fn(),
    getInfo: vi.fn(),
    listAll: vi.fn(),
    syncStates: vi.fn(),
  };
}

describe('platform/lifecycle', () => {
  let tmpDir: string;
  let db: PlatformDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'platform-lc-'));
    db = createPlatformDb(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stops idle containers past timeout', async () => {
    const orchestrator = createMockOrchestrator();
    const lm = createLifecycleManager({
      db,
      orchestrator,
      idleTimeoutMs: 1000,
    });

    insertContainer(db, {
      handle: 'alice',
      clerkUserId: 'c1',
      containerId: 'ctr1',
      port: 4001,
      shellPort: 3001,
      status: 'running',
    });

    // Set last_active to 2 seconds ago (past the 1s timeout)
    const oldTime = new Date(Date.now() - 2000).toISOString();
    const drizzle = db;
    const { containers } = await import('../../packages/platform/src/schema.js');
    const { eq } = await import('drizzle-orm');
    drizzle.update(containers).set({ lastActive: oldTime }).where(eq(containers.handle, 'alice')).run();

    const stopped = await lm.checkIdle();
    expect(stopped).toEqual(['alice']);
    expect(orchestrator.stop).toHaveBeenCalledWith('alice');
  });

  it('does not stop recently active containers', async () => {
    const orchestrator = createMockOrchestrator();
    const lm = createLifecycleManager({
      db,
      orchestrator,
      idleTimeoutMs: 60000,
    });

    insertContainer(db, {
      handle: 'alice',
      clerkUserId: 'c1',
      containerId: 'ctr1',
      port: 4001,
      shellPort: 3001,
      status: 'running',
    });

    const stopped = await lm.checkIdle();
    expect(stopped).toEqual([]);
    expect(orchestrator.stop).not.toHaveBeenCalled();
  });

  it('touchActivity updates last_active', () => {
    const orchestrator = createMockOrchestrator();
    const lm = createLifecycleManager({ db, orchestrator });

    insertContainer(db, {
      handle: 'alice',
      clerkUserId: 'c1',
      containerId: 'ctr1',
      port: 4001,
      shellPort: 3001,
      status: 'running',
    });

    const before = getContainer(db, 'alice')!.lastActive;
    lm.touchActivity('alice');
    const after = getContainer(db, 'alice')!.lastActive;
    expect(after >= before).toBe(true);
  });

  it('ensureRunning calls start on stopped container', async () => {
    const orchestrator = createMockOrchestrator();
    const lm = createLifecycleManager({ db, orchestrator });

    insertContainer(db, {
      handle: 'alice',
      clerkUserId: 'c1',
      containerId: 'ctr1',
      port: 4001,
      shellPort: 3001,
      status: 'stopped',
    });

    await lm.ensureRunning('alice');
    expect(orchestrator.start).toHaveBeenCalledWith('alice');
  });

  it('ensureRunning is no-op for running container', async () => {
    const orchestrator = createMockOrchestrator();
    const lm = createLifecycleManager({ db, orchestrator });

    insertContainer(db, {
      handle: 'alice',
      clerkUserId: 'c1',
      containerId: 'ctr1',
      port: 4001,
      shellPort: 3001,
      status: 'running',
    });

    await lm.ensureRunning('alice');
    expect(orchestrator.start).not.toHaveBeenCalled();
  });

  it('ensureRunning throws for unknown handle', async () => {
    const orchestrator = createMockOrchestrator();
    const lm = createLifecycleManager({ db, orchestrator });

    await expect(lm.ensureRunning('ghost')).rejects.toThrow('No container');
  });

  it('start and stop manage interval', () => {
    vi.useFakeTimers();
    const orchestrator = createMockOrchestrator();
    const lm = createLifecycleManager({
      db,
      orchestrator,
      checkIntervalMs: 1000,
    });

    lm.start();
    lm.start(); // double-start is no-op

    vi.advanceTimersByTime(1000);

    lm.stop();
    lm.stop(); // double-stop is no-op

    vi.useRealTimers();
  });
});
