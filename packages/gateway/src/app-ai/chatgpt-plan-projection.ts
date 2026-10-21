import { AiProviderSnapshotV3Schema, AppAiRouteSchema, BotProviderConnectionSchema, type AppAiRoute, type AppAiRouteSelection, type AiProviderSnapshotV3, type AiProviderReadiness, type BotProviderConnection } from "@matrix-os/contracts";

export const CHATGPT_PLAN_SOURCE = "matrix_chatgpt_plan";
export const CHATGPT_PLAN_DRIVER = "chatgpt_plan_peer";

export function isCanonicalChatGptPlanAppRoute(snapshot: AiProviderSnapshotV3, route: AppAiRouteSelection, now = Date.now()): boolean {
  const fresh = (readiness: { state: string; checkedAt: string | null; staleAfter: string | null }) => readiness.state === "ready" && readiness.checkedAt !== null && Date.parse(readiness.checkedAt) <= now && readiness.staleAfter !== null && Date.parse(readiness.staleAfter) > now;
  const instance = snapshot.instances.find(entry => entry.id === CHATGPT_PLAN_SOURCE && entry.driverId === CHATGPT_PLAN_DRIVER && entry.accountId === route.accountId && entry.accessSourceId === route.accessSourceId && entry.modelIds.includes(route.modelId));
  const source = snapshot.accessSources.find(entry => entry.id === route.accessSourceId && entry.eligibleModelIds.includes(route.modelId));
  const account = snapshot.accounts.find(entry => entry.id === route.accountId && entry.vendor === "openai" && entry.authMethod === "oauth_pkce");
  const model = snapshot.models.find(entry => entry.id === route.modelId && entry.vendor === "openai" && entry.status !== "retired" && entry.status !== "unavailable" && entry.eligibleAccessSourceIds.includes(route.accessSourceId));
  return route.harnessId === CHATGPT_PLAN_SOURCE && route.accessSourceId === CHATGPT_PLAN_SOURCE && Boolean(instance && source && account && model && fresh(instance.readiness) && fresh(source) && fresh(account));
}

/** Discovery and execution share the same canonical predicate. Adapter absence is explicit. */
export function projectChatGptPlanAppRoutes(snapshot: AiProviderSnapshotV3, adapterAvailable: boolean, now = Date.now()): AppAiRoute[] {
  const instance = snapshot.instances.find(entry => entry.id === CHATGPT_PLAN_SOURCE);
  if (!instance) return [];
  return instance.modelIds.map(modelId => {
    const selection = { harnessId: CHATGPT_PLAN_SOURCE, accountId: instance.accountId, accessSourceId: CHATGPT_PLAN_SOURCE, modelId };
    const ready = adapterAvailable && isCanonicalChatGptPlanAppRoute(snapshot, selection, now);
    return AppAiRouteSchema.parse({ ...selection, displayName: instance.label, availability: ready ? "available" : "unavailable", readiness: ready ? "ready" : "unavailable", reason: ready ? null : !adapterAvailable ? "completion_unavailable" : "not_ready" });
  });
}

/** Common V3 projection from a freshly observed, configured owner's peer authority.
 * Invoke in the canonical snapshot service so Settings and apps see the same truth. */
export function projectChatGptPlanSnapshot(base: AiProviderSnapshotV3, observation: BotProviderConnection | undefined, now = new Date()): AiProviderSnapshotV3 {
  try { return projectValidatedSnapshot(base, observation, now); }
  catch (error) {
    // Unsupported/colliding peer metadata must never disable unrelated routes.
    console.warn("[ai-providers] connected plan projection unavailable", error instanceof Error ? error.name : "UnknownError");
    return projectValidatedSnapshot(base, undefined, now);
  }
}

