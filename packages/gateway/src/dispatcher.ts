import {
  spawnKernel,
  createDB,
  ensureHome,
  createTask,
  claimTask,
  completeTask,
  failTask,
  type KernelConfig,
  type KernelEvent,
  type MatrixDB,
} from "@matrix-os/kernel";
import type { ChannelId } from "./channels/types.js";

export type SpawnFn = typeof spawnKernel;

export interface DispatchOptions {
  homePath: string;
  model?: string;
  maxTurns?: number;
  spawnFn?: SpawnFn;
  maxConcurrency?: number;
}

export interface DispatchContext {
  channel?: ChannelId;
  senderId?: string;
  senderName?: string;
  chatId?: string;
}

export interface Dispatcher {
  dispatch(
    message: string,
    sessionId: string | undefined,
    onEvent: (event: KernelEvent) => void,
    context?: DispatchContext,
  ): Promise<void>;
  readonly queueLength: number;
  readonly activeCount: number;
  db: MatrixDB;
  homePath: string;
}

interface QueueEntry {
  message: string;
  sessionId: string | undefined;
  onEvent: (event: KernelEvent) => void;
  context?: DispatchContext;
  resolve: () => void;
  reject: (error: Error) => void;
}

export function createDispatcher(opts: DispatchOptions): Dispatcher {
  const { homePath, spawnFn = spawnKernel, maxConcurrency = Infinity } = opts;

  ensureHome(homePath);
  const db = createDB(`${homePath}/system/matrix.db`);

  const queue: QueueEntry[] = [];
  let active = 0;

  function processQueue() {
    while (active < maxConcurrency && queue.length > 0) {
      const entry = queue.shift()!;
      active++;
      runEntry(entry);
    }
  }

  async function runEntry(entry: QueueEntry) {
    const processId = createTask(db, {
      type: "kernel",
      input: { message: entry.message },
    });
    claimTask(db, processId, "dispatcher");

    try {
      let message = entry.message;
      if (entry.context?.channel) {
        const parts = [`[Channel: ${entry.context.channel}]`];
        if (entry.context.senderName) parts.push(`[User: ${entry.context.senderName}]`);
        else if (entry.context.senderId) parts.push(`[User: ${entry.context.senderId}]`);
        message = `${parts.join(" ")} ${message}`;
      }

      const config: KernelConfig = {
        db,
        homePath,
        sessionId: entry.sessionId,
        model: opts.model,
        maxTurns: opts.maxTurns,
      };

      for await (const event of spawnFn(message, config)) {
        entry.onEvent(event);
      }

      completeTask(db, processId, { message: entry.message });
      entry.resolve();
    } catch (error) {
      failTask(db, processId, (error as Error).message);
      entry.reject(error as Error);
    } finally {
      active--;
      processQueue();
    }
  }

  return {
    db,
    homePath,

    get queueLength() {
      return queue.length;
    },

    get activeCount() {
      return active;
    },

    dispatch(message, sessionId, onEvent, context) {
      return new Promise<void>((resolve, reject) => {
        queue.push({ message, sessionId, onEvent, context, resolve, reject });
        processQueue();
      });
    },
  };
}
