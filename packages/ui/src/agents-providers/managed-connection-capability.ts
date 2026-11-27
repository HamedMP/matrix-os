import type { ProviderWorkflowConnectionOption } from "@matrix-os/contracts";
import type { ProviderWorkflowUICapability } from "./types.js";

type CodexLoginMethod = "terminal" | "device_code" | "existing_codex";

function isCodexLoginOption(option: ProviderWorkflowConnectionOption | null | undefined, method: CodexLoginMethod): boolean {
  return option?.id === `openai_${method}` && option.providerId === "openai"
    && option.authKind === "subscription" && option.method === method
    && option.billingKind === "subscription" && option.executionKind === "native"
    && option.availability === "available";
}

/** The owner-invoked official CLI option is distinct from embedded authentication. */
export function isCodexTerminalOption(option: ProviderWorkflowConnectionOption | null | undefined): boolean {
  return isCodexLoginOption(option, "terminal");
}

/** Exact public app-server device flow, qualified by the current native server. */
export function isCodexDeviceOption(option: ProviderWorkflowConnectionOption | null | undefined): boolean {
  return isCodexLoginOption(option, "device_code");
}

export function isCodexExistingAccountOption(option: ProviderWorkflowConnectionOption | null | undefined): boolean {
  return isCodexLoginOption(option, "existing_codex");
}

export function isCodexNativeLoginOption(option: ProviderWorkflowConnectionOption | null | undefined): boolean {
  return isCodexTerminalOption(option) || isCodexDeviceOption(option) || isCodexExistingAccountOption(option);
}

export function isHermesTerminalOption(option: ProviderWorkflowConnectionOption | null | undefined): boolean {
  return !!option && ["openai", "anthropic"].includes(option.providerId) && option.id === `${option.providerId}_terminal`
    && option.authKind === "subscription" && option.method === "terminal" && option.billingKind === "subscription"
    && option.executionKind === "native" && option.availability === "available";
}

/** Saved accounts and Matrix AI grants cannot advertise native login. */
export function managedConnectionCapability(capability: ProviderWorkflowUICapability): ProviderWorkflowUICapability {
  if (capability.harness === "claude") return capability;
  if (capability.harness === "hermes") {
    const terminal = capability.installState === "installed" && capability.loginMethods.includes("terminal");
    const options = capability.connectionOptions?.filter(option => option.authKind === "api_key" || terminal && isHermesTerminalOption(option));
    return {...capability, loginMethods: options?.some(option => option.authKind === "subscription") ? ["terminal"] : [],
      ...(options ? {connectionOptions: options} : {})};
  }
  const methods: readonly CodexLoginMethod[] = ["existing_codex", "device_code", "terminal"];
  const options = capability.connectionOptions;
  const loginMethods = capability.harness === "codex" && capability.installState === "installed"
    ? methods.filter(method => capability.loginMethods.includes(method) && options?.some(option => isCodexLoginOption(option, method)))
    : [];
  return { ...capability, loginMethods,
    ...(options ? { connectionOptions: options.filter(option =>
      option.authKind === "api_key" || loginMethods.some(method => isCodexLoginOption(option, method))) } : {}) };
}
