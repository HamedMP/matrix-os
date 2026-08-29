import { isKernelResultFailureText } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { KernelEvent } from "@matrix-os/kernel";
import type { Dispatcher } from "../dispatcher.js";
import { KernelCredentialAccessSourceIdSchema } from "../kernel-credentials.js";
import { KernelEffortSchema, KernelModelSchema } from "../kernel-settings.js";
import { createCanonicalCliEventQueue } from "./cli-process.js";
import {
  CanonicalProviderRunEventSchema,
  parseCanonicalProviderRunInput,
  type CanonicalChatProviderAdapter,
  type CanonicalProviderRunEvent,
  type CanonicalProviderRunInput,
} from "./provider-adapter.js";

const KernelChatStateSchema = z.object({
  sessionId: z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/),
}).strict();

export type KernelChatState = z.infer<typeof KernelChatStateSchema>;

function textEvents(text: string): CanonicalProviderRunEvent[] {
  const events: CanonicalProviderRunEvent[] = [];
  for (let index = 0; index < text.length; index += 4_000) {
    const delta = text.slice(index, index + 4_000);
    if (delta) events.push(CanonicalProviderRunEventSchema.parse({ type: "assistant.delta", delta }));
  }
  return events;
}

function selectedEffort(input: CanonicalProviderRunInput<KernelChatState>) {
  const value = input.selection.options?.find((option) => option.id === "effort")?.value;
  return typeof value === "string" ? KernelEffortSchema.parse(value) : undefined;
}

function selectedAccessSource(input: CanonicalProviderRunInput<KernelChatState>) {
  const prefix = "kernel_";
  if (!input.selection.instanceId.startsWith(prefix)) {
    throw new Error("Invalid kernel Provider instance");
  }
  return KernelCredentialAccessSourceIdSchema.parse(input.selection.instanceId.slice(prefix.length));
}

export function createKernelChatProviderAdapter(options: {
  dispatcher: Pick<Dispatcher, "dispatch">;
}): CanonicalChatProviderAdapter<KernelChatState> {
  if (!options.dispatcher) throw new Error("Kernel dispatcher is required");

  async function* execute(
    inputValue: CanonicalProviderRunInput<KernelChatState>,
    resumeState?: KernelChatState,
  ): AsyncGenerator<CanonicalProviderRunEvent> {
    const input = parseCanonicalProviderRunInput(inputValue);
    if (input.interactionMode !== "default") throw new Error("Unsupported kernel interaction mode");
    if (input.permissionMode !== "full_access") throw new Error("Unsupported kernel permission mode");
    const model = KernelModelSchema.parse(input.selection.model);
    const effort = selectedEffort(input);
    const accessSourceId = selectedAccessSource(input);
    const queue = createCanonicalCliEventQueue<CanonicalProviderRunEvent>();
    const controller = new AbortController();
    let activeTool: { id: string; label: string } | null = null;
    let toolSequence = 0;
    let terminal = false;
    const abort = () => controller.abort();
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener("abort", abort, { once: true });

    const pushTerminal = (event: CanonicalProviderRunEvent) => {
      if (terminal) return;
      terminal = true;
      queue.push(CanonicalProviderRunEventSchema.parse(event));
    };
    const onEvent = (event: KernelEvent) => {
      if (terminal) return;
      if (event.type === "init") {
        queue.push(CanonicalProviderRunEventSchema.parse({
          type: "state.updated",
          state: { sessionId: event.sessionId },
        }));
      } else if (event.type === "text") {
        for (const textEvent of textEvents(event.text)) queue.push(textEvent);
      } else if (event.type === "tool_start") {
        activeTool = { id: `kernel_tool_${++toolSequence}`, label: event.tool };
        queue.push(CanonicalProviderRunEventSchema.parse({
          type: "tool.progress",
          toolCallId: activeTool.id,
          label: activeTool.label,
          status: "running",
        }));
      } else if (event.type === "tool_end" && activeTool) {
        queue.push(CanonicalProviderRunEventSchema.parse({
          type: "tool.progress",
          toolCallId: activeTool.id,
          label: activeTool.label,
          status: "completed",
        }));
        activeTool = null;
      } else if (event.type === "result") {
        if ((event.data.errors?.length ?? 0) > 0 || isKernelResultFailureText(event.data.result)) {
          pushTerminal({
            type: "run.completed",
            outcome: "failed",
            error: {
              code: "run_failed",
              safeMessage: "The selected provider could not complete this Run.",
              retryable: true,
              recoveryActions: ["retry"],
            },
          });
        } else {
          pushTerminal({ type: "run.completed", outcome: "completed" });
        }
      } else if (event.type === "aborted") {
        pushTerminal({ type: "run.completed", outcome: "aborted" });
      } else if (event.type === "refusal") {
        pushTerminal({
          type: "run.completed",
          outcome: "failed",
          error: {
            code: "model_unavailable",
            safeMessage: "The selected model could not complete this Run.",
            retryable: false,
            recoveryActions: ["select_provider"],
          },
        });
      }
    };

    void options.dispatcher.dispatch(
      input.prompt,
      resumeState?.sessionId,
      onEvent,
      undefined,
      controller,
      {
        model,
        accessSourceId,
        ...(effort ? { effort } : {}),
        ...(input.executionRoot ? { workingDirectory: input.executionRoot } : {}),
      },
    ).then(() => {
      if (!terminal) {
        pushTerminal(controller.signal.aborted
          ? { type: "run.completed", outcome: "aborted" }
          : { type: "run.completed", outcome: "completed" });
      }
      queue.finish();
    }).catch((error: unknown) => {
      console.warn(
        "[chat/kernel] Provider Run failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      pushTerminal(controller.signal.aborted
        ? { type: "run.completed", outcome: "aborted" }
        : {
            type: "run.completed",
            outcome: "failed",
            error: {
              code: "run_failed",
              safeMessage: "The selected provider could not complete this Run.",
              retryable: true,
              recoveryActions: ["retry"],
            },
          });
      queue.finish();
    }).finally(() => {
      input.signal.removeEventListener("abort", abort);
    });

    yield* queue.values();
  }

  return {
    driverKind: "kernel",
    stateSchemaVersion: 1,
    parseState: (value) => KernelChatStateSchema.parse(value),
    serializeState: (value) => KernelChatStateSchema.parse(value),
    start: (input) => execute(input),
    resume: (input) => execute(input, KernelChatStateSchema.parse(input.resumeState)),
  };
}
