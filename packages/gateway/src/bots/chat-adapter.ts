/**
 * The `matrix_bot` canonical Chat adapter (spec 536). It turns a person's
 * message in a bot's direct chat into one bot run, and maps the worker's
 * events onto canonical Chat events: reply text, tool progress, and
 * activity. Model reasoning never reaches Chat. The Pi transcript lives in
 * owner Postgres, so every turn starts from the saved session; the adapter
 * state only records the task and runtime so a lost run can be closed.
 *
 * Runs do not survive a gateway restart: shutdown cancels them, and a run
 * found afterwards is failed, its runtime stopped, and nothing is replayed.
 */
import { createHash } from "node:crypto";
import type { BotEvent } from "@matrix-os/contracts";
import { z } from "zod/v4";
import {
  CanonicalProviderRunEventSchema,
  parseCanonicalProviderRunInput,
  type CanonicalChatProviderAdapter,
  type CanonicalProviderRunEvent,
} from "../chat/provider-adapter.js";
import type { BotTaskOrchestrator, BotTurnResult } from "./task-orchestrator.js";

const MAX_DELTA_CHARS = 4_000;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const BotChatStateSchema = z.object({
  taskId: z.string().regex(/^task_[A-Za-z0-9_-]{8,64}$/),
  runtimeHandle: z.string().regex(/^runtime_[a-f0-9]{32}$/).optional(),
  executionGeneration: z.string().regex(/^(0|[1-9][0-9]{0,19})$/).optional(),
}).strict();
export type BotChatState = z.infer<typeof BotChatStateSchema>;

const TOOL_LABELS: Record<string, string> = {
  "artifact.read": "Reading a file",
  "artifact.write": "Saving a file",
  "memory.search": "Checking what it remembers",
  "memory.propose": "Noting a preference",
  "interaction.create": "Asking you",
  "integration.inventory": "Checking connected services",
  "integration.call": "Using a connected service",
};

/** Canonical refs are narrower than model tool IDs; hash anything outside them. */
function safeRef(prefix: string, value: string): string {
  return SAFE_REF.test(value) ? value : `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function mapEvent(event: BotEvent["event"]): CanonicalProviderRunEvent[] {
  switch (event.type) {
    case "assistant_delta": {
      const deltas: CanonicalProviderRunEvent[] = [];
      for (let index = 0; index < event.text.length; index += MAX_DELTA_CHARS) {
        deltas.push({ type: "assistant.delta", delta: event.text.slice(index, index + MAX_DELTA_CHARS) });
      }
      return deltas;
    }
    case "tool_progress":
      return [{
        type: "tool.progress",
        toolCallId: safeRef("tool", event.toolCallId),
        label: TOOL_LABELS[event.capability] ?? "Using a tool",
        status: event.phase === "started" ? "running" : event.phase,
      }];
    case "activity":
      return [{
        type: "agent.activity",
        activityId: safeRef("activity", `activity_${createHash("sha256").update(event.label).digest("hex").slice(0, 24)}`),
        kind: "phase",
        label: event.label,
        status: event.state === "started" ? "running" : event.state,
      }];
  }
}

const FAILURES: Partial<Record<NonNullable<BotTurnResult["blockedReason"]>, { code: "model_unavailable" | "service_unavailable" | "resource_unavailable" | "run_failed"; message: string }>> = {
  model_unavailable: { code: "model_unavailable", message: "No model is available for this bot. Check Agents & providers." },
  funds_unavailable: { code: "service_unavailable", message: "Matrix AI credit is unavailable for this bot right now." },
  capacity_unavailable: { code: "service_unavailable", message: "The bot could not get capacity to run. Try again shortly." },
  root_unavailable: { code: "resource_unavailable", message: "The bot's workspace is unavailable." },
  deadline_reached: { code: "run_failed", message: "The bot reached its time limit for this task." },
  budget_exhausted: { code: "run_failed", message: "The bot reached its action limit for this task." },
};

function completion(result: BotTurnResult): CanonicalProviderRunEvent {
  if (result.status === "completed" || result.status === "waiting_person") return { type: "run.completed", outcome: "completed" };
  if (result.status === "cancelled") return { type: "run.completed", outcome: "aborted" };
  const failure = (result.blockedReason && FAILURES[result.blockedReason])
    ?? { code: "run_failed" as const, message: "The bot could not finish this request." };
  return {
    type: "run.completed",
    outcome: "failed",
    error: { code: failure.code, safeMessage: failure.message, retryable: true, recoveryActions: ["retry"] },
  };
}

function messageText(parts: readonly { type: string; text?: string }[]): string {
  return parts.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n\n");
}

export function createMatrixBotChatProviderAdapter(options: {
  orchestrator: Pick<BotTaskOrchestrator, "start" | "steer" | "cancel" | "abandon">;
  stopRuntime(runtimeHandle: string): Promise<void>;
}): CanonicalChatProviderAdapter<BotChatState> {
  return {
    driverKind: "matrix_bot",
    stateSchemaVersion: 1,
    parseState: (value) => BotChatStateSchema.parse(value),
    serializeState: (value) => BotChatStateSchema.parse(value),
    async *start(inputValue) {
      const input = parseCanonicalProviderRunInput(inputValue);
      if (input.owner.type !== "personal") throw new Error("Bots run only for a personal owner");
      const handle = options.orchestrator.start({
        ownerId: input.owner.ownerId, chatId: input.chatId, runId: input.runId,
        text: messageText(input.parts), signal: input.signal,
      });
      let result: BotTurnResult;
      let drained = false;
      try {
        for await (const item of handle.events) {
          if (item.kind === "state") {
            yield CanonicalProviderRunEventSchema.parse({ type: "state.updated", state: BotChatStateSchema.parse(item.state) });
            continue;
          }
          for (const event of mapEvent(item.event)) yield CanonicalProviderRunEventSchema.parse(event);
        }
        drained = true;
      } finally {
        // A consumer that stopped reading early must not leave the bot running for its whole turn.
        if (!drained) await options.orchestrator.cancel(input.runId);
        result = await handle.result.catch((error: unknown) => {
          console.warn("[bots] bot turn failed:", error instanceof Error ? error.name : "UnknownError");
          return { status: "failed" as const };
        });
      }
      yield CanonicalProviderRunEventSchema.parse(completion(result));
    },
    async steer(input) {
      const text = messageText(input.parts) || input.prompt;
      if (!await options.orchestrator.steer(input.runId, text)) throw new Error("Bot run is not accepting messages");
    },
    async cancel(input) {
      await options.orchestrator.cancel(input.runId);
    },
    /** A run the previous gateway lost: stop its runtime, fail its task, replay nothing. */
    async recover(input) {
      if (input.owner.type !== "personal") return null;
      if (input.state.runtimeHandle) await options.stopRuntime(input.state.runtimeHandle);
      await options.orchestrator.abandon({ ownerId: input.owner.ownerId, taskId: input.state.taskId });
      return { outcome: "failed", messages: [] };
    },
  };
}
