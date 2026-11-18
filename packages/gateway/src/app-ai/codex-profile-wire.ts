import { spawn } from "node:child_process";
import { AppAiResultSchema, type AppAiResult } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { selectCodexTextCompletionModel } from "../chat/codex-model-catalog.js";
import { createCodingOutputBuffer } from "../coding-agents/coding-output-buffer.js";
import { CODEX_CONFIGURED_MODEL_ID } from "./codex-model-intent.js";

const WORKSPACE = "/work";
const MAX_WIRE_BYTES = 512 * 1024;
const UNAVAILABLE = "Native Codex text completion unavailable";
const Reference = z.string().min(1).max(512);
const Frame = z.object({
  id: z.union([z.number().int(), Reference]).optional(),
  method: Reference.optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  params: z.unknown().optional(),
});
const Initialization = z.object({
  userAgent: z.string().max(1024).regex(/^matrix-os\/0\.162\.1(?: |$)/),
  platformOs: z.literal("linux"), platformFamily: z.literal("unix"),
  codexHome: z.literal("/home/matrix-codex/.codex"),
});
const Thread = z.object({
  thread: z.object({ id: Reference, ephemeral: z.literal(true) }),
  cwd: z.literal(WORKSPACE), model: Reference, modelProvider: z.literal("openai"),
  approvalPolicy: z.literal("never"),
  sandbox: z.object({ type: z.literal("readOnly"), networkAccess: z.literal(false) }),
  instructionSources: z.tuple([]),
});
const Turn = z.object({ turn: z.object({ id: Reference }) });
const TurnNotice = z.object({ threadId: Reference, turn: z.object({
  id: Reference, status: z.enum(["inProgress", "completed", "interrupted", "failed"]),
  error: z.null().optional(),
  items: z.array(z.object({ type: z.enum(["agentMessage", "userMessage", "reasoning"]) })).max(128).optional(),
}) });
const Item = z.object({ threadId: Reference, turnId: Reference, item: z.object({
  type: z.enum(["agentMessage", "userMessage", "reasoning"]),
  text: z.string().max(64_000).optional(),
  phase: z.enum(["commentary", "partial_answer", "final_answer"]).nullish(),
}) });
const McpInventory = z.object({ data: z.tuple([]), nextCursor: z.null() });
const SafeItemNotices = /^(item\/(agentMessage|reasoning)\/[A-Za-z]+)$/;

export type HostedCodexRequest = (method: string, params: unknown) => Promise<unknown>;
type FailureStage = "launch" | "initialize" | "model" | "proof" | "thread" | "mcp" | "turn" | "cleanup";

export class HostedCodexTextError extends Error {
  constructor(readonly stage: FailureStage) { super(UNAVAILABLE); }
}

export interface HostedCodexTextTurn {
  command: string;
  args: string[];
  env: Record<string, string>;
  model: string;
  configuredModel?: string;
  prompt: string;
  signal: AbortSignal;
  authorize: (request: HostedCodexRequest) => Promise<void>;
}

