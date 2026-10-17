import type { ProviderWorkflowConnectionOption } from "@matrix-os/contracts";
import type { ProviderWorkflowUICapability } from "./types.js";

/** The owner-invoked official CLI option is distinct from embedded authentication. */
export function isCodexTerminalOption(option: ProviderWorkflowConnectionOption | null | undefined): boolean {
  return option?.id === "openai_terminal" && option.providerId === "openai"
    && option.authKind === "subscription" && option.method === "terminal"
    && option.billingKind === "subscription" && option.executionKind === "native"
    && option.availability === "available";
}

/** Legacy methods, saved accounts and Matrix AI grants cannot advertise native login. */
export function managedConnectionCapability(capability: ProviderWorkflowUICapability): ProviderWorkflowUICapability {
  if (capability.harness === "claude") return capability;
  const terminal = capability.harness === "codex" && capability.installState === "installed"
    && capability.loginMethods.includes("terminal") && capability.connectionOptions?.some(isCodexTerminalOption);
  return {...capability, loginMethods: terminal ? ["terminal"] : [],
    ...(capability.connectionOptions ? {connectionOptions: capability.connectionOptions.filter(option =>
      option.authKind === "api_key" || (terminal && isCodexTerminalOption(option)))} : {})};
}
