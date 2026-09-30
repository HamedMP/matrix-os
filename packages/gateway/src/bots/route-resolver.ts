/**
 * Resolves a bot run's model route and access source from the owner's
 * Provider V3 snapshot (spec 536, research R3). The owner's active choice
 * wins when bots can use it; otherwise the first ready access source bots
 * can use, in the order Matrix AI (GLM Flash, the managed default), Matrix
 * AI (Anthropic models), own Anthropic key, own Anthropic profile, with that
 * source's default model. A bot never picks its own model.
 *
 * Anthropic models run on the Messages API. Matrix AI's other models run on
 * its relay as chat completions, launched with the Matrix AI credential.
 * Stale or not-ready sources and retired, tool-less, or ineligible models
 * are never selected.
 */
import type { AiProviderSnapshotV3, BotModelRoute } from "@matrix-os/contracts";
import { BotModelRouteSchema } from "@matrix-os/contracts";
import type { BotCredentialAccessSourceId } from "./credentials.js";
import { MATRIX_DEFAULT_MODEL_ID } from "../ai-providers/model-catalog.js";

/** Provider V3 access sources bots can use, in fallback order, and the credential each launches with. */
const SOURCES_IN_ORDER: ReadonlyArray<{ id: string; credential: BotCredentialAccessSourceId; anthropicOnly: boolean }> = [
  { id: "matrix_cloudflare", credential: "matrix_included", anthropicOnly: false },
  { id: "matrix_included", credential: "matrix_included", anthropicOnly: true },
  { id: "owner_anthropic_key", credential: "owner_anthropic_key", anthropicOnly: true },
  { id: "owner_anthropic_profile", credential: "owner_anthropic_profile", anthropicOnly: true },
];
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const ANTHROPIC_CONTEXT_WINDOW = 200_000;
const OTHER_CONTEXT_WINDOW = 128_000;

export interface ResolvedBotRoute {
  route: BotModelRoute;
  accessSourceId: BotCredentialAccessSourceId;
}

export class BotRouteError extends Error {
  constructor(readonly code: "model_unavailable") {
    super(code);
    this.name = "BotRouteError";
  }
}

function botSource(id: string | null) {
  return SOURCES_IN_ORDER.find((source) => source.id === id);
}

function fresh(staleAfter: string | null, now: number): boolean {
  return staleAfter === null || Date.parse(staleAfter) > now;
}

function routeFor(snapshot: AiProviderSnapshotV3, entry: (typeof SOURCES_IN_ORDER)[number], modelId: string | null, now: number): ResolvedBotRoute | undefined {
  if (modelId === null) return undefined;
  const source = snapshot.accessSources.find((candidate) => candidate.id === entry.id);
  if (!source || source.state !== "ready" || !fresh(source.staleAfter, now) || !source.eligibleModelIds.includes(modelId)) return undefined;
  const model = snapshot.models.find((candidate) => candidate.id === modelId);
  if (!model || model.status === "retired" || model.status === "unavailable" || !model.eligibleAccessSourceIds.includes(entry.id)) return undefined;
  if (!model.capabilities.includes("tools")) return undefined;
  const anthropic = model.vendor === "anthropic";
  if (!anthropic && entry.anthropicOnly) return undefined;
  const route = BotModelRouteSchema.safeParse({
    api: anthropic ? "anthropic-messages" : "openai-completions",
    modelId,
    input: model.capabilities.includes("vision") ? ["text", "image"] : ["text"],
    contextWindow: anthropic ? ANTHROPIC_CONTEXT_WINDOW : OTHER_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });
  return route.success ? { route: route.data, accessSourceId: entry.credential } : undefined;
}

export function resolveBotRoute(snapshot: AiProviderSnapshotV3, now = Date.now()): ResolvedBotRoute {
  const activeSource = botSource(snapshot.active.accessSourceId);
  const active = activeSource ? routeFor(snapshot, activeSource, snapshot.active.modelId, now) : undefined;
  if (active) return active;
  for (const entry of SOURCES_IN_ORDER) {
    // Provider V3 exposes managed GLM as an access source, without an
    // Anthropic kernel instance. Pi can use that source directly, subject
    // to the same readiness, freshness, eligibility and tool checks.
    if (entry.id === "matrix_cloudflare") {
      const managed = routeFor(snapshot, entry, MATRIX_DEFAULT_MODEL_ID, now);
      if (managed) return managed;
    }
    const instances = snapshot.instances.filter((instance) => instance.accessSourceId === entry.id
      && instance.readiness.state === "ready" && fresh(instance.readiness.staleAfter, now));
    for (const instance of instances) {
      const resolved = routeFor(snapshot, entry, instance.defaultModelId, now);
      if (resolved) return resolved;
    }
  }
  throw new BotRouteError("model_unavailable");
}


/** Resolves exactly a scope's selected source/model; never uses active/default/fallback choices. */
export function resolveBotRouteForAccessSource(snapshot: AiProviderSnapshotV3, accessSourceId: string, modelId: string, now = Date.now()): ResolvedBotRoute {
  const source = botSource(accessSourceId);
  const resolved = source ? routeFor(snapshot, source, modelId, now) : undefined;
  if (!resolved) throw new BotRouteError("model_unavailable");
  return resolved;
}
