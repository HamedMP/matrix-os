import {
  AiProviderReadinessSchema,
  AiProviderSnapshotV3Schema,
  type AiAccessSourceView,
  type AiProviderAccountView,
  type AiProviderReadiness,
  type AiProviderSnapshotV3,
} from "@matrix-os/contracts";
import type { KernelCredentialObservationState } from "../kernel-credentials.js";
import { KERNEL_DEFAULTS } from "../kernel-settings.js";
import { ProviderCredentialStore } from "./credential-store.js";
import { ProviderHealthCache } from "./health.js";
import {
  AI_PROVIDER_CATALOG_VERSION,
  buildBundledModelCatalog,
  eligibleModelsForSource,
} from "./model-catalog.js";

const HEALTH_TIMEOUT_MS = 2_000;
const KERNEL_CAPABILITIES = [
  "tools",
  "resume",
  "subagents",
  "vision",
  "reasoning",
  "cancellation",
] as const;

export interface AiProviderHealthProbe {
  (sourceId: string, signal: AbortSignal): Promise<AiProviderReadiness | null>;
}

export interface AiProviderSnapshotReader {
  getSnapshot(options?: { refresh?: boolean }): Promise<AiProviderSnapshotV3>;
}

interface AiProviderServiceOptions {
  homePath: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  healthProbe?: AiProviderHealthProbe;
  healthCache?: ProviderHealthCache<AiProviderReadiness>;
  healthTimeoutMs?: number;
}

function readinessForObservation(
  state: KernelCredentialObservationState,
  kind: "matrix" | "api_key" | "profile",
  now: string,
): AiProviderReadiness {
  if (state === "ready") {
    return { state: "ready", checkedAt: now, staleAfter: null, action: "none", safeReason: null };
  }
  if (state === "setup_required") {
    return {
      state: "setup_required",
      checkedAt: null,
      staleAfter: null,
      action: kind === "api_key" ? "enter_api_key" : "connect",
      safeReason: null,
    };
  }
  if (state === "unverified") {
    return { state: "unknown", checkedAt: null, staleAfter: null, action: "retry", safeReason: "unknown" };
  }
  if (state === "invalid") {
    return {
      state: "invalid",
      checkedAt: null,
      staleAfter: null,
      action: kind === "api_key" ? "enter_api_key" : "connect",
      safeReason: "auth",
    };
  }
  if (state === "unavailable") {
    return { state: "unavailable", checkedAt: null, staleAfter: null, action: "retry", safeReason: "unknown" };
  }
  return {
    state: "disabled",
    checkedAt: now,
    staleAfter: null,
    action: kind === "matrix" ? "contact_owner" : "connect",
    safeReason: "policy",
  };
}

function sourceFromReadiness(
  input: Omit<AiAccessSourceView, keyof AiProviderReadiness>,
  readiness: AiProviderReadiness,
): AiAccessSourceView {
  return { ...input, ...readiness };
}

function accountReadinessFromSource(
  readiness: AiProviderReadiness,
  authMethod: AiProviderAccountView["authMethod"],
): AiProviderAccountView {
  return {
    id: "owner_anthropic",
    vendor: "anthropic",
    authMethod,
    accountLabel: null,
    ...readiness,
  };
}

export class AiProviderService implements AiProviderSnapshotReader {
  readonly #credentials: ProviderCredentialStore;
  readonly #now: () => Date;
  readonly #healthProbe?: AiProviderHealthProbe;
  readonly #healthCache: ProviderHealthCache<AiProviderReadiness>;
  readonly #ownsHealthCache: boolean;
  readonly #healthTimeoutMs: number;

