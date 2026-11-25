import type { createScopeRuntimeClient } from "./scope-runtime-client.js";
import type { SharedAiRuntimeRegistry } from "./shared-ai-runtime-registry.js";
import type { SharedRunOwnerSourceDecision } from "./shared-run-owner-source.js";
import type { KernelCredentialAccessSourceId } from "../kernel-credentials.js";

export function createSharedScopedClient(input: {
  client: Pick<ReturnType<typeof createScopeRuntimeClient>, "capability" | "createRuntime" | "runChat" | "stopRuntime">;
  registry: SharedAiRuntimeRegistry;
  scopeId: string;
  chatId: string;
  ownerId: string;
  actorId: string;
  providerIdentity:
    | { driverKind: "claude_code"; instanceId: "claude_shared"; accessSourceId: KernelCredentialAccessSourceId }
    | { driverKind: "codex"; instanceId: "codex_default" };
  ownerRoute?: SharedRunOwnerSourceDecision;
  resolveExecutionModel?: (model: string) => Promise<string | null>;
}) {
  return {
    capability: () => input.client.capability(),
    async createRuntime(request: Parameters<typeof input.client.createRuntime>[0]) {
      const created = await input.client.createRuntime(request);
      try {
        input.registry.bind({
          runtimeHandle: created.runtimeHandle,
          scopeId: input.scopeId,
          chatId: input.chatId,
          ownerId: input.ownerId,
          actorId: input.actorId,
          executionGeneration: created.executionGeneration,
          providerIdentity: input.providerIdentity,
          ...(input.ownerRoute ? { ownerRoute: input.ownerRoute } : {}),
        });
      } catch (error: unknown) {
        await input.client.stopRuntime({ runtimeHandle: created.runtimeHandle }).catch((stopError: unknown) => {
          console.warn("[collaboration] unbound shared runtime cleanup failed",
            stopError instanceof Error ? stopError.name : "UnknownError");
        });
        throw error;
      }
      return created;
    },
    async runChat(request: Parameters<typeof input.client.runChat>[0]) {
      const model = input.resolveExecutionModel ? await input.resolveExecutionModel(request.model) : request.model;
      if (!model) throw new Error("Shared native execution model is unavailable");
      input.registry.selectModel(request.runtimeHandle, model);
      return input.client.runChat({ ...request, model });
    },
    async stopRuntime(request: Parameters<typeof input.client.stopRuntime>[0]) {
      input.registry.release(request.runtimeHandle);
      return input.client.stopRuntime(request);
    },
  };
}
