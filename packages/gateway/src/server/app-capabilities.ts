import type { Hono } from "hono";
import { createAppCapabilityRoutes } from "../app-capabilities/routes.js";
import { createRuntimeAppAiRoutes, isAppAiAllowed } from "../app-ai/runtime.js";
import { createPiSdkAppCompletion } from "../app-ai/pi-sdk-completion.js";
import { createHermesAppCompletion } from "../app-ai/hermes-completion.js";
import { createBotIntegrationClient, type BotIntegrationTransport } from "../bots/integration-client.js";
import { requireRequestPrincipal } from "../request-principal.js";
import { createAppAiLifecycle } from "./app-ai-lifecycle.js";

type RuntimeOptions = Parameters<typeof createRuntimeAppAiRoutes>[0];
type SubscriptionSource = NonNullable<RuntimeOptions["chatGptPlanSource"]>;

export function createAppAiSubscriptionObservation(source: SubscriptionSource) {
  return async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const selection = source();
    return selection?.authority.observe(selection.ownerId);
  };
}

export function registerAppIntegrationCapabilities(app: Hono, options: {
  homePath: string;
  ownerIds: readonly string[];
  integrationTransport: BotIntegrationTransport | null;
}): void {
  app.route("/api/bridge/capabilities", createAppCapabilityRoutes({
    homePath: options.homePath,
    ownerIds: options.ownerIds,
    resolveOwner: context => requireRequestPrincipal(context).userId,
    integrations: options.integrationTransport ? createBotIntegrationClient(options.integrationTransport) : null,
    aiAllowed: identity => isAppAiAllowed(options.homePath, identity),
  }));
}

/** Shared request lifetime drains all paths, including non-native completions. */
export function registerAppAiCapabilities(app: Hono, options:
  Omit<RuntimeOptions, "piSdkCompletion" | "hermesCompletion" | "lifecycle"> & {
    hermesRuntimeSource: Parameters<typeof createHermesAppCompletion>[0]["runtimeSource"];
  }) {
  const { hermesRuntimeSource, ...runtimeOptions } = options;
  const lifecycle = createAppAiLifecycle();
  const pi = createPiSdkAppCompletion({ homePath: options.homePath });
  const hermes = createHermesAppCompletion({ homePath: options.homePath, runtimeSource: hermesRuntimeSource });
  app.route("/api/bridge/ai", createRuntimeAppAiRoutes({
    ...runtimeOptions, lifecycle, piSdkCompletion: pi, hermesCompletion: hermes,
    // The paired adapter races caller cancellation. Retain the authority's
    // underlying work too, until real completion/cancellation settles.
    chatGptPlanSource: options.chatGptPlanSource ? () => {
      const source = options.chatGptPlanSource!();
      if (!source) return undefined;
      const authority = source.authority;
      return { ownerId: source.ownerId, authority: {
        observe: owner => lifecycle.track(() => authority.observe(owner)),
        resolve: (selection, owner, requestClass) => lifecycle.track(() => authority.resolve(selection, owner, requestClass)),
        revalidate: (binding, signal) => lifecycle.track(() => authority.revalidate(binding, signal)),
        infer: (binding, body, signal) => lifecycle.track(() => authority.infer(binding, body, signal)),
      } };
    } : undefined,
  }));
  return {
    async close(): Promise<void> {
      // Start every abort before awaiting any adapter. A failure must not skip
      // another drain; never interpret an exhausted grace window as completion.
      const results = await Promise.allSettled([lifecycle.close(), pi.close(), hermes.close()]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    },
  };
}

/** Adapter failures retain their own safety fences without stopping gateway cleanup. */
export async function closeAppAiCapabilities(
  runtime: { close(): Promise<void> },
  onError: (error: unknown) => void,
): Promise<void> {
  try { await runtime.close(); }
  catch (error: unknown) { onError(error); }
}
