import {
  spawnKernel,
  createDB,
  ensureHome,
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

    dispatch(message, sessionId, onEvent, context) {
      return new Promise<void>((resolve, reject) => {
        queue.push({ message, sessionId, onEvent, context, resolve, reject });
        processQueue();
      });
    },
  };
}