  constructor(options: AiProviderServiceOptions) {
    if (!options.homePath) throw new Error("AI provider home path is required");
    this.#credentials = new ProviderCredentialStore({
      homePath: options.homePath,
      env: options.env,
    });
    this.#now = options.now ?? (() => new Date());
    this.#healthProbe = options.healthProbe;
    this.#healthCache = options.healthCache ?? new ProviderHealthCache<AiProviderReadiness>();
    this.#ownsHealthCache = options.healthCache === undefined;
    this.#healthTimeoutMs = Math.max(
      1,
      Math.min(options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS, HEALTH_TIMEOUT_MS),
    );
  }

  async #resolveOwnerReadiness(
    sourceId: "owner_anthropic_key" | "owner_anthropic_profile",
    observation: KernelCredentialObservationState,
    kind: "api_key" | "profile",
    now: string,
    refresh: boolean,
  ): Promise<AiProviderReadiness> {
    const fallback = readinessForObservation(observation, kind, now);
    if (observation !== "unverified" || !this.#healthProbe) return fallback;
    if (refresh) this.#healthCache.delete(sourceId);
    const cached = this.#healthCache.get(sourceId);
    if (cached) return cached;

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("Provider readiness deadline exceeded"));
      }, this.#healthTimeoutMs);
    });
    try {
      const result = await Promise.race([
        this.#healthProbe(sourceId, controller.signal),
        deadline,
      ]);
      const readiness = result === null ? fallback : AiProviderReadinessSchema.parse(result);
      this.#healthCache.set(sourceId, readiness);
      return readiness;
    } catch (err) {
      console.warn(
        "[ai-providers] Provider readiness probe failed:",
        err instanceof Error ? err.name : "UnknownError",
      );
      const unavailable: AiProviderReadiness = {
        state: "unavailable",
        checkedAt: now,
        staleAfter: null,
        action: "retry",
        safeReason: controller.signal.aborted ? "timeout" : "unknown",
      };
      this.#healthCache.set(sourceId, unavailable);
      return unavailable;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async getSnapshot(options: { refresh?: boolean } = {}): Promise<AiProviderSnapshotV3> {
    const now = this.#now().toISOString();
    const { credentials, savedModel } = await this.#credentials.read();
    const matrixReadiness = readinessForObservation(
      credentials.matrixIncluded.state,
      "matrix",
      now,
    );
    const apiKeyReadiness = await this.#resolveOwnerReadiness(
      "owner_anthropic_key",
      credentials.ownerApiKey.state,
      "api_key",
      now,
      options.refresh === true,
    );
    const profileReadiness = await this.#resolveOwnerReadiness(
      "owner_anthropic_profile",
      credentials.ownerProfile.state,
      "profile",
      now,
      options.refresh === true,
    );
    const catalog = buildBundledModelCatalog();

    const accessSources: AiAccessSourceView[] = [
      sourceFromReadiness({
        id: "matrix_included",
        displayName: "Matrix AI",
        fundingKind: "matrix_included",
        vendor: "anthropic",
        accountLabel: "Included",
        eligibleModelIds: eligibleModelsForSource("matrix_included", catalog).map((model) => model.id),
        policyVersion: AI_PROVIDER_CATALOG_VERSION,
      }, matrixReadiness),
      sourceFromReadiness({
        id: "owner_anthropic_key",
        displayName: "Anthropic API key",
        fundingKind: "owner_api_key",
        vendor: "anthropic",
        accountLabel: null,
        eligibleModelIds: eligibleModelsForSource("owner_anthropic_key", catalog).map((model) => model.id),
        policyVersion: AI_PROVIDER_CATALOG_VERSION,
      }, apiKeyReadiness),
      sourceFromReadiness({
        id: "owner_anthropic_profile",
        displayName: "Anthropic account",
        fundingKind: "owner_account",
        vendor: "anthropic",
        accountLabel: null,
        eligibleModelIds: eligibleModelsForSource("owner_anthropic_profile", catalog).map((model) => model.id),
        policyVersion: AI_PROVIDER_CATALOG_VERSION,
      }, profileReadiness),
      sourceFromReadiness({
        id: "owner_openrouter",
        displayName: "OpenRouter account",
        fundingKind: "owner_account",
        vendor: "openrouter",
        accountLabel: null,
        eligibleModelIds: [],
        policyVersion: AI_PROVIDER_CATALOG_VERSION,
      }, readinessForObservation("setup_required", "profile", now)),
    ];

    const selectedOwnerReadiness = credentials.selectedMode === "api_key"
      ? apiKeyReadiness
      : credentials.selectedMode === "claude_login"
        ? profileReadiness
        : readinessForObservation("setup_required", "profile", now);
    const accounts: AiProviderAccountView[] = [
      accountReadinessFromSource(
        selectedOwnerReadiness,
        credentials.selectedMode === "api_key"
          ? "api_key"
          : credentials.selectedMode === "claude_login"
            ? "provider_profile"
            : null,
      ),
      {
        id: "owner_openrouter",
        vendor: "openrouter",
        authMethod: null,
        accountLabel: null,
        ...readinessForObservation("setup_required", "profile", now),
      },
    ];

    const instances = accessSources
      .filter((source) => source.vendor === "anthropic")
      .map((source) => {
        const sourceModels = eligibleModelsForSource(source.id, catalog);
        const configuredModel = savedModel !== null
          && sourceModels.some((model) => model.id === savedModel)
          ? savedModel
          : sourceModels.some((model) => model.id === KERNEL_DEFAULTS.model)
            ? KERNEL_DEFAULTS.model
            : sourceModels[0]?.id ?? null;
        return {
          id: `kernel_${source.id}`,
          driverId: "kernel",
          vendor: "anthropic" as const,
          accountId: source.id === "matrix_included" ? null : "owner_anthropic",
          accessSourceId: source.id,
          label: source.displayName,
          readiness: {
            state: source.state,
            checkedAt: source.checkedAt,
            staleAfter: source.staleAfter,
            action: source.action,
            safeReason: source.safeReason,
          },
          capabilitySnapshot: [...KERNEL_CAPABILITIES],
          modelIds: sourceModels.map((model) => model.id),
          defaultModelId: source.state === "ready" ? configuredModel : null,
          catalogVersion: AI_PROVIDER_CATALOG_VERSION,
        };
      });

    const selectedInstance = instances.find(
      (instance) => instance.accessSourceId === credentials.selectedAccessSourceId,
    );
    const active = selectedInstance?.readiness.state === "ready"
      && selectedInstance.defaultModelId !== null
      ? {
          providerInstanceId: selectedInstance.id,
          accessSourceId: selectedInstance.accessSourceId,
          modelId: selectedInstance.defaultModelId,
        }
      : { providerInstanceId: null, accessSourceId: null, modelId: null };

    return AiProviderSnapshotV3Schema.parse({
      contractVersion: 3,
      revision: 0,
      refreshedAt: now,
      accessSources,
      accounts,
      drivers: [{
        id: "kernel",
        displayName: "Matrix Agent",
        kind: "agent_sdk",
        installState: "installed",
        health: "ready",
        capabilities: [...KERNEL_CAPABILITIES],
        setupActions: [],
      }],
      instances,
      models: catalog,
      active,
    });
  }

  close(): void {
    if (this.#ownsHealthCache) this.#healthCache.close();
  }
}