function projectValidatedSnapshot(base: AiProviderSnapshotV3, observation: BotProviderConnection | undefined, now: Date): AiProviderSnapshotV3 {
  const previousAccount = base.instances.find(instance => instance.id === CHATGPT_PLAN_SOURCE)?.accountId;
  const instances = base.instances.filter(instance => instance.id !== CHATGPT_PLAN_SOURCE);
  const models = base.models.filter(model => !(model.eligibleAccessSourceIds.length === 1 && model.eligibleAccessSourceIds[0] === CHATGPT_PLAN_SOURCE)).map(model => ({ ...model,
    eligibleAccessSourceIds: model.eligibleAccessSourceIds.filter(id => id !== CHATGPT_PLAN_SOURCE),
    dataPolicies: model.dataPolicies.filter(policy => policy.accessSourceId !== CHATGPT_PLAN_SOURCE),
  }));
  const result: AiProviderSnapshotV3 = { ...base,
    accessSources: base.accessSources.filter(source => source.id !== CHATGPT_PLAN_SOURCE),
    accounts: base.accounts.filter(account => account.id !== previousAccount || instances.some(instance => instance.accountId === account.id)),
    drivers: base.drivers.filter(driver => driver.id !== CHATGPT_PLAN_DRIVER), instances, models,
    active: base.active.providerInstanceId === CHATGPT_PLAN_SOURCE ? { providerInstanceId: null, accessSourceId: null, modelId: null } : base.active,
  };
  if (!observation) return AiProviderSnapshotV3Schema.parse(result);
  const source = BotProviderConnectionSchema.parse(observation);
  if (source.id !== CHATGPT_PLAN_SOURCE || source.coordinatorFunding !== "subscription") throw new Error("App AI source unavailable");
  const ready = source.availability === "available" && source.authorization.enabled && source.authorization.revision > 0 && Boolean(source.accountId);
  const state = ready ? "ready" : source.unavailableReason === "authorization_required" ? "disabled" : "unavailable";
  const readiness: AiProviderReadiness = { state, checkedAt: now.toISOString(), staleAfter: new Date(+now + 30000).toISOString(), action: ready ? "none" : "connect", safeReason: ready ? null : "policy" };
  const version = `chatgpt-plan-${source.authorization.revision}`;
  const availableModels = ready ? source.models.slice(0, 64) : [];
  result.accessSources.push({ ...readiness, id: CHATGPT_PLAN_SOURCE, displayName: "ChatGPT subscription", fundingKind: "owner_account", vendor: "openai", accountLabel: source.accountId ? "Connected ChatGPT account" : null, eligibleModelIds: availableModels.map(model => model.id), policyVersion: version });
  if (source.accountId) {
    if (result.accounts.some(account => account.id === source.accountId)) throw new Error("App AI account unavailable");
    result.accounts.push({ ...readiness, id: source.accountId, vendor: "openai", authMethod: "oauth_pkce", accountLabel: "Connected ChatGPT account" });
  }
  result.drivers.push({ id: CHATGPT_PLAN_DRIVER, displayName: "Connected ChatGPT", kind: "openai_compatible", installState: ready ? "installed" : "unknown", health: ready ? "ready" : "unavailable", capabilities: ["cancellation"], setupActions: ready ? [] : ["connect_account"] });
  for (const model of availableModels) {
    const existing = result.models.find(candidate => candidate.id === model.id);
    const policy = { accessSourceId: CHATGPT_PLAN_SOURCE, route: "owner_direct" as const, disclosureKey: "chatgpt-plan-owner-device" };
    if (existing) {
      if (existing.vendor !== "openai") throw new Error("App AI model unavailable");
      existing.eligibleAccessSourceIds.push(CHATGPT_PLAN_SOURCE);
      existing.dataPolicies.push(policy);
    } else result.models.push({ id: model.id, vendor: "openai", displayName: model.displayName, status: "current", capabilities: [], effortControls: [], eligibleAccessSourceIds: [CHATGPT_PLAN_SOURCE], dataPolicies: [policy], aliases: [], catalogVersion: version });
  }
  result.instances.push({ id: CHATGPT_PLAN_SOURCE, driverId: CHATGPT_PLAN_DRIVER, vendor: "openai", accountId: source.accountId ?? null, accessSourceId: CHATGPT_PLAN_SOURCE, label: "ChatGPT subscription", readiness, capabilitySnapshot: ["cancellation"], modelIds: availableModels.map(model => model.id), defaultModelId: availableModels[0]?.id ?? null, catalogVersion: version });
  if (ready && base.active.providerInstanceId === CHATGPT_PLAN_SOURCE && base.active.accessSourceId === CHATGPT_PLAN_SOURCE && availableModels.some(model => model.id === base.active.modelId)) result.active = base.active;
  return AiProviderSnapshotV3Schema.parse(result);
}
