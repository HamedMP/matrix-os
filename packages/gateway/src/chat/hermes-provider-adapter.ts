import { spawn } from "node:child_process";
import { join } from "node:path";
import { z } from "zod/v4";
import { buildAgentRuntimeEnvironment } from "../agent-launcher.js";
import {
  CanonicalProviderRunEventSchema,
  parseCanonicalProviderRunInput,
  type CanonicalChatProviderAdapter,
  type CanonicalProviderRunEvent,
  type CanonicalProviderRunInput,
} from "./provider-adapter.js";
import { createCanonicalCliEventQueue } from "./cli-process.js";

const HermesChatStateSchema = z.object({
  sessionId: z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/),
}).strict();
const GatewaySessionSchema = z.object({
  session_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  stored_session_id: HermesChatStateSchema.shape.sessionId,
}).passthrough();
const GatewayEventSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("event"),
  params: z.object({
    type: z.string().min(1).max(128),
    session_id: z.string().max(128).optional().default(""),
    payload: z.unknown().optional(),
  }).passthrough(),
}).passthrough();
const GatewayDeltaSchema = z.object({ text: z.string().min(1) }).passthrough();
const GatewayCompleteSchema = z.object({
  text: z.string().optional(),
  status: z.string().max(64).optional(),
}).passthrough();

export type HermesChatState = z.infer<typeof HermesChatStateSchema>;
interface HermesGatewayProcess {
  stdin: { write(chunk: string | Buffer): boolean; end(): void };
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): void };
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): void };
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  kill(signal: NodeJS.Signals): boolean;
}
export type HermesGatewaySpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdio: ["pipe", "pipe", "pipe"] },
) => HermesGatewayProcess;
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STALL_TIMEOUT_MS = 120_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_FORCE_SETTLE_MS = 250;
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 8 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 96 * 1024;
function selection(value: string): { provider: string; model: string } {
  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error("Unsupported Hermes model selection");
  }
  const provider = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/).parse(value.slice(0, separator));
  const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/).parse(value.slice(separator + 1));
  return { provider, model };
}
function timeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class HermesStdioRpcClient {
  private readonly child: HermesGatewayProcess;
  private readonly pending = new Map<string, Deferred<unknown>>();
  private readonly ready = deferred<void>();
  private readonly failed = deferred<Error>();
  private readonly exited = deferred<void>();
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private stdoutBuffer = Buffer.alloc(0);
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private requestSequence = 0;
  private stallTimer: NodeJS.Timeout | undefined;
  private shuttingDown = false;
  private failure: Error | undefined;
  private eventListener: ((event: z.infer<typeof GatewayEventSchema>["params"]) => void) | undefined;

  constructor(private readonly options: {
    command: string;
    cwd: string;
    env: Record<string, string>;
    spawnFn: HermesGatewaySpawn;
    maxFrameBytes: number;
    maxStdoutBytes: number;
    maxStderrBytes: number;
    stallTimeoutMs: number;
  }) {
    this.child = options.spawnFn(options.command, ["-u", "-m", "tui_gateway.entry"], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrBytes += chunk.byteLength;
      if (this.stderrBytes > options.maxStderrBytes) this.fail(new Error("Hermes stderr exceeded limit"));
    });
    this.child.once("error", () => this.fail(new Error("Hermes gateway child could not start")));
    this.child.once("exit", (code, signal) => {
      this.exited.resolve();
      if (!this.shuttingDown) this.fail(new Error(`Hermes gateway child exited (${code ?? signal ?? "unknown"})`));
    });
  }

  onEvent(listener: (event: z.infer<typeof GatewayEventSchema>["params"]) => void): void {
    this.eventListener = listener;
  }

  async waitForEvent<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return this.wait(promise, timeoutMs, "Hermes gateway event timed out");
  }

  async waitUntilReady(timeoutMs: number): Promise<void> {
    await this.wait(this.ready.promise, timeoutMs, "Hermes gateway startup timed out");
    this.touch();
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.shuttingDown || this.failure) throw this.failure ?? new Error("Hermes gateway child is closing");
    if (this.pending.size >= 16) throw new Error("Too many pending Hermes requests");
    const id = `matrix-${++this.requestSequence}`;
    const response = deferred<unknown>();
    this.pending.set(id, response);
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    } catch (error: unknown) {
      this.pending.delete(id);
      throw new Error("Hermes gateway request could not be written", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    try {
      return await this.wait(response.promise, timeoutMs, "Hermes gateway request timed out");
    } finally {
      this.pending.delete(id);
    }
  }

  async shutdown(terminationGraceMs: number, forceSettleMs: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    try {
      this.child.stdin.end();
    } catch (error: unknown) {
      console.warn("[chat/hermes] Gateway stdin close failed:", error instanceof Error ? error.name : "UnknownError");
    }
    this.child.kill("SIGTERM");
    if (await this.exitedWithin(terminationGraceMs)) return;
    this.child.kill("SIGKILL");
    await this.exitedWithin(forceSettleMs);
  }

  private async exitedWithin(timeoutMs: number): Promise<boolean> {
    try {
      await timeout(this.exited.promise, timeoutMs, "Hermes child exit timed out");
      return true;
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      return false;
    }
  }

  private async wait<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
    const outcome = await Promise.race([
      timeout(promise, timeoutMs, timeoutMessage).then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      this.failed.promise.then((error) => ({ kind: "error" as const, error })),
    ]);
    if (outcome.kind === "error") throw outcome.error;
    return outcome.value;
  }

  private touch(): void {
    if (this.shuttingDown || this.failure) return;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => this.fail(new Error("Hermes gateway stream stalled")), this.options.stallTimeoutMs);
    this.stallTimer.unref?.();
  }

  private onStdout(chunk: Buffer): void {
    if (this.shuttingDown || this.failure) return;
    this.stdoutBytes += chunk.byteLength;
    if (this.stdoutBytes > this.options.maxStdoutBytes) {
      this.fail(new Error("Hermes stdout exceeded limit"));
      return;
    }
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.byteLength > this.options.maxFrameBytes && !this.stdoutBuffer.includes(0x0a)) {
      this.fail(new Error("Hermes frame exceeded limit"));
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.byteLength === 0) continue;
      if (line.byteLength > this.options.maxFrameBytes) {
        this.fail(new Error("Hermes frame exceeded limit"));
        return;
      }
      try {
        const frame = JSON.parse(this.decoder.decode(line)) as unknown;
        this.handleFrame(frame);
        this.touch();
      } catch (error: unknown) {
        this.fail(new Error("Hermes frame was malformed", {
          cause: error instanceof Error ? error : undefined,
        }));
        return;
      }
    }
  }

  private handleFrame(value: unknown): void {
    const event = GatewayEventSchema.safeParse(value);
    if (event.success) {
      if (event.data.params.type === "gateway.ready") this.ready.resolve();
      this.eventListener?.(event.data.params);
      return;
    }
    const response = z.object({
      jsonrpc: z.literal("2.0"),
      id: z.string().min(1).max(128),
      result: z.unknown().optional(),
      error: z.unknown().optional(),
    }).passthrough().safeParse(value);
    if (!response.success) throw new Error("Invalid Hermes JSON-RPC frame");
    const pending = this.pending.get(response.data.id);
    if (!pending) return;
    if (response.data.error !== undefined) pending.reject(new Error("Hermes JSON-RPC request failed"));
    else pending.resolve(response.data.result);
  }

  private fail(error: Error): void {
    if (this.failure || this.shuttingDown) return;
    this.failure = error;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.failed.resolve(error);
    this.ready.reject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function chunks(text: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < text.length; index += 4_000) values.push(text.slice(index, index + 4_000));
  return values;
}

