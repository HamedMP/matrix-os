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
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelId } from "./channels/types.js";
import { createInteractionLogger } from "./logger.js";
import { createUsageTracker } from "@matrix-os/kernel";
import {
  kernelDispatchTotal,
  kernelDispatchDuration,
  aiCostTotal,
  aiTokensTotal,
} from "./metrics.js";

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
  const interactionLogger = createInteractionLogger(homePath);
  const usageTracker = createUsageTracker(homePath);

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
          try { appendFileSync(join(homePath, "system/activity.log"), line); } catch { /* log dir may not exist */ }
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
      };

      // BYOK: read user's API key from config.json and inject into env for kernel
      let savedApiKey: string | undefined;
      let didSetKey = false;
      try {
        const raw = await readFile(join(homePath, "system/config.json"), "utf-8");
        const userConfig = JSON.parse(raw);
        const byokKey = userConfig?.kernel?.anthropicApiKey;
        if (byokKey && typeof byokKey === "string") {
          savedApiKey = process.env.ANTHROPIC_API_KEY;
          process.env.ANTHROPIC_API_KEY = byokKey;
          didSetKey = true;
        }
      } catch {
        // No config or parse error -- use default env key
      }

      try {
        for await (const event of spawnFn(message, config)) {
          entry.onEvent(event);
          if (event.type === "init") {
            resultSessionId = event.sessionId;
          } else if (event.type === "tool_start") {
            toolsUsed.push(event.tool);
          } else if (event.type === "result") {
            resultData = event.data;
          }
        }
      } finally {
        if (didSetKey) {
          if (savedApiKey !== undefined) {
            process.env.ANTHROPIC_API_KEY = savedApiKey;
          } else {
            delete process.env.ANTHROPIC_API_KEY;
          }
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
      } catch { /* logger failure must not break dispatch */ }

      const costUsd = resultData?.cost ?? 0;
      if (costUsd > 0) {
        try {
          usageTracker.track("dispatch", costUsd, {
            senderId: entry.context?.senderId,
            model: opts.model,
            tokensIn,
            tokensOut,
          });
        } catch { /* usage tracker failure must not break dispatch */ }
      }

      entry.resolve();
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const durationSec = durationMs / 1000;
      kernelDispatchTotal.inc({ source, status: "error" });
      kernelDispatchDuration.observe({ source }, durationSec);

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
      } catch { /* logger failure must not break dispatch */ }

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
          };

          for await (const event of spawnFn(batchEntry.message, config)) {
            batchEntry.onEvent(event);
            if (event.type === "init") batchSessionId = event.sessionId;
            if (event.type === "result") batchResultData = event.data;
          }

          const durationMs = Date.now() - startTime;
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
          } catch { /* logger failure must not break dispatch */ }

          const batchCost = batchResultData?.cost ?? 0;
          if (batchCost > 0) {
            try {
              usageTracker.track("dispatch", batchCost, {
                model: opts.model,
                tokensIn: batchResultData?.tokensIn ?? 0,
                tokensOut: batchResultData?.tokensOut ?? 0,
              });
            } catch { /* usage tracker failure must not break dispatch */ }
          }
        }),
      );

      const results: BatchResult[] = settled.map((result, i) => {
        const taskId = entry.entries[i].taskId;
        if (result.status === "fulfilled") {
          return { taskId, status: "fulfilled" as const };
        }
        const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
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
        } catch { /* logger failure must not break dispatch */ }
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
