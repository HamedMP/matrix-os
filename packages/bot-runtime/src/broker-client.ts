import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { z } from "zod/v4";
import {
  BOT_BROKER_MAX_FRAME_BYTES,
  SHARED_BROWSER_ACTION_DEADLINE_MS,
  BotBrokerRequestSchema,
  BotBrokerResponseSchema,
  BotEventAcceptedSchema,
  BotImageChunkSchema,
  BotRunSpecSchema,
  BotSessionSaveResultSchema,
  BotSessionSnapshotSchema,
  BotToolResultSchema,
  type BotBrokerRequest,
  type BotEvent,
  type BotImageChunk,
  type BotImageChunkRequest,
  type BotRunSpec,
  type BotSessionSaveRequest,
  type BotSessionSnapshot,
  type BotToolErrorCode,
  type BotToolRequest,
  type BotToolResult,
} from "@matrix-os/contracts";

/** A session load reply carries a whole transcript. */
const MAX_REPLY_BYTES = BOT_BROKER_MAX_FRAME_BYTES;
const DEFAULT_TIMEOUT_MS = 30_000;
// Gateway: up to ten minutes for exact human approval, then 90s host work.
const GITHUB_DEVELOPER_TIMEOUT_MS = 10 * 60_000 + 90_000 + 35_000;
// The Gateway still caps native execution at 120 seconds. Leave time for preflight and the checkpoint reply.
const NATIVE_TASK_REPLY_TIMEOUT_MS = 150_000;

export class BotBrokerError extends Error {
  constructor(readonly code: BotToolErrorCode) {
    super(`Bot broker request failed: ${code}`);
    this.name = "BotBrokerError";
  }
}

export interface BotBrokerClient {
  loadSession(): Promise<BotSessionSnapshot>;
  saveSession(session: BotSessionSaveRequest): Promise<{ revision: number }>;
  tool(request: BotToolRequest, signal?: AbortSignal): Promise<BotToolResult>;
  event(event: BotEvent): Promise<void>;
}

/** The worker loads its run and images before the agent loop starts; the loop never needs them. */
export interface BotWorkerBrokerClient extends BotBrokerClient {
  loadRun(): Promise<BotRunSpec>;
  readImageChunk(request: BotImageChunkRequest): Promise<BotImageChunk>;
}

export interface BotBrokerClientOptions {
  socketPath: string;
  runtimeHandle: string;
  executionGeneration: string;
  runId: string;
  timeoutMs?: number;
  connectFn?: (path: string) => Socket;
  requestIdFactory?: () => string;
  signal?: AbortSignal;
}

/** One request per connection, newline-delimited JSON, mirroring the existing worker bridge. */
function exchange(options: BotBrokerClientOptions, frame: BotBrokerRequest, signal?: AbortSignal, absoluteDeadline = false): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(new BotBrokerError("stale_generation"));
  const connectFn = options.connectFn ?? ((path: string) => connect({ path }));
  return new Promise((resolve, reject) => {
    const socket = connectFn(options.socketPath);
    let reply = Buffer.alloc(0);
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: BotBrokerError, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new BotBrokerError("stale_generation"));
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => finish(new BotBrokerError("timeout")));
    // Socket inactivity alone can be extended by partial reply traffic. The
    // GitHub approval/work budget also bounds the complete exchange lifetime.
    if (absoluteDeadline) {
      deadlineTimer = setTimeout(() => finish(new BotBrokerError("timeout")), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      deadlineTimer.unref();
    }
    // Live routine requests keep the write direction open so the host can observe cancellation.
    socket.once("connect", () => {
      const text = `${JSON.stringify(frame)}\n`;
      if (frame.action === "bot.tool" && frame.transport === "live") socket.write(text);
      else socket.end(text);
    });
    socket.on("data", (chunk: Buffer) => {
      reply = Buffer.concat([reply, chunk]);
      if (reply.length > MAX_REPLY_BYTES) {
        finish(new BotBrokerError("unavailable"));
        return;
      }
      const newline = reply.indexOf(0x0a);
      if (newline < 0) return;
      try {
        finish(undefined, JSON.parse(reply.subarray(0, newline).toString("utf8")) as unknown);
      } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) console.warn("[bot-runtime] broker reply parse failed:", error instanceof Error ? error.name : "UnknownError");
        finish(new BotBrokerError("unavailable"));
      }
    });
    socket.once("error", () => finish(new BotBrokerError("unavailable")));
    socket.once("end", () => finish(new BotBrokerError("unavailable")));
    if (signal?.aborted) onAbort();
  });
}

