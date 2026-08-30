import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod/v4";

const JsonRpcIdSchema = z.union([z.string().max(128), z.number().int().safe()]);
const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema,
  result: z.unknown().optional(),
  error: z.object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  }).strict().optional(),
}).strict().refine((value) => (value.result !== undefined) !== (value.error !== undefined));
const HermesGatewayEventSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("event"),
  params: z.object({
    type: z.string().min(1).max(128),
    session_id: z.union([z.literal(""), z.string().min(1).max(512)]).optional(),
    payload: z.unknown().optional(),
  }).passthrough(),
}).strict();

export type HermesGatewayEvent = z.infer<typeof HermesGatewayEventSchema>["params"];

interface HermesGatewayWritable {
  write(chunk: string): boolean;
  end(): void;
}

interface HermesGatewayReadable {
  on(event: "data", listener: (chunk: Buffer) => void): void;
}

export interface HermesGatewayProcess {
  stdin: HermesGatewayWritable;
  stdout: HermesGatewayReadable;
  stderr: HermesGatewayReadable;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  kill(signal: NodeJS.Signals): void;
}

export type HermesGatewaySpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdio: ["pipe", "pipe", "pipe"] },
) => HermesGatewayProcess;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface HermesStdioClient {
  ready(): Promise<void>;
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

const defaultSpawn: HermesGatewaySpawn = (command, args, options) => spawn(command, args, options);
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_PENDING_REQUESTS = 16;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 1_000;
const FORCE_SETTLE_MS = 250;

function safeError(message: string, cause?: unknown): Error {
  return new Error(message, cause === undefined ? undefined : { cause });
}

export function createHermesStdioClient(options: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  spawnFn?: HermesGatewaySpawn;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  onEvent(event: HermesGatewayEvent): void;
  onFailure(error: Error): void;
}): HermesStdioClient {
  const pending = new Map<string | number, PendingRequest>();
  const decoder = new StringDecoder("utf8");
  let inputBuffer = "";
  let requestId = 0;
  let failed: Error | undefined;
  let closing = false;
  let exited = false;
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveExit!: () => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const child = (options.spawnFn ?? defaultSpawn)(options.command, options.args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env } as Record<string, string>,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const readyTimer = setTimeout(() => {
    fail(safeError("Hermes gateway did not become ready"));
  }, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  readyTimer.unref?.();

  function settleReady(error?: Error): void {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimer);
    if (error) rejectReady(error);
    else resolveReady();
  }

  function rejectPending(error: Error): void {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  function fail(error: Error): void {
    if (failed || closing) return;
    failed = error;
    settleReady(error);
    rejectPending(error);
    options.onFailure(error);
    child.kill("SIGTERM");
  }

  function handleFrame(line: string): void {
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
      fail(safeError("Hermes gateway frame exceeded limit"));
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error: unknown) {
      fail(safeError("Hermes gateway returned invalid data", error));
      return;
    }
    const event = HermesGatewayEventSchema.safeParse(value);
    if (event.success) {
      if (event.data.params.type === "gateway.ready") settleReady();
      try {
        options.onEvent(event.data.params);
      } catch (error: unknown) {
        fail(safeError("Hermes gateway event was invalid", error));
      }
      return;
    }
    const response = JsonRpcResponseSchema.safeParse(value);
    if (!response.success) {
      fail(safeError("Hermes gateway returned an unsupported frame"));
      return;
    }
    const request = pending.get(response.data.id);
    if (!request) return;
    pending.delete(response.data.id);
    clearTimeout(request.timer);
    if (response.data.error) request.reject(safeError("Hermes gateway request failed"));
    else request.resolve(response.data.result);
  }

  child.stdout.on("data", (chunk) => {
    if (failed || closing) return;
    inputBuffer += decoder.write(chunk);
    if (Buffer.byteLength(inputBuffer, "utf8") > MAX_FRAME_BYTES && !inputBuffer.includes("\n")) {
      fail(safeError("Hermes gateway frame exceeded limit"));
      return;
    }
    while (!failed) {
      const newline = inputBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = inputBuffer.slice(0, newline).trim();
      inputBuffer = inputBuffer.slice(newline + 1);
      if (line) handleFrame(line);
    }
    if (!failed && Buffer.byteLength(inputBuffer, "utf8") > MAX_FRAME_BYTES) {
      fail(safeError("Hermes gateway frame exceeded limit"));
    }
  });
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    stderrBytes = Math.min(8_192, stderrBytes + chunk.byteLength);
  });
  child.once("error", (error) => fail(safeError("Hermes gateway could not start", error)));
  child.once("exit", (code, signal) => {
    exited = true;
    resolveExit();
    if (closing) return;
    fail(safeError(code === 0 && signal === null
      ? "Hermes gateway exited before the Run completed"
      : "Hermes gateway exited unsuccessfully"));
  });

  return {
    ready: () => readyPromise,
    request(method, params, timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) {
      if (failed) return Promise.reject(failed);
      if (closing) return Promise.reject(safeError("Hermes gateway is closing"));
      if (pending.size >= MAX_PENDING_REQUESTS) {
        return Promise.reject(safeError("Hermes gateway request limit exceeded"));
      }
      const id = ++requestId;
      const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
      if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
        return Promise.reject(safeError("Hermes gateway request exceeded limit"));
      }
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(safeError("Hermes gateway request timed out"));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        try {
          child.stdin.write(frame);
        } catch (error: unknown) {
          clearTimeout(timer);
          pending.delete(id);
          reject(safeError("Hermes gateway request could not be sent", error));
        }
      });
    },
    async close() {
      if (closing) return exitPromise;
      closing = true;
      clearTimeout(readyTimer);
      settleReady(safeError("Hermes gateway closed"));
      rejectPending(safeError("Hermes gateway closed"));
      if (exited) return;
      child.stdin.end();
      let forceKillTimer: NodeJS.Timeout | undefined;
      let forceSettleTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => {
          forceKillTimer = setTimeout(() => {
            if (exited) return resolve();
            child.kill("SIGTERM");
            forceSettleTimer = setTimeout(() => {
              if (!exited) child.kill("SIGKILL");
              resolve();
            }, FORCE_SETTLE_MS);
            forceSettleTimer.unref?.();
          }, TERMINATION_GRACE_MS);
          forceKillTimer.unref?.();
        }),
      ]);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
    },
  };
}
