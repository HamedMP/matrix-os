import {
  type PlatformDB,
  listContainers,
  getContainer,
  updateLastActive,
} from './db.js';
import type { Orchestrator } from './orchestrator.js';

export interface LifecycleConfig {
  db: PlatformDB;
  orchestrator: Orchestrator;
  checkIntervalMs?: number;
  maxRunning?: number;
  safetyFloorMs?: number;
}

export interface LifecycleManager {
  start(): void;
  stop(): void;
  touchActivity(handle: string): void;
  ensureRunning(handle: string): Promise<void>;
  checkIdle(): Promise<string[]>;
}

export function createLifecycleManager(config: LifecycleConfig): LifecycleManager {
  const {
    db,
    orchestrator,
    checkIntervalMs = 5 * 60 * 1000,
    maxRunning = 20,
    safetyFloorMs = 5 * 60 * 1000,
  } = config;

  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  async function checkIdle(): Promise<string[]> {
    const running = listContainers(db, 'running');
    if (running.length < maxRunning) return [];

    const now = Date.now();
    const overage = running.length - maxRunning + 1;

    const candidates = running
      .filter((c) => now - new Date(c.lastActive).getTime() > safetyFloorMs)
      .sort((a, b) => new Date(a.lastActive).getTime() - new Date(b.lastActive).getTime());

    const toEvict = candidates.slice(0, overage);
    const stopped: string[] = [];

    for (const container of toEvict) {
      try {
        await orchestrator.stop(container.handle);
        stopped.push(container.handle);
      } catch {
        // Container may already be stopped
      }
    }

    return stopped;
  }

  return {
    start() {
      if (intervalHandle) return;
      intervalHandle = setInterval(() => {
        checkIdle().catch(() => {});
      }, checkIntervalMs);
    },

    stop() {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
    },

    touchActivity(handle: string) {
      updateLastActive(db, handle);
    },

    async ensureRunning(handle: string) {
      const record = getContainer(db, handle);
      if (!record) throw new Error(`No container for handle: ${handle}`);
      if (record.status === 'running') return;
      await orchestrator.start(handle);
    },

    checkIdle,
  };
}
