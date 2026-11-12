import {
  ProviderManagedCreditObservationSchema,
  type ProviderManagedCreditObservation,
  type ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import { isManagedCreditTimestampCurrent } from "./managed-credit-freshness.js";

export type ManagedCreditRefreshResult = "updated" | "retry" | "unsupported" | "aborted";

/** A funding observation can narrow existing routes, but never validate a route. */
function mergeCredit(snapshot: ProviderSettingsSnapshot, observation: ProviderManagedCreditObservation): ProviderSettingsSnapshot | null {
  const now = Date.now();
  const asOf = Date.parse(observation.usage.asOf);
  if (observation.revision !== snapshot.revision
    || observation.gatewayPolicyAccessSourceId !== (snapshot.gatewayPolicy?.accessSourceId ?? null)
    || observation.usage.state !== "current" || !isManagedCreditTimestampCurrent(observation.usage.asOf, now)
    || Date.parse(observation.policy.staleAfter) <= now) return null;
  const managed = snapshot.accessSources.filter(source => source.kind === "matrix_gateway"
    && (source.fundingKind === "matrix_included" || source.fundingKind === "matrix_addon"));
  if (!managed.length || managed.some(source => source.usage.kind === "managed_credit" && Date.parse(source.usage.asOf) > asOf)) return null;
  const allowed = (providerId: string, modelId: string) => observation.policy.allowedModelIds
    .some(candidate => candidate === modelId || candidate === `${providerId}/${modelId}`);
  const effectiveAllowedModelIds = (snapshot.gatewayPolicy?.effectiveAllowedModelIds
    ?? snapshot.gatewayPolicy?.allowedModelIds ?? []).filter(model => observation.policy.enabled
      && managed.some(source => source.eligibleModelIds.includes(model) && allowed(source.providerId, model)));
  const accessSources = snapshot.accessSources.map(source => {
    if (!managed.includes(source)) return source;
    const revoked = !observation.policy.enabled || !source.eligibleModelIds.some(model => allowed(source.providerId, model)
      && (snapshot.gatewayPolicy === null || effectiveAllowedModelIds.includes(model)));
    return { ...source, usage: observation.usage,
      // Funding eligibility is derived from current usage. Preserve independently
      // verified route evidence so funding recovery does not need a route probe.
      readiness: revoked
        ? { ...source.readiness, state: "unavailable" as const, action: "retry" as const,
          safeReason: "policy" as const }
        : source.readiness };
  });
  const purchaseEnabled = snapshot.gatewayPolicy !== null && observation.topUpEnabled;
  return { ...snapshot, accessSources,
    supportedActions: purchaseEnabled || !snapshot.supportedActions.includes("add_credit")
      ? snapshot.supportedActions
      : snapshot.supportedActions.filter(action => action !== "add_credit"),
    gatewayPolicy: snapshot.gatewayPolicy ? {
    ...snapshot.gatewayPolicy,
    effectiveAllowedModelIds,
    monthlyBudgetMicrousd: observation.policy.monthlyBudgetMicrousd,
    topUpEnabled: observation.topUpEnabled,
  } : null };
}

/** Excludes observation timestamps, but retains every funding and route authority. */
function creditAuthority(snapshot: ProviderSettingsSnapshot): string {
  return JSON.stringify({
    revision: snapshot.revision,
    access: snapshot.access,
    gatewayPolicy: snapshot.gatewayPolicy,
    sources: snapshot.accessSources.filter(source => source.kind === "matrix_gateway"
      && (source.fundingKind === "matrix_included" || source.fundingKind === "matrix_addon"))
      .map(source => ({ id: source.id, kind: source.kind, fundingKind: source.fundingKind,
        providerId: source.providerId, accountId: source.accountId,
        account: snapshot.accounts.find(account => account.id === source.accountId) ?? null,
        eligibleModelIds: source.eligibleModelIds,
        readiness: { state: source.readiness.state, action: source.readiness.action, safeReason: source.readiness.safeReason } })),
  });
}

/** Replaying a funding observation must retain its already accepted restrictions. */
function retainCreditRestrictions(snapshot: ProviderSettingsSnapshot, previous: ProviderSettingsSnapshot): ProviderSettingsSnapshot {
  if (snapshot === previous) return snapshot;
  const allowed = previous.gatewayPolicy?.effectiveAllowedModelIds ?? previous.gatewayPolicy?.allowedModelIds ?? [];
  return { ...snapshot,
    gatewayPolicy: snapshot.gatewayPolicy ? { ...snapshot.gatewayPolicy,
      effectiveAllowedModelIds: (snapshot.gatewayPolicy.effectiveAllowedModelIds ?? snapshot.gatewayPolicy.allowedModelIds)
        .filter(model => allowed.includes(model)),
    } : null,
    supportedActions: previous.supportedActions.includes("add_credit") ? snapshot.supportedActions
      : snapshot.supportedActions.filter(action => action !== "add_credit"),
    accessSources: snapshot.accessSources.map(source => {
      if (source.kind !== "matrix_gateway") return source;
      const readiness = previous.accessSources.find(candidate => candidate.id === source.id)?.readiness;
      return readiness && readiness.state !== "ready"
        ? { ...source, readiness: { ...source.readiness,
          state: readiness.state, action: readiness.action, safeReason: readiness.safeReason } }
        : source;
    }),
  };
}

/** One bounded quiet read per identity-scoped controller, also across effect replay. */
export class ManagedCreditRefresh {
  private pending: Promise<ManagedCreditRefreshResult> | null = null;
  private request: AbortController | null = null;
  private generation = 0;
  private stopped = false;
  // One server-validated observation, scoped to this identity-owned coordinator.
  private accepted: { observation: ProviderManagedCreditObservation; baseAuthority: string; appliedAuthority: string } | null = null;

  constructor(private readonly options: {
    read?: (signal: AbortSignal) => Promise<unknown>;
    snapshot: () => ProviderSettingsSnapshot | null;
    blocked: () => boolean;
    apply: (snapshot: ProviderSettingsSnapshot) => void;
  }) {}

  invalidate = (): void => { this.generation++; this.accepted = null; this.request?.abort(); };

  reconcileNativeSnapshot = (snapshot: ProviderSettingsSnapshot): ProviderSettingsSnapshot => {
    const accepted = this.accepted;
    if (!accepted) return snapshot;
    const authority = creditAuthority(snapshot);
    const previous = this.options.snapshot();
    const next = previous && creditAuthority(previous) === accepted.appliedAuthority
      && (authority === accepted.baseAuthority || authority === accepted.appliedAuthority)
      ? mergeCredit(retainCreditRestrictions(snapshot, previous), accepted.observation) : null;
    if (!next) this.accepted = null;
    return next ?? snapshot;
  };

  refresh = (signal?: AbortSignal): Promise<ManagedCreditRefreshResult> => {
    if (this.stopped || !this.options.read) return Promise.resolve("unsupported");
    if (signal?.aborted) return Promise.resolve("aborted");
    if (this.pending) return this.pending;
    const snapshot = this.options.snapshot();
    if (!snapshot || this.options.blocked()) return Promise.resolve("retry");
    const authority = creditAuthority(snapshot);
    const baseAuthority = this.accepted && authority === this.accepted.appliedAuthority
      ? this.accepted.baseAuthority : authority;
    const generation = this.generation;
    const request = new AbortController(); this.request = request;
    const abort = () => request.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.pending = Promise.resolve().then(async (): Promise<ManagedCreditRefreshResult> => {
      try {
        if (request.signal.aborted || generation !== this.generation) return "aborted";
        const raw = await this.options.read!(request.signal);
        if (request.signal.aborted || generation !== this.generation) return "aborted";
        const parsed = ProviderManagedCreditObservationSchema.safeParse(raw);
        const current = this.options.snapshot();
        if (!parsed.success || !current || ![authority, baseAuthority].includes(creditAuthority(current)) || this.options.blocked()) return "retry";
        const next = mergeCredit(retainCreditRestrictions(current, snapshot), parsed.data);
        if (!next) return "retry";
        this.accepted = { observation: parsed.data, baseAuthority, appliedAuthority: creditAuthority(next) };
        this.options.apply(next); return "updated";
      } catch (error) {
        if (request.signal.aborted || generation !== this.generation) return "aborted";
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
        if (code === "managed_credit_unsupported" || code === "managed_credit_unauthorized") {
          this.stopped = true; return "unsupported";
        }
        console.warn("[provider-settings] Managed credit refresh failed:", error instanceof Error ? error.name : typeof error);
        return "retry";
      } finally {
        signal?.removeEventListener("abort", abort);
        this.request = null; this.pending = null;
      }
    });
    return this.pending;
  };
}
