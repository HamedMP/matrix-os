import { bedrockModelAliases, type BedrockRouteConfig } from "./funded-bedrock-route.js";
import { createBedrockFundedUpstream } from "./funded-bedrock-upstream.js";
import type { FundedRelayConfig } from "./funded-relay-config.js";
import type { FundedGenerationUpstream } from "./funded-relay-upstream.js";

export function createBedrockRouteRegistry(
  config: Pick<FundedRelayConfig, "bedrockRoute" | "bedrockRoutes">,
  upstreamOverride?: FundedGenerationUpstream,
) {
  const routes = config.bedrockRoutes ?? (config.bedrockRoute ? [config.bedrockRoute] : []);
  const byAlias = new Map<string, { route: BedrockRouteConfig; upstream: FundedGenerationUpstream }>();
  const upstreams = new Set<FundedGenerationUpstream>();
  for (const route of routes) {
    const upstream = upstreamOverride ?? createBedrockFundedUpstream(route);
    const entry = { route, upstream };
    upstreams.add(upstream);
    for (const alias of bedrockModelAliases(route)) byAlias.set(alias, entry);
  }
  return {
    aliases: new Set(byAlias.keys()) as ReadonlySet<string>,
    get: (modelId: string) => byAlias.get(modelId),
    close: () => { for (const upstream of upstreams) upstream.close(); },
  };
}

export type BedrockRouteRegistry = ReturnType<typeof createBedrockRouteRegistry>;