export function createBotBrokerClient(options: BotBrokerClientOptions): BotWorkerBrokerClient {
  const requestIdFactory = options.requestIdFactory ?? randomUUID;

  async function call<T>(action: Record<string, unknown>, resultSchema: z.ZodType<T>, callSignal?: AbortSignal): Promise<T> {
    const signal = options.signal && callSignal ? AbortSignal.any([options.signal, callSignal]) : options.signal ?? callSignal;
    const requestId = requestIdFactory();
    const frame = BotBrokerRequestSchema.safeParse({
      version: 1,
      requestId,
      runtimeHandle: options.runtimeHandle,
      executionGeneration: options.executionGeneration,
      runId: options.runId,
      ...action,
      ...(action.action === "bot.tool" && typeof action.tool === "object" && action.tool !== null
        && "capability" in action.tool && action.tool.capability === "routine.cli" ? { transport: "live" } : {}),
    });
    if (!frame.success) throw new BotBrokerError("invalid_arguments");
    const tool = frame.data.action === "bot.tool" ? frame.data.tool : undefined;
    const waitsForApproval = tool?.capability === "integration.call" || tool?.capability === "mcp.call";
    // Jev's paid classification and confirmed label readback use the gateway's bounded long-operation deadline.
    const longJevOperation = tool?.capability === "jev.inbox" && ["evaluate", "batch_next"].includes(tool.args.operation);
    const routine = tool?.capability === "routine.cli";
    const browserPause = tool?.capability === "browser.action";
    const githubDeveloper = tool?.capability === "github.developer";
    const nativeTask = tool?.capability === "agent.task";
    const raw = await exchange(options.timeoutMs === undefined && (waitsForApproval || longJevOperation || browserPause || githubDeveloper || routine || nativeTask)
      ? { ...options, timeoutMs: githubDeveloper ? GITHUB_DEVELOPER_TIMEOUT_MS
        : nativeTask ? NATIVE_TASK_REPLY_TIMEOUT_MS
        : routine ? 125_000
        : browserPause ? SHARED_BROWSER_ACTION_DEADLINE_MS + 30_000 : 10 * 60_000 + 35_000 }
      : options, frame.data, signal, githubDeveloper);
    const reply = BotBrokerResponseSchema.safeParse(raw);
    if (!reply.success || reply.data.requestId !== requestId) throw new BotBrokerError("unavailable");
    if (!reply.data.ok) throw new BotBrokerError(reply.data.code);
    const result = resultSchema.safeParse(reply.data.result);
    if (!result.success) throw new BotBrokerError("unavailable");
    return result.data;
  }

  return {
    loadRun: () => call({ action: "bot.run.load" }, BotRunSpecSchema),
    readImageChunk: (image) => call({ action: "bot.input.image", image }, BotImageChunkSchema),
    loadSession: () => call({ action: "bot.session.load" }, BotSessionSnapshotSchema),
    saveSession: (session) => call({ action: "bot.session.save", session }, BotSessionSaveResultSchema),
    tool: (tool, signal) => call({ action: "bot.tool", tool }, BotToolResultSchema, signal),
    event: async (event) => {
      await call({ action: "bot.event", event }, BotEventAcceptedSchema);
    },
  };
}
