import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { OfficeDocumentError } from "./document-error.js";
import type { EngineInput, EngineOperation, EngineOutput } from "./engine-operations.js";
import type { EngineWorkerReply, EngineWorkerRequest } from "./engine-protocol.js";

/**
 * Runs the document engine off the gateway's main thread. Opening a file,
 * editing it and recalculating a workbook are synchronous and can take
 * seconds; on the main thread they would stall every HTTP request, socket
 * and terminal. Each operation runs on an engine thread with a time budget.
 * A thread that overruns is ended, which is the only way to interrupt
 * synchronous work, and the operation fails with `too_large`.
 */
export interface OfficeEngine {
  run<K extends EngineOperation>(operation: K, input: EngineInput<K>): Promise<EngineOutput<K>>;
  /** Ends every thread and fails what is running or waiting. */
  close(): Promise<void>;
}

export interface OfficeEngineOptions {
  /** Engine threads that may exist at once. */
  maxWorkers?: number;
  /** Operations that may wait for a free thread; more fail with `busy`. */
  maxQueued?: number;
  /** Longest one operation may compute before its thread is ended. */
  runBudgetMs?: number;
  /** Longest an operation may wait for a free thread. */
  queueBudgetMs?: number;
  /** Longest a new thread may take to load the engine. */
  startBudgetMs?: number;
  /** An idle thread is ended after this long. */
  idleMs?: number;
  /** Heap of one engine thread; an operation that needs more fails with `too_large`. */
  maxHeapMb?: number;
}

export const OFFICE_ENGINE_MAX_WORKERS = 2;
export const OFFICE_ENGINE_MAX_QUEUED = 16;
/** Run plus queue stay under the 35 s deadline of the agent document tools. */
export const OFFICE_ENGINE_RUN_BUDGET_MS = 10_000;
export const OFFICE_ENGINE_QUEUE_BUDGET_MS = 15_000;
export const OFFICE_ENGINE_START_BUDGET_MS = 15_000;
export const OFFICE_ENGINE_IDLE_MS = 60_000;
export const OFFICE_ENGINE_MAX_HEAP_MB = 1024;

interface Job {
  request: EngineWorkerRequest;
  resolve(output: unknown): void;
  reject(error: OfficeDocumentError): void;
  /** Queue wait while waiting, then start or run budget. */
  timer: NodeJS.Timeout | null;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  job: Job | null;
  idleTimer: NodeJS.Timeout | null;
}

const require = createRequire(import.meta.url);

/**
 * The entry of an engine thread. The engine is TypeScript source and Node
 * does not hand the gateway's loader to worker threads, so the thread
 * registers the loader itself before it imports the worker module.
 */
