import { createProvider, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import type { BotModelRoute, BotRunEffort } from "@matrix-os/contracts";
import { createBotBridgeFetch } from "./bridge-fetch.js";

/**
 * The worker holds no credential. SDKs require some key, so this placeholder is
 * sent to the private inference bridge and replaced by the gateway broker.
 */
export const BROKER_PLACEHOLDER_KEY = "matrix-broker-placeholder";
export const BROKER_PROVIDER_ID = "matrix-broker";

const API_FACTORIES = {
  "anthropic-messages": anthropicMessagesApi,
  "openai-responses": openAIResponsesApi,
  "openai-completions": openAICompletionsApi,
} as const;

function bridgeBaseUrl(route: BotModelRoute, bridgeOrigin: string): string {
  const origin = bridgeOrigin.replace(/\/$/, "");
  // Anthropic SDK paths already include /v1; the OpenAI SDKs expect it in the base URL.
  return route.api === "anthropic-messages" ? origin : `${origin}/v1`;
}

export function assertLoopbackBridge(bridgeOrigin: string): void {
  const url = new URL(bridgeOrigin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/") {
    throw new Error("Bot inference must use the loopback bridge");
  }
}

/** Anthropic models that think adaptively and take an effort, as pi-ai's own Anthropic catalog marks them. */
function thinksAdaptively(modelId: string): boolean {
  const catalog: Readonly<Record<string, { compat?: { forceAdaptiveThinking?: boolean } }>> = ANTHROPIC_MODELS;
  return Object.hasOwn(catalog, modelId) && catalog[modelId]?.compat?.forceAdaptiveThinking === true;
}

/**
 * The effort a run thinks at, only on Anthropic models that think adaptively. Other routes and other models
 * (Haiku 4.5, Sonnet 4.5, and any model the catalog does not know) ignore it: they refuse adaptive thinking.
 */
export function routeEffort(route: BotModelRoute, effort: BotRunEffort | undefined): BotRunEffort | undefined {
  return route.api === "anthropic-messages" && thinksAdaptively(route.modelId) ? effort : undefined;
}

type PayloadHook = (payload: unknown, model: Model<Api>) => unknown;

/**
 * pi-ai adds `display` to adaptive thinking. The Matrix-funded relay accepts exactly `{type: "adaptive"}` and
 * refuses the request otherwise, so the key is dropped whatever pays for the route. The worker never forwards
 * thinking text, so the model's own default display is fine. Returns undefined when there is nothing to drop.
 */
export function withoutThinkingDisplay(payload: unknown): Record<string, unknown> | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const { thinking } = payload as { thinking?: unknown };
  if (typeof thinking !== "object" || thinking === null || !Object.hasOwn(thinking, "display")) return undefined;
  const { display: _display, ...rest } = thinking as Record<string, unknown>;
  return { ...(payload as Record<string, unknown>), thinking: rest };
}

/** Runs the caller's own payload hook first, then drops the thinking display from whatever it left. */
function relayThinking(next: PayloadHook | undefined): PayloadHook {
  return async (payload, hookModel) => {
    const replaced: unknown = await next?.(payload, hookModel);
    return withoutThinkingDisplay(replaced === undefined ? payload : replaced) ?? replaced;
  };
}

/**
 * With an effort, an adaptive Anthropic model is marked so, and a turn sends exactly
 * `thinking: {type: "adaptive"}` and `output_config: {effort}`. `off` maps to nothing, so a call without a thinking
 * level (the summary) sends no thinking field at all: some models refuse `{type: "disabled"}`.
 */
export function createBridgeModel(route: BotModelRoute, bridgeOrigin: string, bridgeSocket?: string, effort?: BotRunEffort): { provider: Provider<Api>; model: Model<Api> } {
  assertLoopbackBridge(bridgeOrigin);
  const adaptive = routeEffort(route, effort) !== undefined;
  const model: Model<Api> = {
    id: route.modelId,
    name: route.modelId,
    api: route.api,
    provider: BROKER_PROVIDER_ID,
    baseUrl: bridgeBaseUrl(route, bridgeOrigin),
    reasoning: adaptive,
    ...(adaptive ? { compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { off: null } } : {}),
    input: route.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: route.contextWindow,
    maxTokens: route.maxOutputTokens,
  };
  const api = API_FACTORIES[route.api]();
  const bridgeFetch = bridgeSocket ? createBotBridgeFetch(bridgeSocket) : undefined;
  const provider = createProvider<Api>({
    id: BROKER_PROVIDER_ID,
    name: "Matrix broker",
    auth: {
      apiKey: {
        name: "Matrix broker",
        resolve: async () => ({ auth: { apiKey: BROKER_PLACEHOLDER_KEY } }),
      },
    },
    models: [model],
    api: { [route.api]: bridgeFetch || adaptive ? {
      ...api,
      stream: (model, context, options) => api.stream(model, context, {
        ...options,
        ...(bridgeFetch ? { fetch: bridgeFetch } : {}),
        ...(adaptive ? { onPayload: relayThinking(options?.onPayload) } : {}),
      }),
      streamSimple: (model, context, options) => api.streamSimple(model, context, {
        ...options,
        ...(bridgeFetch ? { fetch: bridgeFetch } : {}),
        ...(adaptive ? { onPayload: relayThinking(options?.onPayload) } : {}),
      }),
    } : api },
  });
  return { provider, model };
}
