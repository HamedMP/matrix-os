import type { AgentProviderDescriptor, CanonicalProviderDriverKind, CanonicalModelDescriptor } from "@matrix-os/contracts";

// These provider-owned IDs were verified against the live Hermes execution path.
// Omit them from the selector until the provider reports a usable route again.
const LIVE_PROBED_UNAVAILABLE_SYSTEM_MODELS = new Set([
  "opencode-free:deepseek-v4-flash-free",
  "opencode-free:nemotron-3-ultra-free",
]);

export function systemModels(
  runtime: CanonicalProviderDriverKind,
  providers: AgentProviderDescriptor[],
): CanonicalModelDescriptor[] {
  const groups = providers
    .filter((provider) => provider.runtime === runtime
      && provider.authStatus.state === "ready"
      && provider.authStatus.authenticated)
    .map((provider) => provider.models
      .filter((model) => model.available
        && !model.id.endsWith("-pro")
        && !LIVE_PROBED_UNAVAILABLE_SYSTEM_MODELS.has(`${provider.id}:${model.id}`))
      .map((model) => ({
        id: `${provider.id}:${model.id}`,
        displayName: model.displayName,
        ...(model.description ? { description: model.description } : {}),
        availability: "available" as const,
        capabilities: model.capabilities,
        supportsVision: model.capabilities.includes("vision"),
        supportsToolUse: model.capabilities.includes("tools"),
      })));
  // Allocate the existing wire budget across authenticated providers. A large
  // earlier provider must not erase an independent subscription's inventory.
  const counts = groups.map(() => 0);
  let total = 0;
  for (let position = 0; total < 64; position++) {
    let added = false;
    for (let index = 0; index < groups.length && total < 64; index++) {
      if (groups[index]![position]) {
        counts[index]!++;
        total++;
        added = true;
      }
    }
    if (!added) break;
  }
  return groups.flatMap((group, index) => group.slice(0, counts[index]));
}
