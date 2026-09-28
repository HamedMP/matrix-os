import { createProvider, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { BotModelRoute } from "@matrix-os/contracts";

/**
 * The worker holds no credential. SDKs require some key, so this placeholder is
 * sent to the loopback inference bridge and replaced by the gateway broker.
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

export function createBridgeModel(route: BotModelRoute, bridgeOrigin: string): { provider: Provider<Api>; model: Model<Api> } {
  assertLoopbackBridge(bridgeOrigin);
  const model: Model<Api> = {
    id: route.modelId,
    name: route.modelId,
    api: route.api,
    provider: BROKER_PROVIDER_ID,
    baseUrl: bridgeBaseUrl(route, bridgeOrigin),
    reasoning: false,
    input: route.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: route.contextWindow,
    maxTokens: route.maxOutputTokens,
  };
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
    api: { [route.api]: API_FACTORIES[route.api]() },
  });
  return { provider, model };
}
