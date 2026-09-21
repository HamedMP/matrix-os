import {
  CanonicalChatSafeErrorSchema,
  type CanonicalProviderDriverKind,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { ScopeRuntimeSandboxManifest } from "@matrix-os/scope-runtime";
import {
  CanonicalProviderRunEventSchema,
  parseCanonicalProviderRunInput,
  type CanonicalChatProviderAdapter,
} from "../chat/provider-adapter.js";
import type { ScopeRuntimeSandboxManifest } from "@matrix-os/scope-runtime";
import type { CollaborationRunInterruptionReason } from "@matrix-os/contracts";
import type { ScopeRuntimeCapability } from "./scope-runtime-client.js";
import { classifySharedRunLoss } from "./shared-run-loss.js";
const StateSchema = z.object({
  runtimeHandle: z.string().regex(/^runtime_[a-f0-9]{32}$/),
  executionGeneration: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
}).strict();
type State = z.infer<typeof StateSchema>;
export interface ScopeRuntimeChatClient {
  capability(): ScopeRuntimeCapability;
  createRuntime(input: {
    scopeHandle: string;
    workload: "chat_ai";
    adapterId: string;
    harnessVersion: string;
    /** S07/S09: present for every run that acts for a collaborator on an execution root; the client refuses a launch without it. */
    sandbox?: ScopeRuntimeSandboxManifest;
  }): Promise<{ runtimeHandle: string; executionGeneration: string; state: "running" }>;
  runChat(input: State & { model: string; prompt: string }): Promise<State & { text: string }>;
  stopRuntime(input: { runtimeHandle: string }): Promise<unknown>;
}
export interface SharedRuntimeBindingRegistry {
  bind(binding: { scopeId: string; actorId: string; runtimeHandle: string }): void;
  release(runtimeHandle: string): void;
}

export function createScopeRuntimeChatProviderAdapter(options: {
  client: ScopeRuntimeChatClient;
  scopeId: string;
  executionGeneration: string;
  adapterId: "claude-code" | "codex";
  harnessVersion: string;
  /** S07/S09: authoritative sandbox manifest mounting the run's execution root; without it the adapter fails closed before launch. */
  sandbox?: ScopeRuntimeSandboxManifest;
  /** S07: registry that stops the runtime when the actor's lease is lost. */
  runtimes?: SharedRuntimeBindingRegistry;
  /** S09: called once with the loss reason when the home loses the run before its terminal result. */
  onLoss?(reason: CollaborationRunInterruptionReason): void;
}): CanonicalChatProviderAdapter<State> {
  const scopeHandle = `scope_${options.scopeId.replaceAll("-", "")}`;
  if (!/^scope_[a-f0-9]{32}$/.test(scopeHandle)) throw new Error("Invalid collaboration scope handle");
  const sandbox = options.sandbox?.scopeHandle === scopeHandle ? options.sandbox : undefined;
  let stoppedRuntimeHandle: string | undefined;
  let stopInFlight: Promise<void> | undefined;
  const stop = async (state: State | undefined): Promise<void> => {
    if (!state || stoppedRuntimeHandle === state.runtimeHandle) {
      await stopInFlight;
      return;
    }
    if (stopInFlight) {
      await stopInFlight;
      if (stoppedRuntimeHandle === state.runtimeHandle) return;
    }
    const operation = options.client.stopRuntime({ runtimeHandle: state.runtimeHandle }).then(() => {
      stoppedRuntimeHandle = state.runtimeHandle;
      options.runtimes?.release(state.runtimeHandle);
    });
    stopInFlight = operation;
    try {
      await operation;
    } finally {
      if (stopInFlight === operation) stopInFlight = undefined;
    }
  };
  return {
    driverKind: (options.adapterId === "codex" ? "codex" : "claude_code") satisfies CanonicalProviderDriverKind,
    stateSchemaVersion: 1,
    parseState: (value) => StateSchema.parse(value),
    serializeState: (value) => StateSchema.parse(value),
    async *start(value) {
      const input = parseCanonicalProviderRunInput(value);
      if ((input.executionRoot && !options.sandbox) || input.resumeState !== undefined
        || input.parts.some((part) => part.type !== "text")) {
        yield failure("Shared AI supports only the visible Chat transcript on the owner's sandboxed root.");
        return;
      }
      if (!sandbox) {
        yield failure("Shared AI is temporarily unavailable.");
        return;
      }
      const capability = options.client.capability();
      if (!capability.available || capability.executionGeneration !== options.executionGeneration) {
        yield failure("Shared AI is temporarily unavailable.");
        return;
      }
      let state: State | undefined;
      let stage: "create" | "state" | "inference" | "projection" = "create";
      const abort = () => {
        void stop(state).catch((error: unknown) => {
          console.warn("[collaboration] scope runtime cancellation failed",
            error instanceof Error ? error.name : "UnknownError");
        });
      };
      input.signal.addEventListener("abort", abort, { once: true });
      try {
        const created = await options.client.createRuntime({
          scopeHandle,
          workload: "chat_ai",
          adapterId: options.adapterId,
          harnessVersion: options.harnessVersion,
          sandbox,
        });
        if (options.runtimes) {
          options.runtimes.bind({ scopeId: options.scopeId, actorId: sandbox.actorId, runtimeHandle: created.runtimeHandle });
        }
        if (created.executionGeneration !== options.executionGeneration) {
          await stop(StateSchema.parse({
            runtimeHandle: created.runtimeHandle,
            executionGeneration: created.executionGeneration,
          }));
          yield failure("Shared AI is temporarily unavailable.");
          return;
        }
        stage = "state";
        state = StateSchema.parse({
          runtimeHandle: created.runtimeHandle,
          executionGeneration: created.executionGeneration,
        });
        yield CanonicalProviderRunEventSchema.parse({ type: "state.updated", state });
        if (input.signal.aborted) {
          await stop(state);
          yield CanonicalProviderRunEventSchema.parse({ type: "run.completed", outcome: "aborted" });
          return;
        }
        stage = "inference";
        const result = await options.client.runChat({
          ...state,
          model: input.selection.model,
          prompt: input.prompt,
        });
        stage = "projection";
        for (let offset = 0; offset < result.text.length; offset += 4_000) {
          yield CanonicalProviderRunEventSchema.parse({
            type: "assistant.delta",
            delta: result.text.slice(offset, offset + 4_000),
          });
        }
        yield CanonicalProviderRunEventSchema.parse({
          type: "run.completed",
          outcome: "completed",
          provider: options.adapterId === "codex" ? "openai" : "anthropic",
        });
      } catch (error: unknown) {
        console.warn("[collaboration] isolated Chat execution failed", {
          stage,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
        const reason = classifySharedRunLoss(error, stage);
        if (reason && options.onLoss) {
          try {
            options.onLoss(reason);
          } catch (lossError: unknown) {
            console.warn("[collaboration] shared run loss report failed",
              lossError instanceof Error ? lossError.name : "UnknownError");
          }
        }
        yield failure("The isolated shared AI run was interrupted.");
      } finally {
        input.signal.removeEventListener("abort", abort);
        try {
          await stop(state);
        } catch (error: unknown) {
          input.onCleanupUnconfirmed?.();
          console.warn("[collaboration] isolated Chat cleanup unconfirmed",
            error instanceof Error ? error.name : "UnknownError");
        }
      }
    },
    async cancel(input) {
      if (!input.state) return;
      const state = StateSchema.parse(input.state);
      await stop(state);
    },
  };
}
function failure(message: string) {
  return CanonicalProviderRunEventSchema.parse({
    type: "run.completed",
    outcome: "failed",
    error: CanonicalChatSafeErrorSchema.parse({
      code: "run_unavailable",
      safeMessage: message,
      retryable: true,
      recoveryActions: ["retry"],
    }),
  });
}
