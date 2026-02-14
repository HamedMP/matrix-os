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
  idleTimeoutMs?: number;
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
    idleTimeoutMs = 30 * 60 * 1000,
  } = config;

  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  async function checkIdle(): Promise<string[]> {
    const running = listContainers(db, 'running');
    const now = Date.now();
    const stopped: string[] = [];

    for (const container of running) {
      const lastActive = new Date(container.lastActive).getTime();
      if (now - lastActive > idleTimeoutMs) {
        try {
          await orchestrator.stop(container.handle);
          stopped.push(container.handle);
        } catch {
          // Container may already be stopped
        }
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
