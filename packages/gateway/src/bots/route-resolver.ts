/**
 * Resolves a bot run's model route and access source from the owner's
 * Provider V3 snapshot (spec 536, research R3). The owner's active choice
 * wins when bots can use it; otherwise the first ready access source bots
 * can use, in the order Matrix AI, own Anthropic key, own Anthropic profile,
 * with that source's default model. A bot never picks its own model.
 *
 * Anthropic models run on the Messages API with any of those sources.
 * Other vendors' models run only on Matrix AI, whose relay serves them as
 * chat completions. Stale or not-ready sources and retired or ineligible
 * models are never selected.
 */
import type { AiProviderSnapshotV3, BotModelRoute } from "@matrix-os/contracts";
import { BotModelRouteSchema } from "@matrix-os/contracts";
import type { KernelCredentialAccessSourceId } from "../kernel-credentials.js";

const SOURCES_IN_ORDER: readonly KernelCredentialAccessSourceId[] = ["matrix_included", "owner_anthropic_key", "owner_anthropic_profile"];
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const ANTHROPIC_CONTEXT_WINDOW = 200_000;
const OTHER_CONTEXT_WINDOW = 128_000;

export interface ResolvedBotRoute {
  route: BotModelRoute;
  accessSourceId: KernelCredentialAccessSourceId;
}

export class BotRouteError extends Error {
  constructor(readonly code: "model_unavailable") {
    super(code);
    this.name = "BotRouteError";
  }
}

function botSource(id: string | null): KernelCredentialAccessSourceId | undefined {
  return SOURCES_IN_ORDER.find((source) => source === id);
}

function fresh(staleAfter: string | null, now: number): boolean {
  return staleAfter === null || Date.parse(staleAfter) > now;
}

function routeFor(snapshot: AiProviderSnapshotV3, sourceId: KernelCredentialAccessSourceId, modelId: string | null, now: number): ResolvedBotRoute | undefined {
  if (modelId === null) return undefined;
  const source = snapshot.accessSources.find((entry) => entry.id === sourceId);
  if (!source || source.state !== "ready" || !fresh(source.staleAfter, now) || !source.eligibleModelIds.includes(modelId)) return undefined;
  const model = snapshot.models.find((entry) => entry.id === modelId);
  if (!model || model.status === "retired" || model.status === "unavailable" || !model.eligibleAccessSourceIds.includes(sourceId)) return undefined;
  if (!model.capabilities.includes("tools")) return undefined;
  const anthropic = model.vendor === "anthropic";
  if (!anthropic && sourceId !== "matrix_included") return undefined;
  const route = BotModelRouteSchema.safeParse({
    api: anthropic ? "anthropic-messages" : "openai-completions",
    modelId,
    input: model.capabilities.includes("vision") ? ["text", "image"] : ["text"],
    contextWindow: anthropic ? ANTHROPIC_CONTEXT_WINDOW : OTHER_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });
  return route.success ? { route: route.data, accessSourceId: sourceId } : undefined;
}

export function resolveBotRoute(snapshot: AiProviderSnapshotV3, now = Date.now()): ResolvedBotRoute {
  const activeSource = botSource(snapshot.active.accessSourceId);
  const active = activeSource ? routeFor(snapshot, activeSource, snapshot.active.modelId, now) : undefined;
  if (active) return active;
  for (const sourceId of SOURCES_IN_ORDER) {
    const instances = snapshot.instances.filter((instance) => instance.accessSourceId === sourceId
      && instance.readiness.state === "ready" && fresh(instance.readiness.staleAfter, now));
    for (const instance of instances) {
      const resolved = routeFor(snapshot, sourceId, instance.defaultModelId, now);
      if (resolved) return resolved;
    }
  }
  throw new BotRouteError("model_unavailable");
}
