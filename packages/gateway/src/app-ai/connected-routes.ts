import { isLocallyObservedNativeHarnessRoute, isNativeGenericHarnessCredentialRoute, isRunnableGenericHarnessCredentialRoute, type AiProviderSnapshotV3, type ProviderSettingsSnapshot, type ProviderHarnessInstance, } from "@matrix-os/contracts";
import { AppAiRoutesSchema, type AppAiRoute, type AppAiRoutes, type AppAiRouteSelection } from "@matrix-os/contracts";
const fresh = (value: string | null | undefined, now: Date) => value == null || Date.parse(value) > now.getTime();
export function sameAppAiRoute(a: AppAiRouteSelection, b: AppAiRouteSelection): boolean {
    return a.harnessId === b.harnessId && a.accountId === b.accountId && a.accessSourceId === b.accessSourceId && a.modelId === b.modelId;
}
export function routeSelection(route: AppAiRouteSelection): AppAiRouteSelection {
    return { harnessId: route.harnessId, accountId: route.accountId, accessSourceId: route.accessSourceId, modelId: route.modelId };
}
/** Settings contributes owner enablement, with exact canonical V3 lineage. No credentials are projected. */
export function projectAppAiAuthorizationRoutes(settings: ProviderSettingsSnapshot | undefined, canonical: AiProviderSnapshotV3 | undefined, now = new Date()): {routes:AppAiRoute[];defaultRoute:null} {
    // The authoritative snapshots cap128 harnesses x256 models plus16x128 managed routes.
    if ((settings?.harnesses.length ?? 0)>128 || (settings?.accessSources.some(source=>source.eligibleModelIds.length>256) ?? false)
        || (canonical?.accessSources.length ?? 0)>16 || (canonical?.models.length ?? 0)>128) throw new Error("App AI catalog unavailable");
    const routes: AppAiRoute[] = [];
    for (const storedHarness of settings?.harnesses ?? []) {
        const sourceForHarness = settings!.accessSources.find(entry => entry.id === storedHarness.accessSourceId);
        const modelIds = [...new Set([storedHarness.route.modelId, ...(sourceForHarness?.eligibleModelIds ?? [])])];
        for (const modelId of modelIds) {
            const harness = { ...storedHarness, route: { ...storedHarness.route, modelId } };
            const source = settings!.accessSources.find(entry => entry.id === harness.accessSourceId);
            if (!source)
                continue;
            const model = settings!.modelProviders.find(entry => entry.id === harness.route.providerId)?.models.find(entry => entry.id === harness.route.modelId && entry.enabled);
            const account = harness.selectedAccountId === null ? undefined : settings!.accounts.find(entry => entry.id === harness.selectedAccountId);
            const profile = harness.harness === "claude" && source.id === "owner_claude_profile"
                && account?.authState === "authenticated" && account.authMethod === "terminal" && account.connectionDetails?.email
                && account.lastCheckedAt !== null && Date.parse(account.lastCheckedAt) <= now.getTime()
                && now.getTime() - Date.parse(account.lastCheckedAt) < 30000
                && canonical?.instances.some(entry => entry.driverId === "claude_code" && entry.accountId === account.id && entry.accessSourceId === source.id && entry.modelIds.includes(harness.route.modelId));
            const local = Boolean(profile) || isLocallyObservedNativeHarnessRoute(harness, source, now);
            const generic = harness.harness === "pi" || harness.harness === "opencode";
            const supported = generic && isRunnableGenericHarnessCredentialRoute(harness, source)
                || harness.harness === "hermes" && isNativeGenericHarnessCredentialRoute(harness,source) && ["anthropic","openai-api","openai-codex","openrouter"].includes(harness.route.providerId)
                || harness.harness === "claude" && (source.id === "owner_anthropic_key" || source.id === "owner_claude_profile");
            const sourceAccount = source.kind === "provider_account" ? source.accountId : null;
            const matching = harness.selectedAccountId === sourceAccount
                && (sourceAccount === null || account?.accessSourceId === source.id && account.authState === "authenticated");
            const enabled = harness.enabled || Boolean(profile) && harness.configuredEnabled === true;
            const ready = enabled && harness.installState === "installed" && matching && model !== undefined
                && source.eligibleModelIds.includes(harness.route.modelId) && fresh(source.readiness.staleAfter, now)
                && (local || source.readiness.state === "ready" && harness.authState === "authenticated" && harness.connectivity === "online");
            routes.push({ harnessId: harness.id, accountId: harness.selectedAccountId, accessSourceId: source.id, modelId: harness.route.modelId,
                displayName: harness.displayName, availability: supported && ready ? "available" : "unavailable",
                readiness: supported && ready ? local ? "local_profile" : "ready" : "unavailable",
                reason: !enabled ? "disabled" : !supported ? "completion_unavailable" : !ready ? "not_ready" : null });
        }
    }
    // Managed inference is an owned text-only HTTP path. V3 source/model policy and
    // freshness are mandatory even though no native CLI installation is needed.
    for (const source of canonical?.accessSources ?? []) {
        if (source.id !== "matrix_cloudflare" && source.id !== "matrix_included")
            continue;
        for (const model of canonical!.models) {
            if (!source.eligibleModelIds.includes(model.id) || !model.eligibleAccessSourceIds.includes(source.id)
                || model.status === "retired" || model.status === "unavailable")
                continue;
            const ready = source.state === "ready" && source.checkedAt !== null && source.staleAfter !== null
                && Date.parse(source.checkedAt) <= now.getTime() && fresh(source.staleAfter, now);
            routes.push({ harnessId: "matrix_ai", accountId: null, accessSourceId: source.id, modelId: model.id, displayName: "Matrix AI",
                availability: ready ? "available" : "unavailable", readiness: ready ? "ready" : "unavailable", reason: ready ? null : "not_ready" });
        }
    }
    return { routes, defaultRoute: null };
}
export function projectAppAiRoutes(settings: ProviderSettingsSnapshot | undefined, canonical: AiProviderSnapshotV3 | undefined, now = new Date()): AppAiRoutes {
    const catalog=projectAppAiAuthorizationRoutes(settings,canonical,now);
    return AppAiRoutesSchema.parse({...catalog,routes:catalog.routes.slice(0,128)});
}
export function appAiHarness(settings: ProviderSettingsSnapshot, route: AppAiRouteSelection): ProviderHarnessInstance {
    const harness = settings.harnesses.find(entry => entry.id === route.harnessId && entry.selectedAccountId === route.accountId && entry.accessSourceId === route.accessSourceId);
    const source = settings.accessSources.find(entry => entry.id === route.accessSourceId);
    const model = harness && settings.modelProviders.find(entry => entry.id === harness.route.providerId)?.models.find(entry => entry.id === route.modelId && entry.enabled);
    if (!harness || !model || !source?.eligibleModelIds.includes(route.modelId))
        throw new Error("App AI route is unavailable");
    return { ...harness, route: { ...harness.route, modelId: route.modelId } };
}
