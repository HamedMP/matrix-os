import { z } from "zod/v4";
import type { KernelEvent } from "@matrix-os/kernel";
import type { Dispatcher } from "../dispatcher.js";
import {
  KERNEL_DEFAULTS,
  KernelEffortSchema,
  KernelModelSchema,
} from "../kernel-settings.js";
import {
  CanonicalProviderRunEventSchema,
  parseCanonicalProviderRunInput,
  type CanonicalChatProviderAdapter,
  type CanonicalProviderRunEvent,
  type CanonicalProviderRunInput,
} from "./provider-adapter.js";

const HermesChatStateSchema = z.object({
  sessionId: z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/),
}).strict();
const MAX_BUFFERED_EVENTS = 500;

export type HermesChatState = z.infer<typeof HermesChatStateSchema>;

interface AsyncEventQueue {
  push(event: CanonicalProviderRunEvent): void;
  finish(error?: Error): void;
  values(): AsyncGenerator<CanonicalProviderRunEvent>;
}

function createAsyncEventQueue(onOverflow: () => void): AsyncEventQueue {
  const values: CanonicalProviderRunEvent[] = [];
  let done = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  return {
    push(event) {
      if (done) return;
      if (values.length >= MAX_BUFFERED_EVENTS) {
        done = true;
        failure = new Error("Canonical Hermes Provider event buffer exceeded");
        onOverflow();
        wake?.();
        wake = undefined;
        return;
      }
      values.push(CanonicalProviderRunEventSchema.parse(event));
      wake?.();
      wake = undefined;
    },
    finish(error) {
      if (done) {
        if (error && !failure) failure = error;
        return;
      }
      done = true;
      failure = error;
      wake?.();
      wake = undefined;
    },
    async *values() {
      while (!done || values.length > 0) {
        const next = values.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (failure) throw failure;
    },
  };
}

function kernelSelection(input: CanonicalProviderRunInput) {
  const [provider, modelId, extra] = input.selection.model.split(":");
  if (provider !== "anthropic" || !modelId || extra !== undefined) {
    throw new Error("Unsupported Matrix kernel selection");
  }
  const model = KernelModelSchema.safeParse(modelId);
  if (!model.success) throw new Error("Unsupported Matrix kernel selection");
  const selectedEffort = input.selection.options?.find((option) => option.id === "effort")?.value
    ?? KERNEL_DEFAULTS.effort;
  const effort = KernelEffortSchema.safeParse(selectedEffort);
  if (!effort.success) throw new Error("Unsupported Matrix kernel selection");
  return { model: model.data, effort: effort.data };
}

function safeToolLabel(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240);
  return normalized || "Tool";
}

export function createHermesChatProviderAdapter(options: {
  dispatcher: Pick<Dispatcher, "dispatch">;
  timeoutMs?: number;
}): CanonicalChatProviderAdapter<HermesChatState> {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60 * 60 * 1_000) {
    throw new RangeError("Invalid Matrix kernel Run timeout");
  }

  function execute(
    inputValue: CanonicalProviderRunInput<HermesChatState>,
    sessionId?: string,
  ): AsyncIterable<CanonicalProviderRunEvent> {
    const input = parseCanonicalProviderRunInput(inputValue);
    const selection = kernelSelection(input);
    if (input.interactionMode !== "default" || input.permissionMode !== "supervised") {
      throw new Error("Unsupported Matrix kernel mode");
    }
    const controller = new AbortController();
    const queue = createAsyncEventQueue(() => controller.abort());
    const abort = () => controller.abort();
    input.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, timeoutMs);
    let toolIndex = 0;
    let activeTool: { id: string; label: string } | undefined;
    let terminal = false;

    const onEvent = (event: KernelEvent) => {
      if (terminal) return;
      if (event.type === "init") {
        queue.push({ type: "state.updated", state: { sessionId: event.sessionId } });
      } else if (event.type === "text" && event.text) {
        queue.push({ type: "assistant.delta", delta: event.text });
      } else if (event.type === "tool_start") {
        toolIndex += 1;
        activeTool = { id: `kernel_tool_${toolIndex}`, label: safeToolLabel(event.tool) };
        queue.push({
          type: "tool.progress",
          toolCallId: activeTool.id,
          label: activeTool.label,
          status: "running",
        });
      } else if (event.type === "tool_end" && activeTool) {
        queue.push({
          type: "tool.progress",
          toolCallId: activeTool.id,
          label: activeTool.label,
          status: "completed",
        });
        activeTool = undefined;
      } else if (event.type === "aborted") {
        terminal = true;
        queue.push({ type: "run.completed", outcome: "aborted" });
      } else if (event.type === "result") {
        terminal = true;
        queue.push(event.data.errors && event.data.errors.length > 0
          ? {
              type: "run.completed",
              outcome: "failed",
              error: {
                code: "run_failed",
                safeMessage: "The Matrix agent Run failed.",
                retryable: true,
                recoveryActions: ["retry"],
              },
            }
          : { type: "run.completed", outcome: "completed" });
      }
    };

    void options.dispatcher.dispatch(
      input.prompt,
      sessionId,
      onEvent,
      { chatId: input.chatId },
      controller,
      {
        ...selection,
        ...(input.executionRoot ? { workingDirectory: input.executionRoot } : {}),
      },
    ).then(() => {
      if (!terminal) queue.push({ type: "run.completed", outcome: controller.signal.aborted ? "aborted" : "completed" });
      queue.finish();
    }).catch((error: unknown) => {
      queue.finish(new Error(
        controller.signal.aborted ? "Matrix kernel Run aborted" : "Matrix kernel dispatch failed",
        { cause: error },
      ));
    }).finally(() => {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
    });

    return { [Symbol.asyncIterator]: () => queue.values() };
  }

  return {
    driverKind: "hermes",
    stateSchemaVersion: 1,
    parseState: (value) => HermesChatStateSchema.parse(value),
    serializeState: (value) => HermesChatStateSchema.parse(value),
    start: (input) => execute(input),
    resume: (input) => execute(input, HermesChatStateSchema.parse(input.resumeState).sessionId),
  };
}
