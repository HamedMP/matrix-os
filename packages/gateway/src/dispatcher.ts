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

export interface BatchEntry {
  taskId: string;
  message: string;
  onEvent: (event: KernelEvent) => void;
}

export interface BatchResult {
  taskId: string;
  status: "fulfilled" | "rejected";
  error?: string;
}

export interface Dispatcher {
  dispatch(
    message: string,
    sessionId: string | undefined,
    onEvent: (event: KernelEvent) => void,
    context?: DispatchContext,
  ): Promise<void>;
  dispatchBatch(entries: BatchEntry[]): Promise<BatchResult[]>;
  readonly queueLength: number;
  readonly activeCount: number;
  db: MatrixDB;
  homePath: string;
}

type InternalEntry =
  | {
      kind: "serial";
      message: string;
      sessionId: string | undefined;
      onEvent: (event: KernelEvent) => void;
      context?: DispatchContext;
      resolve: () => void;
      reject: (error: Error) => void;
    }
  | {
      kind: "batch";
      entries: BatchEntry[];
      resolve: (results: BatchResult[]) => void;
      reject: (error: Error) => void;
    };

export function createDispatcher(opts: DispatchOptions): Dispatcher {
  const { homePath, spawnFn = spawnKernel, maxConcurrency = Infinity } = opts;

  ensureHome(homePath);
  const db = createDB(`${homePath}/system/matrix.db`);

  const queue: InternalEntry[] = [];
  let active = 0;
  let batchRunning = false;

  function processQueue() {
    if (batchRunning) return;
    while (active < maxConcurrency && queue.length > 0) {
      const entry = queue.shift()!;
      active++;
      if (entry.kind === "serial") {
        runSerial(entry);
      } else {
        batchRunning = true;
        runBatch(entry);
        return;
      }
    }
  }

  async function runSerial(entry: Extract<InternalEntry, { kind: "serial" }>) {
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

  async function runBatch(entry: Extract<InternalEntry, { kind: "batch" }>) {
    try {
      const settled = await Promise.allSettled(
        entry.entries.map(async (batchEntry) => {
          const config: KernelConfig = {
            db,
            homePath,
            model: opts.model,
            maxTurns: opts.maxTurns,
          };

          for await (const event of spawnFn(batchEntry.message, config)) {
            batchEntry.onEvent(event);
          }
        }),
      );

      const results: BatchResult[] = settled.map((result, i) => {
        const taskId = entry.entries[i].taskId;
        if (result.status === "fulfilled") {
          return { taskId, status: "fulfilled" as const };
        }
        return {
          taskId,
          status: "rejected" as const,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        };
      });

      entry.resolve(results);
    } catch (error) {
      entry.reject(error as Error);
    } finally {
      active--;
      batchRunning = false;
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
        queue.push({ kind: "serial", message, sessionId, onEvent, context, resolve, reject });
        processQueue();
      });
    },

    dispatchBatch(entries) {
      if (entries.length === 0) {
        return Promise.resolve([]);
      }
      return new Promise<BatchResult[]>((resolve, reject) => {
        queue.push({ kind: "batch", entries, resolve, reject });
        processQueue();
      });
    },
  };
}