/** One qualified process, exactly one ephemeral text turn, and no tool-response authority. */
export async function runHostedCodexTextTurn(options: HostedCodexTextTurn): Promise<AppAiResult> {
  let stage: FailureStage = "launch";
  const unavailable = () => new HostedCodexTextError(stage);
  if (options.signal.aborted) throw unavailable();
  const child = spawn(options.command, options.args, { env: options.env, stdio: "pipe" });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const controller = new AbortController();
  const abort = () => controller.abort(unavailable());
  const chunks = createCodingOutputBuffer(MAX_WIRE_BYTES, "\n");
  let seen = 0;
  let sequence = 0;
  let thread: string | undefined;
  let turn: string | undefined;
  let pending: { id: number; resolve(value: unknown): void } | undefined;
  let executing = false;
  let completed: (() => void) | undefined;
  let finalText: string | undefined;

  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(unavailable()), { once: true });
  });
  void aborted.catch(() => undefined);
  child.once("error", abort);
  child.once("close", abort);
  child.stdin.once("error", abort);
  child.stdout.once("error", abort);
  child.stderr.resume();
  child.stderr.once("error", abort);
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();

  const send = (message: unknown) => {
    controller.signal.throwIfAborted();
    child.stdin.write(JSON.stringify(message) + "\n");
  };
  const request: HostedCodexRequest = async (method, params) => {
    if (pending) throw unavailable();
    const id = ++sequence;
    const response = new Promise<unknown>(resolve => { pending = { id, resolve }; });
    send({ id, method, params });
    return Promise.race([response, aborted]);
  };
  function bindTurn(threadId: string, turnId: string) {
    if (!executing || threadId !== thread || (turn && turn !== turnId)) throw unavailable();
    turn = turnId;
  }
  function receive(line: string) {
    const frame = Frame.parse(JSON.parse(line));
    if (frame.id !== undefined) {
      if (frame.method || frame.error !== undefined || frame.id !== pending?.id || !Object.hasOwn(frame, "result")) throw unavailable();
      const response = pending;
      pending = undefined;
      response.resolve(frame.result);
      return;
    }
    if (!frame.method || frame.method === "error") throw unavailable();
    if (frame.method === "turn/started" || frame.method === "turn/completed") {
      const notice = TurnNotice.parse(frame.params);
      bindTurn(notice.threadId, notice.turn.id);
      if (frame.method === "turn/completed") {
        if (notice.turn.status !== "completed" || !finalText?.trim()) throw unavailable();
        completed?.();
      }
    } else if (frame.method === "item/started" || frame.method === "item/completed") {
      const item = Item.parse(frame.params);
      bindTurn(item.threadId, item.turnId);
      if (frame.method === "item/completed" && item.item.type === "agentMessage"
        && item.item.phase !== "commentary" && item.item.phase !== "partial_answer") finalText = item.item.text;
    } else if (frame.method.startsWith("item/") && !SafeItemNotices.test(frame.method)) {
      throw unavailable();
    }
  }
  child.stdout.on("data", (chunk: Buffer) => {
    if (controller.signal.aborted) return;
    try {
      seen += chunk.length;
      if (seen > MAX_WIRE_BYTES) throw unavailable();
      chunks.push(chunk, line => { if (line.trim()) receive(line); return true; });
    } catch (error) {
      if (!(error instanceof Error)) console.warn("[app-ai] Native Codex transport raised an unknown error");
      abort();
    }
  });

  try {
    stage = "initialize";
    Initialization.parse(await request("initialize", { clientInfo: { name: "matrix-os", title: "Matrix OS", version: "1" }, capabilities: { experimentalApi: true } }));
    send({ method: "initialized", params: {} });
    stage = "model";
    const model = options.model === CODEX_CONFIGURED_MODEL_ID
      ? selectCodexTextCompletionModel(await request("model/list", { limit: 64, includeHidden: false }), options.configuredModel)
      : options.model;
    if (model === CODEX_CONFIGURED_MODEL_ID) throw unavailable();
    stage = "thread";
    const started = Thread.parse(await request("thread/start", {
      cwd: WORKSPACE, model, modelProvider: "openai", allowProviderModelFallback: false,
      approvalPolicy: "never", sandbox: "read-only", ephemeral: true,
      environments: [], runtimeWorkspaceRoots: [], dynamicTools: [], selectedCapabilityRoots: [],
      developerInstructions: "Answer using only the supplied text. Do not request tools or additional permissions.",
    }));
    if (started.model !== model) throw unavailable();
    thread = started.thread.id;
    stage = "mcp";
    McpInventory.parse(await request("mcpServerStatus/list", { threadId: thread, limit: 1 }));
    // The isolated thread and empty tool inventory do no inference. Keep
    // the fresh owner/account proof immediately before sending the prompt.
    stage = "proof";
    await Promise.race([options.authorize(request), aborted]);
    const done = new Promise<void>(resolve => { completed = resolve; });
    executing = true;
    stage = "turn";
    const accepted = Turn.parse(await request("turn/start", {
      threadId: thread, environments: [], input: [{ type: "text", text: options.prompt, textElements: [] }],
    }));
    bindTurn(thread, accepted.turn.id);
    await Promise.race([done, aborted]);
    stage = "proof";
    await Promise.race([options.authorize(request), aborted]);
    controller.signal.throwIfAborted();
    return AppAiResultSchema.parse({ text: finalText });
  } catch (error) {
    if (!(error instanceof Error)) console.warn("[app-ai] Native Codex completion raised an unknown error");
    throw unavailable();
  } finally {
    options.signal.removeEventListener("abort", abort);
    const stop = (signal: NodeJS.Signals) => {
      try { child.kill(signal); }
      catch (error) { console.warn("[app-ai] Native Codex termination unavailable", error instanceof Error ? error.name : "UnknownError"); }
    };
    stop("SIGTERM");
    const force = setTimeout(() => stop("SIGKILL"), 250);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([closed, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new HostedCodexTextError("cleanup")), 2_000);
      })]);
    } finally { clearTimeout(force); clearTimeout(timeout); }
  }
}
