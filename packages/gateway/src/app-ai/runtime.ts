import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { generateAppText } from "@matrix-os/kernel";
import type { AiProviderSnapshotV3, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AppAiRequestSchema, AppAiRouteSelectionSchema, type AppAiRequest, type AppAiRoutes, type AppAiRouteSelection } from "@matrix-os/contracts";
import { buildKernelCredentialLaunch, resolveKernelCredentialSources } from "../kernel-credentials.js";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import type { FundedAdmissionQueue } from "../funded-ai/admission-queue.js";
import { requireRequestPrincipal } from "../request-principal.js";
import { MATRIX_INCLUDED_MODEL_IDS } from "../ai-providers/model-catalog.js";
import { KernelModelSchema } from "../kernel-settings.js";
import { readBoundedJsonFileWithIdentity } from "../bounded-json-file.js";
import { createAppAiRoutes } from "./routes.js";
import { appAiHarness, projectAppAiAuthorizationRoutes, routeSelection, sameAppAiRoute } from "./connected-routes.js";
import type { NativeProviderProfileGuard } from "../ai-providers/native-provider-profile-guard.js";
import { readSavedProviderSettingsConfiguration } from "../ai-providers/provider-settings-persistence.js";
import { generateClaudeProfileAppText } from "./claude-profile-completion.js";
import { generateApiAppText } from "./api-completion.js";
import type { createHermesAppCompletion } from "./hermes-completion.js";
import type { createPiSdkAppCompletion } from "./pi-sdk-completion.js";
import type { ChatGptPlanAuthority } from "../bots/chatgpt-plan.js";
import { CHATGPT_PLAN_SOURCE, projectChatGptPlanAppRoutes } from "./chatgpt-plan-projection.js";
import { generateChatGptPlanAppText } from "./chatgpt-plan-completion.js";
import type { ProviderSnapshotReadOptions } from "../ai-providers/snapshot-read-options.js";
const PolicySchema = z.strictObject({
    apps: z.array(AppAiRequestSchema.shape.app).max(100),
    model: KernelModelSchema.optional(),
    route: AppAiRouteSelectionSchema.optional(),
});
async function readPolicy(homePath: string) {
    const path = join(homePath, "system/app-ai.json");
    try {
        await lstat(path);
    }
    catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT")
            return null;
        throw error;
    }
    const document = await readBoundedJsonFileWithIdentity(join(homePath, "system/app-ai.json"), 32768);
    if (document === null)
        throw new Error("Invalid app AI policy");
    return PolicySchema.parse(document.value);
}
export async function isAppAiAllowed(homePath: string, app: string): Promise<boolean> {
    return (await readPolicy(homePath))?.apps.includes(app) ?? false;
}
interface RuntimeOptions {
    lifecycle?: NonNullable<Parameters<typeof createAppAiRoutes>[0]>['lifecycle'];
    homePath: string;
    ownerIds: readonly string[];
    fundedCredentialProvider?: MatrixFundedCredentialProvider;
    fundedAdmission?: FundedAdmissionQueue;
    providerSnapshotReader?: {
        getSnapshot(options?:ProviderSnapshotReadOptions): Promise<AiProviderSnapshotV3>;
    };
    providerSettingsReader?: {
        getSnapshot(options?:ProviderSnapshotReadOptions): Promise<ProviderSettingsSnapshot>;
    };
    fetchImpl?: typeof fetch;
    nativeProfileGuard?: NativeProviderProfileGuard;
    piSdkCompletion?: ReturnType<typeof createPiSdkAppCompletion>;
    hermesCompletion?: ReturnType<typeof createHermesAppCompletion>;
    chatGptPlanSource?: () => { ownerId: string; authority: ChatGptPlanAuthority } | undefined;
}
/** Owner app grant + exact live V3-derived route, rechecked after credentials/queue waits. */
export function createRuntimeAppAiRoutes(options: RuntimeOptions) {
    async function catalog(app: string, signal: AbortSignal) {
        signal.throwIfAborted();
        const policy = await readPolicy(options.homePath);
        if (!policy?.apps.includes(app))
            throw new Error("App AI access denied");
        if (policy.model && !policy.route) return {settings:undefined,canonical:undefined,policy,routes:{routes:[],defaultRoute:null},allRoutes:[],sdkRoutes:[] as AppAiRouteSelection[]};
        let [settings, canonical] = await Promise.all([
            options.providerSettingsReader?.getSnapshot({includeNativeAccountMetadata:true,includeNativeAccountUsage:false,signal}), options.providerSnapshotReader?.getSnapshot({signal}),
        ]);
        signal.throwIfAborted();
        const routes = projectAppAiAuthorizationRoutes(settings, canonical);
        const planSource = options.chatGptPlanSource?.();
        if (canonical?.instances?.some(instance=>instance.id===CHATGPT_PLAN_SOURCE)) routes.routes.push(...projectChatGptPlanAppRoutes(canonical, Boolean(planSource && options.ownerIds.includes(planSource.ownerId))));
        const managedReadiness=routes.routes.filter(entry=>entry.harnessId==="matrix_ai");
        if (policy.route) routes.routes = routes.routes.filter(entry=>sameAppAiRoute(entry,policy.route!));
        const hermesChecks: Array<{providerId:string;accessSourceId:string;modelId:string;available:boolean}> = [];
        const sdkRoutes: AppAiRouteSelection[] = [];
        const sdkChecks: Array<{providerId:string;models:string[]}> = [];
        for (const route of routes.routes) {
            if (route.availability !== "available")
                continue;
            if (route.accessSourceId === CHATGPT_PLAN_SOURCE) continue;
            if (route.accessSourceId === "matrix_cloudflare" || route.accessSourceId === "matrix_included") {
                if (!options.fundedCredentialProvider?.enabled || !managedReadiness.some(entry=>entry.accessSourceId===route.accessSourceId && entry.modelId===route.modelId && entry.availability==="available")) {
                    route.availability = "unavailable";
                    route.readiness = "unavailable";
                    route.reason = "completion_unavailable";
                }
                continue;
            }
            if (route.accessSourceId === "owner_anthropic_key")
                continue;
            let harness = settings && appAiHarness(settings, route);
            if (route.accessSourceId === "owner_claude_profile" && !options.nativeProfileGuard) {
                route.availability = "unavailable";
                route.readiness = "unavailable";
                route.reason = "completion_unavailable";
                continue;
            }
            if (harness?.harness === "hermes") {
                const hermesProviderId=harness.route.providerId;
                let check=hermesChecks.find(entry=>entry.providerId===hermesProviderId && entry.accessSourceId===route.accessSourceId && entry.modelId===route.modelId);
                if(!check){
                    // Each alias needs its own proof. The projected authorization
                    // catalog bounds this array (128 harnesses × 256 models), and
                    // the caller deadline bounds lookups. Public pagination must
                    // not suppress a later exact owner-selected model.
                    const providerId=harness.route.providerId;
                    let available=false;
                    try {
                        let source=settings!.accessSources.find(entry=>entry.id===route.accessSourceId);
                        if(source?.localObservation?.staleAfter && Date.parse(source.localObservation.staleAfter)<=Date.now()) {
                            // Other harness probes can consume Hermes's five-second
                            // receipt window. Renew through authoritative readers.
                            [settings,canonical]=await Promise.all([options.providerSettingsReader?.getSnapshot({includeNativeAccountMetadata:false,includeNativeAccountUsage:false,signal}),options.providerSnapshotReader?.getSnapshot({signal})]);
                            harness=settings && appAiHarness(settings,route);
                            source=settings?.accessSources.find(entry=>entry.id===route.accessSourceId);
                        }
                        available=Boolean(options.hermesCompletion && canonical && source && harness && await options.hermesCompletion.probe({harness,source,canonical,signal}));
                    } catch(error){signal.throwIfAborted();console.warn("[app-ai] Hermes discovery unavailable",error instanceof Error?error.name:"UnknownError");}
                    check={providerId,accessSourceId:route.accessSourceId,modelId:route.modelId,available};hermesChecks.push(check); signal.throwIfAborted();
                }
                if(!check.available){route.availability="unavailable";route.readiness="unavailable";route.reason="completion_unavailable";}
                continue;
            }
            if (harness?.harness === "pi" && options.piSdkCompletion) {
                const piProviderId=harness.route.providerId;const piSettings=settings;
                let check = sdkChecks.find(entry=>entry.providerId===harness.route.providerId);
                if (!check) {
                    if (sdkChecks.length >= 128) throw new Error("App AI catalog unavailable");
                    const modelIds = [...new Set(routes.routes.filter(entry=>entry.availability==="available" && piSettings?.harnesses.some(candidate=>candidate.id===entry.harnessId && candidate.harness==="pi" && candidate.route.providerId===piProviderId && piSettings.accessSources.some(source=>source.id===candidate.accessSourceId && source.kind==="harness_profile"))).map(entry=>entry.modelId))];
                    let models: string[] = [];
                    try { models = await options.piSdkCompletion.probe({providerId:harness.route.providerId,modelIds,signal,revalidate:()=>isAppAiAllowed(options.homePath,app)}); }
                    catch (error) { signal.throwIfAborted();console.warn("[app-ai] Pi SDK discovery unavailable",error instanceof Error?error.name:"UnknownError"); }
                    check={providerId:harness.route.providerId,models};sdkChecks.push(check);signal.throwIfAborted();
                }
                if (check.models.includes(route.modelId)) { sdkRoutes.push(routeSelection(route));continue; }
            }
            if(harness?.harness==="pi"){
                // Only the audited public SDK may complete this exact Pi route.
                // Missing/unsupported SDK or model is not CLI fallback authority.
                route.availability="unavailable";route.readiness="unavailable";route.reason="completion_unavailable";continue;
            }
            if(harness?.harness==="opencode"){
                // CLI flags/config are not an audited no-tools execution contract.
                // Portable managed/owner API sources took their safe HTTP path above.
                route.availability="unavailable";route.readiness="unavailable";route.reason="completion_unavailable";
            }
        }
        // A default is selected only by explicit owner policy or their exact V3
        // active route. There is no first-ready/cheapest/provider fallback.
        let selected: AppAiRouteSelection | undefined = policy.route;
        if (!selected && canonical?.active?.providerInstanceId) {
            const instance = canonical.instances?.find(entry => entry.id === canonical.active.providerInstanceId);
            // V3 instance IDs and saved Settings IDs are independent. The active
            // driver is the binding; account/source/model alone can match other
            // harnesses, and array order conveys no owner intent.
            const activeHarness = instance?.driverId === "claude_code" || instance?.driverId === "kernel"
                ? "claude" : instance?.driverId;
            const candidates = settings?.harnesses.filter(entry => entry.harness === activeHarness
                && entry.accessSourceId === canonical.active.accessSourceId
                && entry.route.modelId === canonical.active.modelId
                && entry.selectedAccountId === instance?.accountId) ?? [];
            const available = candidates.filter(entry => routes.routes.some(route => route.availability === "available"
                && sameAppAiRoute(route, {harnessId:entry.id,accountId:entry.selectedAccountId,accessSourceId:entry.accessSourceId!,modelId:entry.route.modelId})));
            // Multiple saved instances of one driver have no exact V3-to-Settings
            // identity mapping. Require explicit app policy rather than guess.
            const harness = available.length === 1 ? available[0] : undefined;
            if (harness)
                selected = { harnessId: harness.id, accountId: harness.selectedAccountId, accessSourceId: harness.accessSourceId!, modelId: harness.route.modelId };
            else if (canonical.active.accessSourceId === CHATGPT_PLAN_SOURCE && instance?.id === CHATGPT_PLAN_SOURCE)
                selected = { harnessId: CHATGPT_PLAN_SOURCE, accountId: instance.accountId, accessSourceId: CHATGPT_PLAN_SOURCE, modelId: canonical.active.modelId! };
            else if (instance?.driverId === "kernel" && candidates.length === 0 && canonical.active.accessSourceId?.startsWith("matrix_"))
                selected = { harnessId: "matrix_ai", accountId: null, accessSourceId: canonical.active.accessSourceId, modelId: canonical.active.modelId! };
        }
        const exact = selected && routes.routes.find(entry => entry.availability === "available" && sameAppAiRoute(entry, selected));
        const authorizedRoutes=policy.route ? routes.routes.filter(entry=>sameAppAiRoute(entry,policy.route!)) : routes.routes;
        const publicRoutes = authorizedRoutes.slice(0,128);
        if (exact && !publicRoutes.some(entry=>sameAppAiRoute(entry,exact))) publicRoutes[publicRoutes.length>=128?127:publicRoutes.length]=exact;
        return { settings, canonical, policy, sdkRoutes, allRoutes:authorizedRoutes, routes: { routes:publicRoutes, defaultRoute: exact ? routeSelection(exact) : null } satisfies AppAiRoutes };
    }
    async function connected(request: AppAiRequest, signal: AbortSignal) {
        const initial = await catalog(request.app, signal);
        const route = request.route ?? initial.routes.defaultRoute;
        if (!route || !initial.allRoutes.some(entry => entry.availability === "available" && sameAppAiRoute(entry, route)))
            throw new Error("App AI route is unavailable");
        const revalidate = async () => {
            const current = await catalog(request.app, signal);
            return (!current.policy.model || current.policy.route!==undefined) && (!current.policy.route || sameAppAiRoute(current.policy.route,route)) && current.allRoutes.some(entry => entry.availability === "available" && sameAppAiRoute(entry, route))
                && (request.route !== undefined || current.routes.defaultRoute !== null && sameAppAiRoute(current.routes.defaultRoute, route));
        };
        if (route.accessSourceId === "matrix_cloudflare" || route.accessSourceId === "matrix_included" || route.accessSourceId === "owner_anthropic_key")
            return generateApiAppText({ ...options, route, prompt: request.prompt, signal, revalidate });
        if (route.accessSourceId === CHATGPT_PLAN_SOURCE) {
            const source = options.chatGptPlanSource?.();
            if (!source || !options.ownerIds.includes(source.ownerId) || !initial.canonical) throw new Error("App AI source unavailable");
            return generateChatGptPlanAppText({...source,app:request.app,route,canonical:initial.canonical,prompt:request.prompt,signal,revalidate});
        }
        if (!initial.settings)
            throw new Error("App AI route unavailable");
        const harness = appAiHarness(initial.settings, route);
        if (harness.harness === "claude" && route.accessSourceId === "owner_claude_profile") {
            const email = initial.settings.accounts.find(account => account.id === route.accountId)?.connectionDetails?.email;
            if (!email || !options.nativeProfileGuard)
                throw new Error("App AI account unavailable");
            // Native Settings probes refuse competing writer leases. Under our own
            // lease, durable owner intent and the direct CLI identity proof are used.
            const guardedRevalidate = async () => {
                signal.throwIfAborted();
                const policy = await readPolicy(options.homePath);
                if (!policy?.apps.includes(request.app))
                    return false;
                if (policy.model !== initial.policy.model || JSON.stringify(policy.route) !== JSON.stringify(initial.policy.route))
                    return false;
                const saved = await readSavedProviderSettingsConfiguration(join(options.homePath, "system/ai-providers/settings.json"));
                if (!saved)
                    return true;
                const selected = saved.harnesses.find(entry => entry.id === route.harnessId);
                return selected?.enabled === true && selected.selectedAccountId === route.accountId && selected.accessSourceId === route.accessSourceId && selected.route.modelId === initial.settings!.harnesses.find(entry => entry.id === route.harnessId)?.route.modelId;
            };
            return generateClaudeProfileAppText({ homePath: options.homePath, route, prompt: request.prompt, accountEmail: email, signal, profileGuard: options.nativeProfileGuard, revalidate: guardedRevalidate });
        }
        if (harness.harness === "hermes") {
            const source=initial.settings.accessSources.find(entry=>entry.id===route.accessSourceId);
            if(!options.hermesCompletion || !initial.canonical || !source) throw new Error("App AI source unavailable");
            const guardedRevalidate = async () => {
                signal.throwIfAborted();
                const policy=await readPolicy(options.homePath);
                if(!policy?.apps.includes(request.app) || policy.model!==initial.policy.model || JSON.stringify(policy.route)!==JSON.stringify(initial.policy.route)) return false;
                const saved=await readSavedProviderSettingsConfiguration(join(options.homePath,"system/ai-providers/settings.json"));
                const selected=saved ? saved.harnesses.find(entry=>entry.id===route.harnessId) : (await options.providerSettingsReader?.getSnapshot({includeNativeAccountMetadata:false,includeNativeAccountUsage:false,signal}))?.harnesses.find(entry=>entry.id===route.harnessId);
                if(!selected || !("configuredEnabled" in selected ? selected.configuredEnabled ?? selected.enabled : selected.enabled) || selected.harness!=="hermes" || selected.selectedAccountId!==null || selected.accessSourceId!==route.accessSourceId || selected.route.providerId!==harness.route.providerId || selected.route.modelId!==initial.settings!.harnesses.find(entry=>entry.id===route.harnessId)?.route.modelId) return false;
                if(!request.route && !policy.route){
                    const current=await options.providerSnapshotReader?.getSnapshot({includeNativeAccountMetadata:false,includeNativeAccountUsage:false,signal});
                    if(JSON.stringify(current?.active)!==JSON.stringify(initial.canonical?.active)) return false;
                }
                return true;
            };
            return options.hermesCompletion.generate({harness,source,canonical:initial.canonical,prompt:request.prompt,signal,revalidate:guardedRevalidate});
        }
        if (harness.harness === "pi" && options.piSdkCompletion && initial.sdkRoutes.some(entry=>sameAppAiRoute(entry,route))) {
            // A writer lease makes public discovery refuse competing work. Under
            // our own lease use durable owner intent; the worker independently
            // proves the exact physical model and locked credential lineage.
            const guardedRevalidate = async () => {
                signal.throwIfAborted();
                const policy = await readPolicy(options.homePath);
                if (!policy?.apps.includes(request.app) || policy.model!==initial.policy.model || JSON.stringify(policy.route)!==JSON.stringify(initial.policy.route)) return false;
                const saved = await readSavedProviderSettingsConfiguration(join(options.homePath,"system/ai-providers/settings.json"));
                const selected = saved ? saved.harnesses.find(entry=>entry.id===route.harnessId) : (await options.providerSettingsReader?.getSnapshot({includeNativeAccountMetadata:false,includeNativeAccountUsage:false,signal}))?.harnesses.find(entry=>entry.id===route.harnessId);
                if (!selected || selected.enabled!==true || selected.selectedAccountId!==route.accountId || selected.accessSourceId!==route.accessSourceId || selected.route.providerId!==harness.route.providerId || selected.route.modelId!==initial.settings!.harnesses.find(entry=>entry.id===route.harnessId)?.route.modelId) return false;
                if (!request.route && !policy.route) {
                    const current = await options.providerSnapshotReader?.getSnapshot({includeNativeAccountMetadata:false,includeNativeAccountUsage:false,signal});
                    if (JSON.stringify(current?.active)!==JSON.stringify(initial.canonical?.active)) return false;
                }
                return true;
            };
            return options.piSdkCompletion.generate({providerId:harness.route.providerId,modelId:route.modelId,prompt:request.prompt,signal,revalidate:guardedRevalidate});
        }
        throw new Error("App AI completion unavailable");
    }
    return createAppAiRoutes({
        lifecycle: options.lifecycle,
        authorizeOwner(context) {
            return options.ownerIds.includes(requireRequestPrincipal(context).userId);
        },
        async authorize(context, app) {
            const principal = requireRequestPrincipal(context);
            if (!options.ownerIds.includes(principal.userId))
                return false;
            return isAppAiAllowed(options.homePath, app);
        },
        async discover(app, signal) { return (await catalog(app, signal)).routes; },
        async authorizeSelection(request) {
            const policy=await readPolicy(options.homePath);
            return Boolean(policy?.apps.includes(request.app) && (!request.route || (policy.route ? sameAppAiRoute(policy.route,request.route) : !policy.model)));
        },
        async generate(request, signal) {
            const policy = await readPolicy(options.homePath);
            if (!policy?.apps.includes(request.app))
                throw new Error("App AI access denied");
            if (request.route || policy.route || !policy.model)
                return connected(request, signal);
            // Historical policies preserve the exact Claude model and credential path.
            const sources = await resolveKernelCredentialSources(options.homePath, process.env, options.fundedCredentialProvider);
            if (sources.selectedAccessSourceId === "matrix_included" && !MATRIX_INCLUDED_MODEL_IDS.some(model => model === policy.model))
                throw new Error("Model is unavailable for selected access");
            const launch = await buildKernelCredentialLaunch(options.homePath, process.env, sources.selectedAccessSourceId, options.fundedCredentialProvider, { requestClass: "interactive" });
            signal.throwIfAborted();
            if (!launch.env)
                throw new Error("App AI credentials unavailable");
            const current = await readPolicy(options.homePath);
            if (!current?.apps.includes(request.app) || current.model !== policy.model || current.route)
                throw new Error("App AI policy changed");
            return generateAppText({ prompt: request.prompt, model: policy.model, env: launch.env,
                signal: launch.fundedRunTimeoutMs ? AbortSignal.any([signal, AbortSignal.timeout(launch.fundedRunTimeoutMs)]) : signal });
        },
    });
}
