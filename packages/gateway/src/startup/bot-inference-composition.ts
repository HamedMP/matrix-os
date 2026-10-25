import { isManagedPiBinding } from "../bots/runtime-registry.js";
import type { BotInferenceDependencies } from "../bots/broker-inference.js";
import type { createBotProcedureResolver } from "../bots/custom-procedure.js";
import type { createManagedPiAdmission } from "../chat/managed-pi-admission.js";
import type { createManagedPiRuntime } from "../chat/managed-pi-runtime.js";

/** Shared actual inference dependencies for managed Chat and recipe Bots. This
 * factory receives private server services, never serialized worker flags. */
export function createBotInferenceComposition(input: {
  options: Pick<BotInferenceDependencies, "homePath" | "matrixOpenAi" | "matrixAnthropic" | "fundedCredentialProvider" | "fundedAdmission" | "chatAnalytics">;
  lifetime: AbortSignal;
  googleData: NonNullable<BotInferenceDependencies["googleData"]>;
  isolatedChat: BotInferenceDependencies["isolatedChat"];
  chatgptPlan: BotInferenceDependencies["chatgptPlan"];
  procedures: Pick<ReturnType<typeof createBotProcedureResolver>, "revalidate">;
  managedAdmission: Pick<ReturnType<typeof createManagedPiAdmission>, "toolAuthority">;
  managed: Pick<ReturnType<typeof createManagedPiRuntime>, "recordFundedFailure">;
}): BotInferenceDependencies {
  const { options } = input;
  return {
    googleData: input.googleData,
    ...(input.isolatedChat ? { isolatedChat: input.isolatedChat } : {}),
    ...(options.matrixOpenAi ? { matrixOpenAi: options.matrixOpenAi } : {}),
    ...(options.matrixAnthropic ? { matrixAnthropic: options.matrixAnthropic } : {}),
    ...(input.chatgptPlan ? { chatgptPlan: input.chatgptPlan } : {}),
    ...(options.chatAnalytics ? { chatAnalytics: options.chatAnalytics } : {}),
    homePath: options.homePath,
    onFundedFailure: (binding, reason) => input.managed.recordFundedFailure(binding, reason),
    revalidateBinding: async binding => {
      if (!isManagedPiBinding(binding)) {
        try { await input.procedures.revalidate(binding); return true; }
        catch (error: unknown) { console.warn("[bots] Custom authority revalidation failed", error instanceof Error ? error.name : "UnknownError"); return false; }
      }
      try { await input.managedAdmission.toolAuthority(binding); return true; }
      catch (error: unknown) { console.warn("[managed-pi] Authority revalidation failed", error instanceof Error ? error.name : "UnknownError"); return false; }
    },
    lifetime: input.lifetime,
    ...(options.fundedCredentialProvider ? { fundedCredentialProvider: options.fundedCredentialProvider } : {}),
    ...(options.fundedAdmission ? { fundedAdmission: options.fundedAdmission } : {}),
  };
}
