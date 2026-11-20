import type { CanonicalChatRun } from "@matrix-os/contracts";
import { assistantMessageId } from "./assistant-credential-crypto.js";
import { diagnoseChatRunFailure } from "./failure-diagnostic.js";
import { CanonicalChatOrchestrationError, canonicalChatSafeError as safeError } from "./orchestration-errors.js";
import { recoverOrphanedRun } from "./orphaned-run-recovery.js";
import type { CanonicalChatProviderRegistry } from "./provider-adapter.js";
import { ChatRunNotActiveError, type ChatRepository } from "./repository.js";
import type { ChatOwner } from "./records.js";

/** Read recovery may settle orphaned runs, but must never interrupt a live claim/preparation. */
export async function reconcileOwnerChatRuns(input: {
  repository: Pick<ChatRepository, "listActiveRunContexts" | "finishRun" | "getAdapterState" | "appendAssistantDelta">;
  adapters: Pick<CanonicalChatProviderRegistry, "get">;
  isActiveOrPreparing(runId: string, chatId: string): boolean;
  assertPersonalExecutionAllowed(owner: ChatOwner, chatId: string): Promise<void>;
  persistActivities(owner: ChatOwner, run: CanonicalChatRun, events: Array<Record<string, unknown>>, occurredAt: string): Promise<void>;
  now?: () => Date;
}, owner: ChatOwner): Promise<number> {
  const contexts = await input.repository.listActiveRunContexts(owner, 64);
  let reconciled = 0;
  for (const context of contexts) {
    if (input.isActiveOrPreparing(context.latestRun.id, context.latestRun.chatId)) continue;
    const completedAt = (input.now ?? (() => new Date()))().toISOString();
    try {
      await input.assertPersonalExecutionAllowed(owner, context.latestRun.chatId);
    } catch (error: unknown) {
      if (!(error instanceof CanonicalChatOrchestrationError)) throw error;
      const finished = await input.repository.finishRun(owner, {
        chatId: context.latestRun.chatId,
        runId: context.latestRun.id,
        outcome: "failed",
        sharedRequestState: "interrupted",
        completedAt,
        diagnostic: diagnoseChatRunFailure(error, "preparation"),
      });
      if (finished.transitioned) reconciled += 1;
      continue;
    }
    const error = safeError(
      "run_unavailable",
      "The Run was interrupted when Matrix restarted.",
      true,
      ["retry"],
    );
    try {
      const recovery = await recoverOrphanedRun({
        owner,
        run: context.latestRun,
        repository: input.repository,
        adapter: input.adapters.get(context.latestRun.driverKind),
        messageId: assistantMessageId,
        persistActivities: (activities) => input.persistActivities(owner, context.latestRun, activities, completedAt),
        completedAt,
      });
      if (recovery === "pending") continue;
      if (recovery) {
        reconciled += 1;
        continue;
      }
      try {
        await input.persistActivities(owner, context.latestRun, [{ type: "run.error", error }], completedAt);
      } catch (activityError: unknown) {
        console.warn(
          "[chat/orchestrator] Reconciliation activity could not be persisted:",
          activityError instanceof Error ? activityError.name : "UnknownError",
        );
      }
      const finished = await input.repository.finishRun(owner, {
        chatId: context.latestRun.chatId,
        runId: context.latestRun.id,
        outcome: "failed",
        completedAt,
        diagnostic: { stage: "recovery", category: "unknown" },
      });
      if (finished.transitioned) reconciled += 1;
    } catch (reconcileError: unknown) {
      if (!(reconcileError instanceof ChatRunNotActiveError)) throw reconcileError;
    }
  }
  return reconciled;
}
