import type { ProviderWorkflowConnectionOption } from "@matrix-os/contracts";
import type { ProviderWorkflowUICapability } from "./types.js";

/** The owner-invoked official CLI option is distinct from embedded authentication. */
export function isCodexTerminalOption(option: ProviderWorkflowConnectionOption | null | undefined): boolean {
  return option?.id === "openai_terminal" && option.providerId === "openai"
    && option.authKind === "subscription" && option.method === "terminal"
    && option.billingKind === "subscription" && option.executionKind === "native"
    && option.availability === "available";
}

/** Exact public app-server device flow, qualified by the current native server. */
export function isCodexDeviceOption(option: ProviderWorkflowConnectionOption | null | undefined): boolean {
  return option?.id === "openai_device_code" && option.providerId === "openai"
    && option.authKind === "subscription" && option.method === "device_code"
    && option.billingKind === "subscription" && option.executionKind === "native"
    && option.availability === "available";
}
export function isCodexNativeLoginOption(option: ProviderWorkflowConnectionOption | null | undefined): boolean {
  return isCodexTerminalOption(option) || isCodexDeviceOption(option);
}

/** Saved accounts and Matrix AI grants cannot advertise native login. */
export function managedConnectionCapability(capability: ProviderWorkflowUICapability): ProviderWorkflowUICapability {
  if (capability.harness === "claude") return capability;
  const installedCodex = capability.harness === "codex" && capability.installState === "installed";
  const terminal = installedCodex && capability.loginMethods.includes("terminal") && capability.connectionOptions?.some(isCodexTerminalOption);
  const device = installedCodex && capability.loginMethods.includes("device_code") && capability.connectionOptions?.some(isCodexDeviceOption);
  return {...capability, loginMethods: [...(device ? ["device_code" as const] : []), ...(terminal ? ["terminal" as const] : [])],
    ...(capability.connectionOptions ? {connectionOptions: capability.connectionOptions.filter(option =>
      option.authKind === "api_key" || (terminal && isCodexTerminalOption(option)) || (device && isCodexDeviceOption(option)))} : {})};
}
