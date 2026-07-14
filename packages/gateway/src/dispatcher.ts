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
  type KernelResult,
  type MatrixDB,
} from "@matrix-os/kernel";
import { wrapExternalContent, detectSuspiciousPatterns } from "@matrix-os/kernel/security/external-content";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelId } from "./channels/types.js";
import type { AiGenerationInput } from "./ai-analytics.js";
import { createInteractionLogger } from "./logger.js";
import { createUsageTracker } from "@matrix-os/kernel";
import {
  kernelDispatchTotal,
  kernelDispatchDuration,
  aiCostTotal,
  aiTokensTotal,
} from "./metrics.js";
import { buildKernelEnv } from "./kernel-credentials.js";

export type SpawnFn = typeof spawnKernel;

export interface DispatchOptions {
  homePath: string;
  model?: string;
  maxTurns?: number;
  spawnFn?: SpawnFn;
  maxConcurrency?: number;
  /** Called once per completed kernel query with usage metadata only
      (trace/session id, model, latency, token counts, error category input).
      Never receives message content. Failures are swallowed. */
  onAiGeneration?: (input: AiGenerationInput) => void;
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
    /** Optional abort controller. Caller (gateway) passes this so it can
        stop the in-flight kernel run on user request. */
    abortController?: AbortController,
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
      abortController?: AbortController;
      resolve: () => void;
      reject: (error: Error) => void;
    }
  | {
      kind: "batch";
      entries: BatchEntry[];
      resolve: (results: BatchResult[]) => void;
      reject: (error: Error) => void;
    };

const DEFAULT_MAX_CONCURRENCY = 8;
const MAX_QUEUE_SIZE = 64;

