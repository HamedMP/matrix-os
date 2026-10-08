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
  // App-server subscription authentication is excluded for hosted/commercial
  // services. Stale or injected methods must never advertise a Codex login.
  if (input.harness !== "claude") return keys;
  return [...input.methods.map((method): ProviderWorkflowConnectionOption => ({
    id: `anthropic_${method}`, providerId: "anthropic", authKind: "subscription", method,
    billingKind: "subscription", executionKind: "native", availability: "available",
  })), ...keys];
}
