import type {
  ProviderAccessSource,
  ProviderAuthenticationState,
  ProviderDependencyCounts,
  ProviderHarnessInstance,
  ProviderSettingsSnapshot,
  ProviderUsage,
} from "@matrix-os/contracts";

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
      primary: `${Math.round(usage.usedBasisPoints / 100)}% used`,
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

export function gatewayCreditLines(source: ProviderAccessSource): { primary: string; secondary: string | null; stale: boolean } {
  if (source.usage.kind !== "managed_credit") {
    return { primary: "Credit unavailable", secondary: source.usage.kind === "unavailable" ? titleCase(source.usage.reason) : null, stale: false };
  }
  return usageLines(source.usage);
}

export function selectedHarness(snapshot: ProviderSettingsSnapshot, id: string | null): ProviderHarnessInstance | null {
  return snapshot.harnesses.find((harness) => harness.id === id) ?? snapshot.harnesses[0] ?? null;
}

export function dependenciesTotal(dependencies: ProviderDependencyCounts): number {
  return dependencies.activeChatCount + dependencies.resumableChatCount + dependencies.harnessInstanceCount;
}
