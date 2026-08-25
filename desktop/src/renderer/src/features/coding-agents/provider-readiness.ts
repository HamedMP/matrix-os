import type { AgentProviderSummary, RuntimeSummary, SafeSetupAction } from "@matrix-os/contracts";

export type ProviderReadinessAction =
  | { kind: "setup"; action: SafeSetupAction }
  | { kind: "refresh" }
  | null;

export interface ProviderReadinessPresentation {
  state:
    | "loading"
    | "ready"
    | "unconfigured"
    | "missing"
    | "auth_required"
    | "expired"
    | "installing"
    | "unsupported"
    | "unverified";
  blocked: boolean;
  title: string;
  description: string;
  action: ProviderReadinessAction;
}

const OPEN_PROVIDER_SETTINGS_ACTION: SafeSetupAction = {
  id: "provider_settings",
  kind: "open_settings",
  label: "Open provider settings",
};

function sameSetupAction(left: SafeSetupAction, right: SafeSetupAction): boolean {
  if (left.kind !== right.kind || left.id !== right.id || left.label !== right.label) return false;
  return left.kind === "open_settings" ||
    (right.kind === "foreground_terminal" && left.command === right.command);
}

export function providerSupportsSetupAction(
  provider: AgentProviderSummary,
  action: SafeSetupAction,
): boolean {
  return provider.setupActions.some((candidate) => sameSetupAction(candidate, action));
}

export function findProviderForSetupAction(
  providers: AgentProviderSummary[],
  action: SafeSetupAction,
): AgentProviderSummary | undefined {
  return providers.find((provider) => providerSupportsSetupAction(provider, action));
}

function unverifiedProvider(
  displayName?: string,
  recoveryAction?: SafeSetupAction,
): ProviderReadinessPresentation {
  return {
    state: "unverified",
    blocked: true,
    title: displayName
      ? `Matrix could not verify ${displayName}`
      : "Matrix could not verify this provider",
    description: recoveryAction && displayName
      ? `Refresh provider status or connect ${displayName} before sending.`
      : "Refresh provider status before sending.",
    action: recoveryAction
      ? { kind: "setup", action: recoveryAction }
      : { kind: "refresh" },
  };
}

function setupAction(
  setupActions: SafeSetupAction[],
): Extract<ProviderReadinessAction, { kind: "setup" }> {
  return {
    kind: "setup",
    action: setupActions[0] ?? OPEN_PROVIDER_SETTINGS_ACTION,
  };
}

function findAuthenticationAction(
  providerId: string,
  setupActions: SafeSetupAction[],
): SafeSetupAction | undefined {
  const trustedActionIds = new Set([
    `${providerId}_connect`,
    `${providerId}_reconnect`,
  ]);
  return setupActions.find((action) => trustedActionIds.has(action.id));
}

function authenticationAction(
  providerId: string,
  setupActions: SafeSetupAction[],
): Extract<ProviderReadinessAction, { kind: "setup" }> {
  return {
    kind: "setup",
    action: findAuthenticationAction(providerId, setupActions)
      ?? OPEN_PROVIDER_SETTINGS_ACTION,
  };
}

export function deriveProviderReadiness(input: {
  summary: RuntimeSummary | null;
  providerId?: string;
  loading: boolean;
}): ProviderReadinessPresentation {
  if (input.loading) {
    return {
      state: "loading",
      blocked: true,
      title: "Checking coding agent provider",
      description: "Matrix is verifying the selected provider.",
      action: null,
    };
  }
  if (!input.summary) return unverifiedProvider();
  if (!input.providerId || input.summary.providers.length === 0) {
    return {
      state: "unconfigured",
      blocked: true,
      title: "No coding agent provider is configured",
      description: "Open provider settings to choose a coding agent provider.",
      action: { kind: "setup", action: OPEN_PROVIDER_SETTINGS_ACTION },
    };
  }

  const provider = input.summary.providers.find((candidate) => candidate.id === input.providerId);
  if (!provider) return unverifiedProvider();

  if (
    provider.availability === "available" &&
    provider.installStatus === "installed" &&
    provider.authStatus === "authenticated"
  ) {
    return {
      state: "ready",
      blocked: false,
      title: "",
      description: "",
      action: null,
    };
  }
  if (provider.availability === "installing" || provider.installStatus === "installing") {
    return {
      state: "installing",
      blocked: true,
      title: `Installing ${provider.displayName}`,
      description: "Refresh provider status after installation finishes.",
      action: { kind: "refresh" },
    };
  }
  if (provider.authStatus === "expired") {
    return {
      state: "expired",
      blocked: true,
      title: `${provider.displayName} needs to be reconnected`,
      description: `Reconnect ${provider.displayName} before sending a message.`,
      action: authenticationAction(provider.id, provider.setupActions),
    };
  }
  if (provider.availability === "auth_required") {
    return {
      state: "auth_required",
      blocked: true,
      title: `Connect ${provider.displayName} to continue`,
      description: `Sign in to ${provider.displayName} before sending a message.`,
      action: authenticationAction(provider.id, provider.setupActions),
    };
  }
  if (provider.availability === "setup_required" || provider.installStatus === "missing") {
    return {
      state: "missing",
      blocked: true,
      title: `${provider.displayName} is not installed`,
      description: `Install ${provider.displayName} before sending a message.`,
      action: setupAction(provider.setupActions),
    };
  }
  if (provider.installStatus === "failed") {
    return {
      state: "unsupported",
      blocked: true,
      title: `Update ${provider.displayName} to a supported version`,
      description: `Open setup to install a supported ${provider.displayName} version.`,
      action: setupAction(provider.setupActions),
    };
  }
  return unverifiedProvider(
    provider.displayName,
    findAuthenticationAction(provider.id, provider.setupActions),
  );
}
