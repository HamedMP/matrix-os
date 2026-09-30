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
  preferredModelIds: readonly string[] = [],
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
  // Reserve eligible runtime/default Settings selections before sharing the
  // remaining wire budget. Preferences never add an unobserved model.
  const selected = groups.map(() => new Set<number>());
  let total = 0;
  groups.forEach((group, index) => group.forEach((model, position) => {
    if (total < 64 && preferredModelIds.includes(model.id)) {
      selected[index]!.add(position);
      total++;
    }
  }));
  // A large earlier provider must not erase an independent subscription.
  for (let position = 0; total < 64; position++) {
    let hasPosition = false;
    for (let index = 0; index < groups.length && total < 64; index++) {
      if (groups[index]![position]) {
        hasPosition = true;
        if (!selected[index]!.has(position)) {
          selected[index]!.add(position);
          total++;
        }
      }
    }
    if (!hasPosition) break;
  }
  return groups.flatMap((group, index) => group.filter((_, position) => selected[index]!.has(position)));
}
