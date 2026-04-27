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
  idleTimeoutMs?: number;
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
    idleTimeoutMs,
    safetyFloorMs = 5 * 60 * 1000,
  } = config;

  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  async function checkIdle(): Promise<string[]> {
    const running = await listContainers(db, 'running');
    const now = Date.now();
    const stopped: string[] = [];
    const alreadyStopped = new Set<string>();

    // Phase 1: stop containers idle past idleTimeoutMs
    if (idleTimeoutMs !== undefined) {
      for (const c of running) {
        if (now - new Date(c.lastActive).getTime() > idleTimeoutMs) {
          try {
            await orchestrator.stop(c.handle);
            stopped.push(c.handle);
            alreadyStopped.add(c.handle);
          } catch (err: unknown) {
            console.warn('[lifecycle] Failed to stop idle container:', err instanceof Error ? err.message : String(err));
          }
        }
      }
    }

    // Phase 2: capacity-based eviction when over maxRunning
    const stillRunning = running.length - alreadyStopped.size;
    if (stillRunning >= maxRunning) {
      const overage = stillRunning - maxRunning + 1;
      const candidates = running
        .filter((c) => !alreadyStopped.has(c.handle))
        .filter((c) => now - new Date(c.lastActive).getTime() > safetyFloorMs)
        .sort((a, b) => new Date(a.lastActive).getTime() - new Date(b.lastActive).getTime());

      for (const container of candidates.slice(0, overage)) {
        try {
          await orchestrator.stop(container.handle);
          stopped.push(container.handle);
        } catch (err: unknown) {
          console.warn('[lifecycle] Failed to evict idle container:', err instanceof Error ? err.message : String(err));
        }
      }
    }

    return stopped;
  }

  return {
    start() {
      if (intervalHandle) return;
      intervalHandle = setInterval(() => {
        checkIdle().catch((err: unknown) => {
          console.warn('[lifecycle] Idle check failed:', err instanceof Error ? err.message : String(err));
        });
      }, checkIntervalMs);
    },

    stop() {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
    },

    touchActivity(handle: string) {
      void updateLastActive(db, handle).catch((err: unknown) => {
        console.warn('[lifecycle] Failed to update activity:', err instanceof Error ? err.message : String(err));
      });
    },

    async ensureRunning(handle: string) {
      const record = await getContainer(db, handle);
      if (!record) throw new Error(`No container for handle: ${handle}`);
      if (record.status === 'running') return;
      await orchestrator.start(handle);
    },

    checkIdle,
  };
}
