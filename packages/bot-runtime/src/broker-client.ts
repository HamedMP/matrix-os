import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { z } from "zod/v4";
import {
  BOT_BROKER_MAX_FRAME_BYTES,
  BotBrokerRequestSchema,
  BotBrokerResponseSchema,
  BotEventAcceptedSchema,
  BotImageChunkSchema,
  BotRunSpecSchema,
  BotSessionSaveResultSchema,
  BotSessionSnapshotSchema,
  BotToolResultSchema,
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

export class BotBrokerError extends Error {
  constructor(readonly code: BotToolErrorCode) {
    super(`Bot broker request failed: ${code}`);
    this.name = "BotBrokerError";
  }
}

export interface BotBrokerClient {
  loadSession(): Promise<BotSessionSnapshot>;
  saveSession(session: BotSessionSaveRequest): Promise<{ revision: number }>;
  tool(request: BotToolRequest): Promise<BotToolResult>;
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
}

/** One request per connection, newline-delimited JSON, mirroring the existing worker bridge. */
function exchange(options: BotBrokerClientOptions, frame: unknown): Promise<unknown> {
  const connectFn = options.connectFn ?? ((path: string) => connect({ path }));
  return new Promise((resolve, reject) => {
    const socket = connectFn(options.socketPath);
    let reply = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: BotBrokerError, value?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => finish(new BotBrokerError("timeout")));
    socket.once("connect", () => socket.write(`${JSON.stringify(frame)}\n`));
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
  });
}

export function createBotBrokerClient(options: BotBrokerClientOptions): BotWorkerBrokerClient {
  const requestIdFactory = options.requestIdFactory ?? randomUUID;

  async function call<T>(action: Record<string, unknown>, resultSchema: z.ZodType<T>): Promise<T> {
    const requestId = requestIdFactory();
    const frame = BotBrokerRequestSchema.safeParse({
      version: 1,
      requestId,
      runtimeHandle: options.runtimeHandle,
      executionGeneration: options.executionGeneration,
      runId: options.runId,
      ...action,
    });
    if (!frame.success) throw new BotBrokerError("invalid_arguments");
    const raw = await exchange(options, frame.data);
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
    tool: (tool) => call({ action: "bot.tool", tool }, BotToolResultSchema),
    event: async (event) => {
      await call({ action: "bot.event", event }, BotEventAcceptedSchema);
    },
  };
}
