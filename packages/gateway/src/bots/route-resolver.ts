/**
 * Resolves a bot run's model route and access source from the owner's
 * Provider V3 snapshot (spec 536, research R3). The owner's active choice
 * wins when bots can use it; otherwise the first ready access source bots
 * can use, in the order Matrix AI (GLM Flash, the managed default), Matrix
 * AI (Anthropic models), own Anthropic key, with that
 * source's default model. A bot never picks its own model.
 *
 * Anthropic models run on the Messages API. Matrix AI's other models run on
 * its relay as chat completions, launched with the Matrix AI credential.
 * Stale or not-ready sources and retired, tool-less, or ineligible models
 * are never selected.
 */
import type { AiProviderSnapshotV3, BotModelRoute, CanonicalChatModelSelection } from "@matrix-os/contracts";
import {
  BotModelRouteSchema,
  isFundedThirdPartyPreviewModel,
  MANAGED_WORKERS_AI_MODEL_IDS,
  MATRIX_BEDROCK_SOURCE_ID,
  MATRIX_PI_BEDROCK_CONTEXT_WINDOW,
  MATRIX_PI_BEDROCK_GPT_OSS_120B_CONTEXT_WINDOW,
  MATRIX_PI_BEDROCK_GPT_OSS_120B_ID,
  MATRIX_PI_DEFAULT_MAX_OUTPUT_TOKENS,
  isEffectiveBedrockModel,
} from "@matrix-os/contracts";
import type { BotCredentialAccessSourceId } from "./credentials.js";
import { FUNDED_PREVIEW_CHAT_ROUTES, MATRIX_DEFAULT_MODEL_ID } from "../ai-providers/model-catalog.js";

/** Provider V3 access sources bots can use, in fallback order, and the credential each launches with. */
const SOURCES_IN_ORDER: ReadonlyArray<{ id: string; credential: BotCredentialAccessSourceId; anthropicOnly: boolean }> = [
  { id: "matrix_cloudflare", credential: "matrix_included", anthropicOnly: false },
  ...FUNDED_PREVIEW_CHAT_ROUTES.map(({ sourceId }) => ({ id: sourceId, credential: "matrix_included" as const, anthropicOnly: false })),
  { id: "matrix_included", credential: "matrix_included", anthropicOnly: true },
  { id: MATRIX_BEDROCK_SOURCE_ID, credential: "matrix_included", anthropicOnly: false },
  { id: "owner_anthropic_key", credential: "owner_anthropic_key", anthropicOnly: true },
];
const ANTHROPIC_CONTEXT_WINDOW = 200_000;
const OTHER_CONTEXT_WINDOW = 128_000;

export interface ResolvedBotRoute {
  route: BotModelRoute;
  accessSourceId: BotCredentialAccessSourceId;
  subscription?: import("./chatgpt-plan.js").ChatGptPlanBinding;
  anthropicApi?: import("@matrix-os/contracts").MatrixAnthropicBinding;
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
  if (modelId === null || isFundedThirdPartyPreviewModel(modelId)) return undefined;
  const source = snapshot.accessSources.find((candidate) => candidate.id === entry.id);
  if (!source || source.state !== "ready" || !fresh(source.staleAfter, now) || !source.eligibleModelIds.includes(modelId)) return undefined;
  const model = snapshot.models.find((candidate) => candidate.id === modelId);
  if (!model || model.status === "retired" || model.status === "unavailable" || !model.eligibleAccessSourceIds.includes(entry.id)) return undefined;
  if (!model.capabilities.includes("tools")) return undefined;
  const anthropic = model.vendor === "anthropic";
  const bedrock = isEffectiveBedrockModel(snapshot, entry.id, modelId);
  if ((!anthropic && entry.anthropicOnly) || (entry.id === MATRIX_BEDROCK_SOURCE_ID && !bedrock)) return undefined;
  const bedrockContextWindow = modelId === MATRIX_PI_BEDROCK_GPT_OSS_120B_ID
    ? MATRIX_PI_BEDROCK_GPT_OSS_120B_CONTEXT_WINDOW : MATRIX_PI_BEDROCK_CONTEXT_WINDOW;
  const route = BotModelRouteSchema.safeParse({
    api: anthropic && !bedrock ? "anthropic-messages" : "openai-completions",
    modelId,
    // The bounded Bedrock/OpenAI translator currently accepts text only. Do
    // not inherit the native Anthropic descriptor's vision capability until
    // that exact request path can translate and enforce image inputs.
    input: !bedrock && model.capabilities.includes("vision") ? ["text", "image"] : ["text"],
    contextWindow: bedrock ? bedrockContextWindow
      : anthropic ? ANTHROPIC_CONTEXT_WINDOW : OTHER_CONTEXT_WINDOW,
    maxOutputTokens: FUNDED_PREVIEW_CHAT_ROUTES.find(preview => preview.modelId === modelId)?.maxOutputTokens
      ?? MATRIX_PI_DEFAULT_MAX_OUTPUT_TOKENS,
  });
  return route.success ? { route: route.data, accessSourceId: entry.credential } : undefined;
}

