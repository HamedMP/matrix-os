import {
  spawnKernel,
  createDB,
  ensureHome,
  type KernelConfig,
  type KernelEvent,
  type MatrixDB,
} from "@matrix-os/kernel";

export type SpawnFn = typeof spawnKernel;

export interface DispatchOptions {
  homePath: string;
  model?: string;
  maxTurns?: number;
  spawnFn?: SpawnFn;
}

export interface Dispatcher {
  dispatch(
    message: string,
    sessionId: string | undefined,
    onEvent: (event: KernelEvent) => void,
  ): Promise<void>;
  readonly queueLength: number;
  db: MatrixDB;
  homePath: string;
}

interface QueueEntry {
  message: string;
  sessionId: string | undefined;
  onEvent: (event: KernelEvent) => void;
  resolve: () => void;
  reject: (error: Error) => void;
}

export function createDispatcher(opts: DispatchOptions): Dispatcher {
  const { homePath, spawnFn = spawnKernel } = opts;

  ensureHome(homePath);
  const db = createDB(`${homePath}/system/matrix.db`);

  const queue: QueueEntry[] = [];
  let running = false;

  async function processQueue() {
    if (running || queue.length === 0) return;
    running = true;
    const entry = queue.shift()!;

    try {
      const config: KernelConfig = {
        db,
        homePath,
        sessionId: entry.sessionId,
        model: opts.model,
        maxTurns: opts.maxTurns,
      };

      for await (const event of spawnFn(entry.message, config)) {
        entry.onEvent(event);
      }
      entry.resolve();
    } catch (error) {
      entry.reject(error as Error);
    } finally {
      running = false;
      processQueue();
    }
  }

  return {
    db,
    homePath,

    get queueLength() {
      return queue.length;
    },

    dispatch(message, sessionId, onEvent) {
      return new Promise<void>((resolve, reject) => {
        queue.push({ message, sessionId, onEvent, resolve, reject });
        processQueue();
      });
    },
  };
}
