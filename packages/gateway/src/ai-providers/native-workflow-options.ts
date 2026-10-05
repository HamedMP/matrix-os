import type { ProviderWorkflowConnectionOption, ProviderWorkflowKey, ProviderWorkflowStart } from "@matrix-os/contracts";
/** Explicit trusted registry; provider names discovered from arbitrary runtimes are never verifier URLs. */
export function nativeWorkflowConnectionOptions(input: {
  harness: string;
  methods: NonNullable<ProviderWorkflowStart["method"]>[];
  keyProviders: ProviderWorkflowKey["providerId"][];
}): ProviderWorkflowConnectionOption[] {
  const keys: ProviderWorkflowConnectionOption[] = input.keyProviders.map(providerId => ({
    id: `${providerId}_api_key`, providerId, authKind: "api_key", billingKind: "api_key", executionKind: "native", availability: "available",
  }));
  const providerId = input.harness === "claude" ? "anthropic" : "openai";
  const official = input.harness === "claude" || input.harness === "codex";
  return [...input.methods.map((method): ProviderWorkflowConnectionOption => ({
    id: `${providerId}_${method}`, providerId, authKind: "subscription", method, billingKind: "subscription", executionKind: "native",
    ...(official ? { availability: "available" as const } : { availability: "unavailable" as const, unavailableReason: "provider_access_required" as const }),
  })), ...keys];
}
