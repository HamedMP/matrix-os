import type {
  ProviderAccessSource,
  ProviderAccount,
  ProviderAuthenticationState,
  ProviderDependencyCounts,
  ProviderGatewayPolicy,
  ProviderHarnessInstance,
  ProviderSettingsSnapshot,
  ProviderUsage,
} from "@matrix-os/contracts";
import { isManagedCreditTimestampCurrent, MANAGED_CREDIT_MAX_AGE_MS } from "./managed-credit-freshness.js";

export function gatewayPolicyAllowsModel(policy: ProviderGatewayPolicy | null, modelId: string): boolean {
  return policy !== null && policy.allowedModelIds.includes(modelId)
    && (policy.effectiveAllowedModelIds === undefined || policy.effectiveAllowedModelIds.includes(modelId));
}

export function money(microusd: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(microusd / 1_000_000);
}

export function shortDate(value: string | null): string | null {
  if (value === null) return null;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

export function relativeCheckedAt(value: string, now = Date.now()): string {
  const checkedAt = new Date(value).getTime();
  if (!Number.isFinite(checkedAt)) return "at an unknown time";
  const elapsedSeconds = Math.max(0, Math.round((now - checkedAt) / 1_000));
  if (elapsedSeconds < 60) return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-elapsedSeconds, "second");
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-elapsedMinutes, "minute");
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 24) return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-elapsedHours, "hour");
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-Math.round(elapsedHours / 24), "day");
}

const PROVIDER_NAMES: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", "openai-codex": "OpenAI", openrouter: "OpenRouter" };

/** A provider's proper name for owner-facing copy; null for one we do not name. */
export function providerName(providerId: string | null | undefined): string | null {
  return providerId ? PROVIDER_NAMES[providerId] ?? null : null;
}

/** How a connected agent is connected: an API key (billed per request) or the agent's own account. */
export function connectedAccountLabel(harness: string, account?: Pick<ProviderAccount, "authMethod" | "providerId">, source?: Pick<ProviderAccessSource, "fundingKind" | "providerId">): { apiKey: boolean; label: string } {
  const apiKey = account?.authMethod === "api_key" || source?.fundingKind === "owner_api_key";
  const label = apiKey ? "API key"
    : harness === "codex" ? "ChatGPT account"
    : harness === "claude" ? "Claude account" : "Provider account";
  return { apiKey, label };
}

export function titleCase(value: string): string {
  return value.split("_").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
}

export function authLabel(state: ProviderAuthenticationState): string {
  if (state === "authenticated") return "Authenticated";
  if (state === "unauthenticated") return "Not authenticated";
  return titleCase(state);
}

export function usageLines(usage: ProviderUsage): { primary: string; secondary: string | null; stale: boolean } {
  if (usage.kind === "managed_credit") {
    return {
      primary: `${money(usage.remainingMicrousd, usage.currency)} remaining`,
      secondary: `${money(usage.usedMicrousd, usage.currency)} used of ${money(usage.limitMicrousd, usage.currency)}`,
      stale: usage.state === "stale",
    };
  }
  if (usage.kind === "metered_api") {
    const balance = usage.providerBalance === null
      ? null
      : `${money(usage.providerBalance.remainingMicrousd, usage.currency)} provider balance`;
    return {
      primary: `${money(usage.observedUsageMicrousd, usage.currency)} observed`,
      secondary: balance,
      stale: usage.state === "stale" || usage.providerBalance?.state === "stale",
    };
  }
  if (usage.kind === "subscription_allowance") {
    return {
      primary: `${Math.round((10000 - usage.usedBasisPoints) / 100)}% left`,
      secondary: usage.resetsAt === null ? null : `Resets ${shortDate(usage.resetsAt)}`,
      stale: usage.state === "stale",
    };
  }
  return {
    primary: "Usage unavailable",
    secondary: titleCase(usage.reason),
    stale: false,
  };
}

export function gatewayCreditStaleAfter(source: ProviderAccessSource | null): string | null {
  if (source?.usage.kind !== "managed_credit" || source.usage.state !== "current") return null;
  const expiry = new Date(Date.parse(source.usage.asOf) + MANAGED_CREDIT_MAX_AGE_MS);
  return Number.isFinite(expiry.getTime()) ? expiry.toISOString() : null;
}

export function gatewayChatAvailableMicrousd(source: ProviderAccessSource | null, now = Date.now()): number | null {
  if (source?.usage.kind !== "managed_credit") return null;
  const usage = source.usage;
  const projection = usage.chatAvailability;
  if (!projection || projection.asOf !== usage.asOf || usage.state !== "current"
    || !isManagedCreditTimestampCurrent(usage.asOf, now)) return null;
  return Math.min(projection.availableBalanceMicrousd, usage.budget.remainingBudgetMicrousd);
}

export function gatewayCreditLines(source: ProviderAccessSource, now = Date.now()): { primary: string; secondary: string | null; stale: boolean } {
  if (source.usage.kind !== "managed_credit") {
    return { primary: "Chat credit unavailable", secondary: null, stale: false };
  }
  const stale = source.usage.state === "stale" || !isManagedCreditTimestampCurrent(source.usage.asOf, now);
  const balance = gatewayChatAvailableMicrousd(source, now);
  if (balance === null) {
    return { primary: "Chat credit unavailable", secondary: null, stale };
  }
  const display = balance > 0 && balance < 10_000
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: source.usage.currency, minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(balance / 1_000_000)
    : money(balance, source.usage.currency);
  return { primary: display, secondary: null, stale: false };
}

export function selectedHarness(snapshot: ProviderSettingsSnapshot, id: string | null): ProviderHarnessInstance | null {
  return snapshot.harnesses.find((harness) => harness.id === id) ?? snapshot.harnesses[0] ?? null;
}

export function dependenciesTotal(dependencies: ProviderDependencyCounts): number {
  return dependencies.activeChatCount + dependencies.resumableChatCount + dependencies.harnessInstanceCount;
}