export function resolveBotRoute(snapshot: AiProviderSnapshotV3, now = Date.now()): ResolvedBotRoute {
  const activeSource = botSource(snapshot.active.accessSourceId);
  const active = activeSource ? routeFor(snapshot, activeSource, snapshot.active.modelId, now) : undefined;
  if (active) return active;
  for (const entry of SOURCES_IN_ORDER) {
    // Managed Workers models have no kernel instance. Keep Flash first, then
    // consider only reviewed peers passing the same exact route checks.
    if (entry.id === "matrix_cloudflare") {
      for (const modelId of [MATRIX_DEFAULT_MODEL_ID,
        ...MANAGED_WORKERS_AI_MODEL_IDS.filter(id => id !== MATRIX_DEFAULT_MODEL_ID)]) {
        const managed = routeFor(snapshot, entry, modelId, now);
        if (managed) return managed;
      }
    }
    const instances = snapshot.instances.filter((instance) => instance.accessSourceId === entry.id
      && instance.readiness.state === "ready" && fresh(instance.readiness.staleAfter, now));
    for (const instance of instances) {
      const resolved = routeFor(snapshot, entry, instance.defaultModelId, now);
      if (resolved) return resolved;
    }
    if (entry.id === "matrix_included" || entry.id === MATRIX_BEDROCK_SOURCE_ID) {
      for (const modelId of snapshot.upstreamPreference?.effectiveBedrockModelIds ?? []) {
        const canonicalId = modelId.replace(/^anthropic\//, "");
        if (!isEffectiveBedrockModel(snapshot, entry.id, canonicalId)) continue;
        const resolved = routeFor(snapshot, entry, canonicalId, now);
        if (resolved) return resolved;
      }
    }
  }
  throw new BotRouteError("model_unavailable");
}

export const MANAGED_PI_INSTANCE_ID = "matrix_pi_default";

/** A concrete managed choice never falls back to the active provider or owner keys. */
export function resolveManagedPiRoute(snapshot: AiProviderSnapshotV3, selection: CanonicalChatModelSelection, now = Date.now()): ResolvedBotRoute {
  if (selection.instanceId !== MANAGED_PI_INSTANCE_ID || Object.keys(selection.options ?? {}).length) throw new BotRouteError("model_unavailable");
  const candidates = SOURCES_IN_ORDER.filter((source) => source.credential === "matrix_included")
    .flatMap((source) => {
      const route = routeFor(snapshot, source, selection.model, now);
      return route ? [route] : [];
    });
  // Ambiguous routing requires a reviewed descriptor rather than choosing implicitly.
  if (candidates.length !== 1) throw new BotRouteError("model_unavailable");
  return candidates[0]!;
}

/** Resolves exactly a scope's selected source/model; never uses active/default/fallback choices. */
export function resolveBotRouteForAccessSource(snapshot: AiProviderSnapshotV3, accessSourceId: string, modelId: string, now = Date.now()): ResolvedBotRoute {
  const source = botSource(accessSourceId);
  const resolved = source ? routeFor(snapshot, source, modelId, now) : undefined;
  if (!resolved) throw new BotRouteError("model_unavailable");
  return resolved;
}