export function createHermesChatProviderAdapter(options: {
  homePath: string;
  spawnFn?: HermesGatewaySpawn;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  stallTimeoutMs?: number;
  totalTimeoutMs?: number;
  terminationGraceMs?: number;
  forceSettleMs?: number;
  maxFrameBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxOutputBytes?: number;
}): CanonicalChatProviderAdapter<HermesChatState> {
  async function* execute(
    inputValue: CanonicalProviderRunInput<HermesChatState>,
    resumeState?: HermesChatState,
  ): AsyncGenerator<CanonicalProviderRunEvent> {
    const input = parseCanonicalProviderRunInput(inputValue);
    if (input.permissionMode !== "full_access") throw new Error("Unsupported Hermes permission mode");
    if (input.interactionMode !== "default") throw new Error("Unsupported Hermes interaction mode");
    const selected = selection(input.selection.model);
    const queue = createCanonicalCliEventQueue<CanonicalProviderRunEvent>();
    const terminal = deferred<"completed" | "failed">();
    const abort = deferred<void>();
    const root = join(options.homePath, ".hermes", "hermes-agent");
    let client: HermesStdioRpcClient;
    try {
      client = new HermesStdioRpcClient({
        command: join(root, "venv", "bin", "python"),
        cwd: input.executionRoot ?? options.homePath,
        env: {
          ...process.env,
          ...buildAgentRuntimeEnvironment(options.homePath),
          PYTHONPATH: root,
          HERMES_PYTHON_SRC_ROOT: root,
          PYTHONUNBUFFERED: "1",
        } as Record<string, string>,
        spawnFn: options.spawnFn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions)),
        maxFrameBytes: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
        maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
        maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
        stallTimeoutMs: options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
      });
    } catch (error: unknown) {
      console.warn("[chat/hermes] Provider Run failed:", error instanceof Error ? error.name : "UnknownError");
      yield CanonicalProviderRunEventSchema.parse({
        type: "run.completed",
        outcome: "failed",
        error: {
          code: "run_failed",
          safeMessage: "Hermes could not complete this Run. Check its provider connection and retry.",
          retryable: true,
          recoveryActions: ["retry"],
        },
      });
      return;
    }
    const onAbort = () => abort.resolve();
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) abort.resolve();
    let liveSessionId: string | undefined;
    let storedSessionId: string | undefined;
    let outputBytes = 0;
    let output = "";
    let terminalSeen = false;

    client.onEvent((event) => {
      if (!liveSessionId || event.session_id !== liveSessionId || terminalSeen) return;
      if (event.type === "message.delta") {
        const payload = GatewayDeltaSchema.parse(event.payload);
        outputBytes += Buffer.byteLength(payload.text);
        if (outputBytes > (options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)) {
          terminal.reject(new Error("Hermes assistant output exceeded limit"));
          return;
        }
        output += payload.text;
        for (const delta of chunks(payload.text)) {
          queue.push(CanonicalProviderRunEventSchema.parse({ type: "assistant.delta", delta }));
        }
      } else if (event.type === "message.complete") {
        terminalSeen = true;
        const payload = GatewayCompleteSchema.parse(event.payload);
        if (payload.status === "error") {
          terminal.resolve("failed");
          return;
        }
        if (payload.text !== undefined) {
          const completeBytes = Buffer.byteLength(payload.text);
          if (!payload.text.startsWith(output) || completeBytes > (options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)) {
            terminal.reject(new Error("Hermes completion did not match streamed output"));
            return;
          }
          for (const delta of chunks(payload.text.slice(output.length))) {
            queue.push(CanonicalProviderRunEventSchema.parse({ type: "assistant.delta", delta }));
          }
          output = payload.text;
          outputBytes = completeBytes;
        }
        terminal.resolve("completed");
      } else if (event.type === "error") {
        terminal.reject(new Error("Hermes gateway reported an error"));
      }
    });

    void (async () => {
      const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
      const total = deferred<void>();
      const totalTimer = setTimeout(() => total.resolve(), totalTimeoutMs);
      totalTimer.unref?.();
      const runStep = async <T>(step: Promise<T>): Promise<T> => {
        const value = await Promise.race([
          step.then((result) => ({ kind: "value" as const, result })),
          abort.promise.then(() => ({ kind: "aborted" as const })),
          total.promise.then(() => ({ kind: "timed_out" as const })),
        ]);
        if (value.kind === "aborted") throw new Error("Hermes Run aborted");
        if (value.kind === "timed_out") throw new Error("Hermes Run timed out");
        return value.result;
      };
      try {
        await runStep(client.waitUntilReady(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS));
        const sessionResult = GatewaySessionSchema.parse(await runStep(
          resumeState
            ? client.request("session.resume", {
              session_id: resumeState.sessionId,
              cols: 120,
              omit_messages: true,
            }, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
            : client.request("session.create", {
              cols: 120,
              cwd: input.executionRoot ?? options.homePath,
              source: "desktop",
              provider: selected.provider,
              model: selected.model,
            }, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
        ));
        liveSessionId = sessionResult.session_id;
        storedSessionId = sessionResult.stored_session_id;
        await runStep(client.request("config.set", {
          key: "yolo",
          value: "1",
          scope: "session",
          session_id: liveSessionId,
        }, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS));
        await runStep(client.request("prompt.submit", {
          session_id: liveSessionId,
          text: input.prompt,
        }, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS));
        const outcome = await runStep(client.waitForEvent(terminal.promise, totalTimeoutMs));
        if (outcome === "failed") throw new Error("Hermes Run failed");
        if (storedSessionId !== resumeState?.sessionId) {
          queue.push(CanonicalProviderRunEventSchema.parse({
            type: "state.updated",
            state: { sessionId: storedSessionId },
          }));
        }
        queue.push(CanonicalProviderRunEventSchema.parse({ type: "run.completed", outcome: "completed" }));
      } catch (error: unknown) {
        const aborted = input.signal.aborted;
        if (aborted && liveSessionId) {
          try {
            await client.request("session.interrupt", { session_id: liveSessionId }, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
          } catch (interruptError: unknown) {
            console.warn(
              "[chat/hermes] Session interrupt failed:",
              interruptError instanceof Error ? interruptError.name : "UnknownError",
            );
          }
        }
        console.warn("[chat/hermes] Provider Run failed:", error instanceof Error ? error.name : "UnknownError");
        queue.push(CanonicalProviderRunEventSchema.parse({
          type: "run.completed",
          outcome: aborted ? "aborted" : "failed",
          ...(aborted ? {} : {
            error: {
              code: "run_failed",
              safeMessage: "Hermes could not complete this Run. Check its provider connection and retry.",
              retryable: true,
              recoveryActions: ["retry"],
            },
          }),
        }));
      } finally {
        clearTimeout(totalTimer);
        input.signal.removeEventListener("abort", onAbort);
        await client.shutdown(
          options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
          options.forceSettleMs ?? DEFAULT_FORCE_SETTLE_MS,
        );
        queue.finish();
      }
    })();

    yield* queue.values();
  }

  return {
    driverKind: "hermes",
    stateSchemaVersion: 1,
    parseState: (value) => HermesChatStateSchema.parse(value),
    serializeState: (value) => HermesChatStateSchema.parse(value),
    start: (input) => execute(input),
    resume: (input) => execute(input, HermesChatStateSchema.parse(input.resumeState)),
  };
}