export function createDispatcher(opts: DispatchOptions): Dispatcher {
  const { homePath, spawnFn = spawnKernel, maxConcurrency = DEFAULT_MAX_CONCURRENCY } = opts;

  ensureHome(homePath);
  const db = createDB(`${homePath}/system/matrix.db`);
  const interactionLogger = createInteractionLogger(homePath);
  const usageTracker = createUsageTracker(homePath);

  const queue: InternalEntry[] = [];
  let active = 0;
  let batchRunning = false;

  function logNonFatal(label: string, err: unknown) {
    console.warn(label, err instanceof Error ? err.message : String(err));
  }

  function recordAiGeneration(input: AiGenerationInput) {
    if (!opts.onAiGeneration) return;
    try {
      opts.onAiGeneration(input);
    } catch (err: unknown) {
      logNonFatal("[dispatcher] ai generation capture failed:", err);
    }
  }

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

    const startTime = Date.now();
    const source = entry.context?.channel ?? "web";
    const toolsUsed: string[] = [];
    let resultSessionId = "";
    let resultData: KernelResult | undefined;

    try {
      let message = entry.message;
      if (entry.context?.channel) {
        const detection = detectSuspiciousPatterns(entry.message);
        if (detection.suspicious) {
          const ts = new Date().toISOString();
          const sender = entry.context.senderName ?? entry.context.senderId ?? "unknown";
          const line = `[${ts}] [security] Suspicious content from ${sender} via ${entry.context.channel}: ${detection.patterns.join(", ")}\n`;
          try {
            await appendFile(join(homePath, "system/activity.log"), line);
          } catch (err) {
            logNonFatal("[dispatcher] failed to write suspicious content audit log:", err);
          }
        }
        message = wrapExternalContent(entry.message, {
          source: "channel",
          from: entry.context.senderName ?? entry.context.senderId,
        });
      }

      const config: KernelConfig = {
        db,
        homePath,
        sessionId: entry.sessionId,
        model: opts.model,
        maxTurns: opts.maxTurns,
        env: await buildKernelEnv(homePath),
      };

      for await (const event of spawnFn(message, config, entry.abortController)) {
        entry.onEvent(event);
        if (event.type === "init") {
          resultSessionId = event.sessionId;
        } else if (event.type === "tool_start") {
          toolsUsed.push(event.tool);
        } else if (event.type === "result") {
          resultData = event.data;
        }
      }

      completeTask(db, processId, { message: entry.message });

      const durationMs = Date.now() - startTime;
      const durationSec = durationMs / 1000;
      kernelDispatchTotal.inc({ source, status: "ok" });
      kernelDispatchDuration.observe({ source }, durationSec);
      if (resultData) {
        if (resultData.cost > 0) {
          aiCostTotal.inc({ model: opts.model ?? "unknown" }, resultData.cost);
        }
      }

      const tokensIn = resultData?.tokensIn ?? 0;
      const tokensOut = resultData?.tokensOut ?? 0;
      const model = opts.model ?? "unknown";
      if (tokensIn > 0) aiTokensTotal.inc({ model, direction: "in" }, tokensIn);
      if (tokensOut > 0) aiTokensTotal.inc({ model, direction: "out" }, tokensOut);

      recordAiGeneration({
        traceId: resultSessionId || entry.sessionId,
        model: opts.model,
        latencyMs: durationMs,
        tokensIn: resultData?.tokensIn,
        tokensOut: resultData?.tokensOut,
      });

      try {
        interactionLogger.log({
          source,
          sessionId: resultSessionId || entry.sessionId || "",
          prompt: entry.message,
          toolsUsed,
          tokensIn,
          tokensOut,
          costUsd: resultData?.cost ?? 0,
          durationMs,
          result: "ok",
          senderId: entry.context?.senderId,
          model: opts.model,
        });
      } catch (err) {
        logNonFatal("[dispatcher] interaction logger failed:", err);
      }

      const costUsd = resultData?.cost ?? 0;
      if (costUsd > 0) {
        try {
          usageTracker.track("dispatch", costUsd, {
            senderId: entry.context?.senderId,
            model: opts.model,
            tokensIn,
            tokensOut,
          });
        } catch (err) {
          logNonFatal("[dispatcher] usage tracker failed:", err);
        }
      }

      entry.resolve();
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const durationSec = durationMs / 1000;
      kernelDispatchTotal.inc({ source, status: "error" });
      kernelDispatchDuration.observe({ source }, durationSec);

      recordAiGeneration({
        traceId: resultSessionId || entry.sessionId,
        model: opts.model,
        latencyMs: durationMs,
        tokensIn: resultData?.tokensIn,
        tokensOut: resultData?.tokensOut,
        error,
      });

      const err = error as Error;
      try {
        interactionLogger.log({
          source,
          sessionId: resultSessionId || entry.sessionId || "",
          prompt: entry.message,
          toolsUsed,
          tokensIn: resultData?.tokensIn ?? 0,
          tokensOut: resultData?.tokensOut ?? 0,
          costUsd: resultData?.cost ?? 0,
          durationMs,
          result: "error",
          senderId: entry.context?.senderId,
          model: opts.model,
          error: {
            name: err.name,
            message: err.message,
            stack: err.stack,
          },
        });
      } catch (err) {
        logNonFatal("[dispatcher] interaction logger failed:", err);
      }

      failTask(db, processId, (error as Error).message);
      entry.reject(error as Error);
    } finally {
      active--;
      processQueue();
    }
  }

  async function runBatch(entry: Extract<InternalEntry, { kind: "batch" }>) {
    const batchId = crypto.randomUUID();
    try {
      const settled = await Promise.allSettled(
        entry.entries.map(async (batchEntry) => {
          const startTime = Date.now();
          let batchResultData: KernelResult | undefined;
          let batchSessionId = "";

          const config: KernelConfig = {
            db,
            homePath,
            model: opts.model,
            maxTurns: opts.maxTurns,
            env: await buildKernelEnv(homePath),
          };

          try {
            for await (const event of spawnFn(batchEntry.message, config)) {
              batchEntry.onEvent(event);
              if (event.type === "init") batchSessionId = event.sessionId;
              if (event.type === "result") batchResultData = event.data;
            }
          } catch (err: unknown) {
            // Record the failed generation here, where the session id and
            // timing are still in scope; the allSettled rejection branch
            // only sees the bare reason.
            recordAiGeneration({
              traceId: batchSessionId || undefined,
              model: opts.model,
              latencyMs: Date.now() - startTime,
              error: err,
            });
            throw err;
          }

          const durationMs = Date.now() - startTime;

          recordAiGeneration({
            traceId: batchSessionId || undefined,
            model: opts.model,
            latencyMs: durationMs,
            tokensIn: batchResultData?.tokensIn,
            tokensOut: batchResultData?.tokensOut,
          });

          try {
            interactionLogger.log({
              source: "batch",
              sessionId: batchSessionId,
              prompt: batchEntry.message,
              toolsUsed: [],
              tokensIn: batchResultData?.tokensIn ?? 0,
              tokensOut: batchResultData?.tokensOut ?? 0,
              costUsd: batchResultData?.cost ?? 0,
              durationMs,
              result: "ok",
              batch: true,
              batchId,
              model: opts.model,
            });
          } catch (err) {
            logNonFatal("[dispatcher] interaction logger failed:", err);
          }

          const batchCost = batchResultData?.cost ?? 0;
          if (batchCost > 0) {
            try {
              usageTracker.track("dispatch", batchCost, {
                model: opts.model,
                tokensIn: batchResultData?.tokensIn ?? 0,
                tokensOut: batchResultData?.tokensOut ?? 0,
              });
            } catch (err) {
              logNonFatal("[dispatcher] usage tracker failed:", err);
            }
          }
        }),
      );

      const results: BatchResult[] = settled.map((result, i) => {
        const taskId = entry.entries[i].taskId;
        if (result.status === "fulfilled") {
          return { taskId, status: "fulfilled" as const };
        }
        const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
        // The failed generation was already recorded inside the entry
        // closure, where the session id and timing are in scope.
        try {
          interactionLogger.log({
            source: "batch",
            sessionId: "",
            prompt: entry.entries[i].message,
            toolsUsed: [],
            tokensIn: 0,
            tokensOut: 0,
            costUsd: 0,
            durationMs: 0,
            result: "error",
            batch: true,
            batchId,
            model: opts.model,
            error: { name: err.name, message: err.message, stack: err.stack },
          });
        } catch (err) {
          logNonFatal("[dispatcher] interaction logger failed:", err);
        }
        return {
          taskId,
          status: "rejected" as const,
          error: err.message,
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

    dispatch(message, sessionId, onEvent, context, abortController) {
      if (queue.length >= MAX_QUEUE_SIZE) {
        return Promise.reject(new Error("Dispatch queue full — try again later"));
      }
      return new Promise<void>((resolve, reject) => {
        queue.push({
          kind: "serial",
          message,
          sessionId,
          onEvent,
          context,
          abortController,
          resolve,
          reject,
        });
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
