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
  readonly pid?: number;
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
  /** Actual exit or definitive no-child spawn failure, never a kill timeout. */
  whenExited(): Promise<void>;
  /** Bounded cleanup; false means the process is still owned and must be tracked. */
  close(): Promise<boolean>;
}

export class HermesGatewayReadyTimeout extends Error {
  readonly name = "HermesGatewayReadyTimeout";
  constructor() { super("Hermes gateway did not become ready"); }
}

const defaultSpawn: HermesGatewaySpawn = (command, args, options) => spawn(command, args, options);
const MAX_INBOUND_FRAME_BYTES = 512 * 1024;
const MAX_OUTBOUND_FRAME_BYTES = 256 * 1024;
const MAX_PENDING_REQUESTS = 16;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 1_000;
const FORCE_SETTLE_MS = 250;

function safeError(message: string, cause?: unknown): Error {
  return new Error(message, cause === undefined ? undefined : { cause });
}

type HermesGatewayProtocolFailureReason =
  | "event_invalid"
  | "frame_too_large"
  | "invalid_json"
  | "unsupported_frame";

export class HermesGatewayProtocolError extends Error {
  constructor(
    readonly reason: HermesGatewayProtocolFailureReason,
    message: string,
    cause?: unknown,
    readonly eventType?: string,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HermesGatewayProtocolError";
  }
}

function protocolError(
  reason: HermesGatewayProtocolFailureReason,
  message: string,
  cause?: unknown,
): HermesGatewayProtocolError {
  return new HermesGatewayProtocolError(reason, message, cause);
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
  let closePromise: Promise<boolean> | undefined;
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
    fail(new HermesGatewayReadyTimeout());
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
    if (!exited) signalChild("SIGTERM");
  }

  function signalChild(signal: NodeJS.Signals): void {
    try { child.kill(signal); }
    catch (error: unknown) {
      console.warn("[chat/hermes] Child termination signal failed:", error instanceof Error ? error.name : "UnknownError");
    }
  }

  function handleFrame(line: string): void {
    if (Buffer.byteLength(line, "utf8") > MAX_INBOUND_FRAME_BYTES) {
      fail(protocolError("frame_too_large", "Hermes gateway frame exceeded limit"));
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error: unknown) {
      fail(protocolError("invalid_json", "Hermes gateway returned invalid data", error));
      return;
    }
    const event = HermesGatewayEventSchema.safeParse(value);
    if (event.success) {
      if (event.data.params.type === "gateway.ready") settleReady();
      try {
        options.onEvent(event.data.params);
      } catch (error: unknown) {
        fail(new HermesGatewayProtocolError(
          "event_invalid",
          "Hermes gateway event was invalid",
          error,
          event.data.params.type,
        ));
      }
      return;
    }
    const response = JsonRpcResponseSchema.safeParse(value);
    if (!response.success) {
      fail(protocolError("unsupported_frame", "Hermes gateway returned an unsupported frame"));
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
    if (Buffer.byteLength(inputBuffer, "utf8") > MAX_INBOUND_FRAME_BYTES && !inputBuffer.includes("\n")) {
      fail(protocolError("frame_too_large", "Hermes gateway frame exceeded limit"));
      return;
    }
    while (!failed) {
      const newline = inputBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = inputBuffer.slice(0, newline).trim();
      inputBuffer = inputBuffer.slice(newline + 1);
      if (line) handleFrame(line);
    }
    if (!failed && Buffer.byteLength(inputBuffer, "utf8") > MAX_INBOUND_FRAME_BYTES) {
      fail(protocolError("frame_too_large", "Hermes gateway frame exceeded limit"));
    }
  });
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    stderrBytes = Math.min(8_192, stderrBytes + chunk.byteLength);
  });
  child.once("error", (error) => {
    // Node reports an undefined PID when spawn itself failed. An absent PID
    // property on an injected process is unknown, not proof of non-admission.
    if ("pid" in child && child.pid === undefined) {
      exited = true;
      resolveExit();
    }
    fail(safeError("Hermes gateway could not start", error));
  });
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
    whenExited: () => exitPromise,
    request(method, params, timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) {
      if (failed) return Promise.reject(failed);
      if (closing) return Promise.reject(safeError("Hermes gateway is closing"));
      if (pending.size >= MAX_PENDING_REQUESTS) {
        return Promise.reject(safeError("Hermes gateway request limit exceeded"));
      }
      const id = ++requestId;
      const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
      if (Buffer.byteLength(frame, "utf8") > MAX_OUTBOUND_FRAME_BYTES) {
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
    close() {
      if (closePromise) return closePromise;
      closing = true;
      clearTimeout(readyTimer);
      settleReady(safeError("Hermes gateway closed"));
      rejectPending(safeError("Hermes gateway closed"));
      closePromise = (async () => {
        if (exited) return true;
        try { child.stdin.end(); }
        catch (error: unknown) {
          console.warn("[chat/hermes] Child input close failed:", error instanceof Error ? error.name : "UnknownError");
        }
        let terminateTimer: NodeJS.Timeout | undefined;
        let killTimer: NodeJS.Timeout | undefined;
        let settleTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            exitPromise,
            new Promise<void>((resolve) => {
              terminateTimer = setTimeout(() => {
                if (exited) return resolve();
                signalChild("SIGTERM");
                killTimer = setTimeout(() => {
                  if (!exited) signalChild("SIGKILL");
                  // Sending SIGKILL is not proof of exit. Give the real exit
                  // listener a bounded window, then report unknown cleanup.
                  settleTimer = setTimeout(resolve, FORCE_SETTLE_MS);
                  settleTimer.unref?.();
                }, FORCE_SETTLE_MS);
                killTimer.unref?.();
              }, TERMINATION_GRACE_MS);
              terminateTimer.unref?.();
            }),
          ]);
          return exited;
        } finally {
          if (terminateTimer) clearTimeout(terminateTimer);
          if (killTimer) clearTimeout(killTimer);
          if (settleTimer) clearTimeout(settleTimer);
        }
      })();
      return closePromise;
    },
  };
}
