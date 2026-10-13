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
  // Codex permits only the owner-visible official CLI handoff, never embedded auth.
  if (input.harness !== "claude" && input.harness !== "codex") return keys;
  const providerId = input.harness === "codex" ? "openai" : "anthropic";
  const methods = input.harness === "codex" ? input.methods.filter(method => method === "terminal") : input.methods;
  return [...methods.map((method): ProviderWorkflowConnectionOption => ({
    id: `${providerId}_${method}`, providerId, authKind: "subscription", method,
    billingKind: "subscription", executionKind: "native", availability: "available",
  })), ...keys];
}
