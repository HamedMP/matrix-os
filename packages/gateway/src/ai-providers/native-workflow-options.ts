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
  // Methods come from the installed, qualified native adapter.
  if (input.harness !== "claude" && input.harness !== "codex") return keys;
  const providerId = input.harness === "codex" ? "openai" : "anthropic";
  const methods = input.harness === "codex" ? input.methods.filter(method => method === "terminal" || method === "device_code") : input.methods;
  return [...methods.map((method): ProviderWorkflowConnectionOption => ({
    id: `${providerId}_${method}`, providerId, authKind: "subscription", method,
    billingKind: "subscription", executionKind: "native", availability: "available",
  })), ...keys];
}
