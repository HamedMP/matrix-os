import type { AiProviderSnapshotV3, AppAiRoute, AppAiRouteSelection, ProviderSettingsSnapshot } from "@matrix-os/contracts";

const ACCOUNT = "owner_codex";
const SOURCE = "owner_openai_profile";

export function isCodexProfileAppRoute(route: AppAiRouteSelection): boolean {
  return route.accessSourceId === SOURCE && route.accountId === ACCOUNT;
}

/** Settings has the live terminal identity and consent while V3 owns model eligibility. */
export function projectCodexProfileAppRoutes(
  settings: ProviderSettingsSnapshot | undefined, canonical: AiProviderSnapshotV3 | undefined, now = new Date(),
): AppAiRoute[] {
  if (settings?.access?.mode !== "writable" || !canonical?.drivers?.some(driver => driver.id === "codex" && driver.installState === "installed")) return [];
  const harnesses = settings.harnesses.filter(row => row.harness === "codex");
  const [harness] = harnesses;
  if (harnesses.length !== 1 || !harness?.enabled || harness.configuredEnabled === false || harness.installState !== "installed"
    || harness.accessSourceId !== SOURCE || harness.selectedAccountId !== ACCOUNT
    || harness.route.kind !== "fixed" || harness.route.providerId !== "openai") return [];
  const account = settings.accounts.find(row => row.id === ACCOUNT && row.providerId === "openai" && row.accessSourceId === SOURCE);
  if (account?.authMethod !== "terminal" || account.authState !== "authenticated") return [];
  const source = settings.accessSources.find(row => row.id === SOURCE);
  if (source?.kind !== "provider_account" || source.fundingKind !== "owner_account" || source.providerId !== "openai"
    || source.accountId !== ACCOUNT || source.readiness.state !== "ready"
    || !source.readiness.checkedAt || !(Date.parse(source.readiness.checkedAt) <= +now)
    || !source.readiness.staleAfter || !(Date.parse(source.readiness.staleAfter) > +now)) return [];
  const inventory = canonical.accessSources.find(row => row.id === SOURCE && row.vendor === "openai" && row.fundingKind === "owner_account");
  const instance = canonical.instances.find(row => row.driverId === "codex" && row.vendor === "openai"
    && row.accessSourceId === SOURCE && row.accountId === ACCOUNT);
  if (!inventory || !instance || !canonical.accounts.some(row => row.id === ACCOUNT && row.vendor === "openai")) return [];
  const models = settings.modelProviders.find(provider => provider.id === "openai")?.models ?? [];
  return models.filter(model => model.enabled && source.eligibleModelIds.includes(model.id)
    && inventory.eligibleModelIds.includes(model.id) && instance.modelIds.includes(model.id)
    && canonical.models.some(row => row.id === model.id && row.vendor === "openai" && row.eligibleAccessSourceIds.includes(SOURCE)
      && row.status !== "unavailable" && row.status !== "retired")).map(model => ({
    harnessId: harness.id, accountId: ACCOUNT, accessSourceId: SOURCE,
    modelId: model.id, displayName: harness.displayName,
    availability: "available", readiness: "local_profile", reason: null,
  }));
}