function workerEntry(): URL {
  const loader = pathToFileURL(require.resolve("tsx/esm/api")).href;
  const worker = new URL(import.meta.url.endsWith(".ts") ? "./engine-worker.ts" : "./engine-worker.js", import.meta.url).href;
  const source = `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(worker)});`;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

export function createOfficeEngine(options: OfficeEngineOptions = {}): OfficeEngine {
  const maxWorkers = options.maxWorkers ?? OFFICE_ENGINE_MAX_WORKERS;
  const maxQueued = options.maxQueued ?? OFFICE_ENGINE_MAX_QUEUED;
  const runBudgetMs = options.runBudgetMs ?? OFFICE_ENGINE_RUN_BUDGET_MS;
  const queueBudgetMs = options.queueBudgetMs ?? OFFICE_ENGINE_QUEUE_BUDGET_MS;
  const startBudgetMs = options.startBudgetMs ?? OFFICE_ENGINE_START_BUDGET_MS;
  const idleMs = options.idleMs ?? OFFICE_ENGINE_IDLE_MS;
  const maxHeapMb = options.maxHeapMb ?? OFFICE_ENGINE_MAX_HEAP_MB;
  // Both lists are capped: `slots` by `maxWorkers`, `queue` by `maxQueued`.
  const slots: Slot[] = [];
  const queue: Job[] = [];
  let nextId = 1;
  let closed = false;

  function clearTimer(job: Job): void {
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
  }

  /** Ends a thread for good and fails the operation it held. */
  function retire(slot: Slot, error: OfficeDocumentError | null): void {
    const index = slots.indexOf(slot);
    if (index < 0) return;
    slots.splice(index, 1);
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    const job = slot.job;
    slot.job = null;
    if (job) {
      clearTimer(job);
      job.reject(error ?? new OfficeDocumentError("internal", "engine thread ended"));
    }
    slot.worker.removeAllListeners();
    // A thread stuck in synchronous work stops only this way.
    slot.worker.terminate().catch((failure: unknown) => {
      console.warn("[office-engine] thread did not end cleanly", failure instanceof Error ? failure.name : "UnknownError");
    });
  }

  /** Posts the job and starts its run budget. The thread has loaded the engine. */
  function start(slot: Slot, job: Job): void {
    clearTimer(job);
    job.timer = setTimeout(() => {
      console.warn("[office-engine] operation exceeded its time budget", { operation: job.request.operation, runBudgetMs });
      retire(slot, new OfficeDocumentError("too_large", "engine run budget exceeded"));
      pump();
    }, runBudgetMs);
    try {
      slot.worker.postMessage(job.request);
    } catch (error: unknown) {
      retire(slot, new OfficeDocumentError("internal", "engine input could not be sent", { cause: error }));
      pump();
    }
  }

  function assign(slot: Slot, job: Job): void {
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
    slot.job = job;
    if (slot.ready) { start(slot, job); return; }
    clearTimer(job);
    job.timer = setTimeout(() => {
      retire(slot, new OfficeDocumentError("unavailable", "engine thread did not start"));
      pump();
    }, startBudgetMs);
  }

  function release(slot: Slot): void {
    slot.job = null;
    const next = queue.shift();
    if (next) { assign(slot, next); return; }
    slot.idleTimer = setTimeout(() => retire(slot, null), idleMs);
    slot.idleTimer.unref();
  }

  function onReply(slot: Slot, reply: EngineWorkerReply): void {
    if ("ready" in reply) {
      slot.ready = true;
      if (slot.job) start(slot, slot.job);
      return;
    }
    const job = slot.job;
    if (!job || job.request.id !== reply.id) return;
    clearTimer(job);
    if (reply.ok) job.resolve(reply.output);
    else {
      job.reject(new OfficeDocumentError(reply.code, reply.message || reply.code, {
        origin: { name: reply.name, engineCode: reply.engineCode },
      }));
    }
    release(slot);
  }

  function spawn(): Slot {
    const worker = new Worker(workerEntry(), {
      name: "office-engine",
      resourceLimits: { maxOldGenerationSizeMb: maxHeapMb },
    });
    // An engine thread never keeps the gateway process alive.
    worker.unref();
    const slot: Slot = { worker, ready: false, job: null, idleTimer: null };
    worker.on("message", (reply: EngineWorkerReply) => onReply(slot, reply));
    worker.on("error", (error: unknown) => {
      const outOfMemory = (error as { code?: unknown } | null)?.code === "ERR_WORKER_OUT_OF_MEMORY";
      console.error("[office-engine] thread failed", error instanceof Error ? error.name : "UnknownError", outOfMemory ? "out of memory" : "");
      retire(slot, new OfficeDocumentError(outOfMemory ? "too_large" : "internal", "engine thread failed", { cause: error }));
      pump();
    });
    worker.on("exit", () => {
      retire(slot, new OfficeDocumentError("internal", "engine thread exited"));
      pump();
    });
    slots.push(slot);
    return slot;
  }

  /** Gives waiting operations to free threads, starting threads up to the cap. */
  function pump(): void {
    while (!closed && queue.length > 0) {
      const free = slots.find((slot) => slot.job === null) ?? (slots.length < maxWorkers ? spawn() : null);
      if (!free) return;
      const job = queue.shift();
      if (job) assign(free, job);
    }
  }

  return {
    run<K extends EngineOperation>(operation: K, input: EngineInput<K>): Promise<EngineOutput<K>> {
      return new Promise<EngineOutput<K>>((resolve, reject) => {
        if (closed) { reject(new OfficeDocumentError("unavailable", "engine closed")); return; }
        if (queue.length >= maxQueued) { reject(new OfficeDocumentError("busy", "engine queue full")); return; }
        const job: Job = {
          request: { id: nextId, operation, input },
          resolve: (output) => resolve(output as EngineOutput<K>),
          reject,
          timer: null,
        };
        nextId = nextId >= Number.MAX_SAFE_INTEGER ? 1 : nextId + 1;
        job.timer = setTimeout(() => {
          const index = queue.indexOf(job);
          if (index < 0) return;
          queue.splice(index, 1);
          job.timer = null;
          reject(new OfficeDocumentError("busy", "engine queue wait exceeded"));
        }, queueBudgetMs);
        queue.push(job);
        try { pump(); }
        catch (error: unknown) {
          // A thread could not be created at all.
          const index = queue.indexOf(job);
          if (index >= 0) queue.splice(index, 1);
          clearTimer(job);
          console.error("[office-engine] thread could not start", error instanceof Error ? error.name : "UnknownError");
          reject(new OfficeDocumentError("unavailable", "engine thread could not start", { cause: error }));
        }
      });
    },
    async close(): Promise<void> {
      closed = true;
      for (const job of queue.splice(0)) {
        clearTimer(job);
        job.reject(new OfficeDocumentError("unavailable", "engine closed"));
      }
      const ending = slots.map((slot) => slot.worker);
      for (const slot of [...slots]) retire(slot, new OfficeDocumentError("unavailable", "engine closed"));
      await Promise.allSettled(ending.map((worker) => worker.terminate()));
    },
  };
}

let shared: OfficeEngine | null = null;

/**
 * The gateway's one engine pool. Operations are stateless, so every document
 * service in the process shares it and the thread cap holds process-wide.
 */
export function sharedOfficeEngine(): OfficeEngine {
  shared ??= createOfficeEngine();
  return shared;
}

/** For gateway shutdown; the next use starts a fresh pool. */
export async function closeSharedOfficeEngine(): Promise<void> {
  const engine = shared;
  shared = null;
  if (engine) await engine.close();
}
