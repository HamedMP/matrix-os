import type { ProviderWorkflowUICapability } from "./types.js";

/** A stale/legacy advertisement cannot re-enable restricted managed subscription login. */
export function managedConnectionCapability(capability: ProviderWorkflowUICapability): ProviderWorkflowUICapability {
  if (capability.harness === "claude") return capability;
  return {...capability, loginMethods: [],
    ...(capability.connectionOptions ? {connectionOptions: capability.connectionOptions.filter(option => option.authKind === "api_key")} : {})};
}
