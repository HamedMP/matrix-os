import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  AiProviderSnapshotV3Schema,
  FundedAiEffectivePolicySchema,
  FundedAiFundingSummarySchema,
  ProviderConnectionAttemptSchema,
  ProviderDependencyCountsSchema,
  ProviderSettingsMutationResponseSchema,
  ProviderSettingsMutationSchema,
  type AiProviderSnapshotV3,
  type ProviderConnectionAttempt,
  type ProviderDependencyCounts,
  type ProviderSettingsMutation,
  type ProviderSettingsMutationResponse,
  type ProviderSettingsSnapshot,
  type ProviderSettingsSupportedAction,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import {
  MAX_PROVIDER_SETTINGS_RECEIPTS,
  ProviderSettingsConfigurationSchema,
  readProviderSecrets,
  readProviderSettingsConfiguration,
  writeProviderJsonAtomic,
  type ProviderSettingsConfiguration,
} from "./provider-settings-persistence.js";
import { ProviderSettingsStoreError } from "./provider-settings-errors.js";
import {
  applyProviderConfigurationMutation,
  type ProviderConfigurationMutation,
} from "./provider-settings-mutations.js";
import { projectProviderSettings } from "./provider-settings-projector.js";
import type {
  CanonicalProviderSnapshotReader,
  ProviderAccountDependencyCoordinator,
  ProviderAccountLifecycleCoordinator,
  ProviderLoginCoordinator,
  ProviderSettingsRuntimeMutationInput,
  ProviderSettingsRuntimeCoordinator,
} from "./provider-settings-coordinators.js";
import {
  assertProviderSettingsAction,
  coordinatorLoginHarness,
  coordinatorLoginMethods,
  requireCoordinatorLifecycleAccount,
  supportedProviderSettingsActions,
} from "./provider-settings-capability-policy.js";
import {
  currentProviderConnectionAttempt,
  hashProviderSettingsMutation,
  sameProviderDependencyCounts,
} from "./provider-settings-receipts.js";
import type { FundedAiFundingSummaryReader } from "../funded-ai-funding-summary-client.js";

const CONFIG_PATH = "system/ai-providers/settings.json";
const PRIVATE_DIRECTORY = ".matrix-private";
const DEFAULT_PROJECTION_AGE_MS = 5 * 60_000;
const SECRET_MAX_CHARS = 64 * 1024;
export { ProviderSettingsStoreError } from "./provider-settings-errors.js";
export type {
  CanonicalProviderSnapshotReader,
  ProviderAccountDependencyCoordinator,
  ProviderAccountLifecycleCoordinator,
  ProviderLoginCoordinator,
  ProviderSettingsRuntimeCoordinator,
} from "./provider-settings-coordinators.js";
export interface ProviderSettingsStoreWriter {
  getSnapshot(): Promise<ProviderSettingsSnapshot>;
  mutate(mutation: ProviderSettingsMutation): Promise<ProviderSettingsMutationResponse>;
}
interface ProviderSettingsStoreOptions {
  homePath: string;
  providerSnapshotReader: CanonicalProviderSnapshotReader;
  privateRootPath?: string;
  dependencyCoordinator?: ProviderAccountDependencyCoordinator;
  accountLifecycle?: ProviderAccountLifecycleCoordinator;
  loginCoordinator?: ProviderLoginCoordinator;
  runtimeCoordinator?: ProviderSettingsRuntimeCoordinator;
  now?: () => Date;
  idGenerator?: () => string;
  maxProjectionAgeMs?: number;
  fundingSummaryReader?: FundedAiFundingSummaryReader;
}

export class ProviderSettingsStore implements ProviderSettingsStoreWriter {
  readonly configurationPath: string;
  readonly secretsPath: string;
  readonly #reader: CanonicalProviderSnapshotReader;
  readonly #dependencies?: ProviderAccountDependencyCoordinator;
  readonly #lifecycle?: ProviderAccountLifecycleCoordinator;
  readonly #login?: ProviderLoginCoordinator;
  readonly #runtime?: ProviderSettingsRuntimeCoordinator;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #maxProjectionAgeMs: number;
  readonly #fundingSummary?: FundedAiFundingSummaryReader;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: ProviderSettingsStoreOptions) {
    if (!options.homePath) throw new Error("Provider settings home path is required");
    if (!options.providerSnapshotReader) throw new Error("Canonical provider snapshot reader is required");
    const homePath = resolve(options.homePath);
    this.configurationPath = join(homePath, CONFIG_PATH);
    const privateRoot = resolve(options.privateRootPath
      ?? join(dirname(homePath), PRIVATE_DIRECTORY, basename(homePath)));
    if (privateRoot === homePath || privateRoot.startsWith(`${homePath}/`)) {
      throw new Error("Provider secret storage must be outside the synced owner home");
    }
    this.secretsPath = join(privateRoot, "ai-provider-secrets.json");
    this.#reader = options.providerSnapshotReader;
    this.#dependencies = options.dependencyCoordinator;
    this.#lifecycle = options.accountLifecycle;
    this.#login = options.loginCoordinator;
    this.#runtime = options.runtimeCoordinator;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.idGenerator ?? randomUUID;
    this.#maxProjectionAgeMs = Math.max(
      1,
      Math.min(options.maxProjectionAgeMs ?? DEFAULT_PROJECTION_AGE_MS, 30 * 60_000),
    );
    this.#fundingSummary = options.fundingSummaryReader;
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#writeTail;
    let release = () => {};
    this.#writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  async #canonical(refresh = false): Promise<AiProviderSnapshotV3> {
    try {
      const snapshot = AiProviderSnapshotV3Schema.parse(await this.#reader.getSnapshot({ refresh }));
      const age = this.#now().getTime() - Date.parse(snapshot.refreshedAt);
      if (!Number.isFinite(age) || age < -60_000 || age > this.#maxProjectionAgeMs) {
        throw new Error("Stale canonical provider projection");
      }
      return snapshot;
    } catch (error) {
      console.warn(
        "[provider-settings] Canonical provider projection unavailable:",
        error instanceof Error ? error.name : "UnknownError",
      );
      throw new ProviderSettingsStoreError("projection_unavailable", 503);
    }
  }

  async #configuration(canonical: AiProviderSnapshotV3): Promise<ProviderSettingsConfiguration> {
    try {
      return await readProviderSettingsConfiguration(this.configurationPath, canonical);
    } catch (error) {
      console.warn(
        "[provider-settings] Owner provider configuration unavailable:",
        error instanceof Error ? error.name : "UnknownError",
      );
      throw new ProviderSettingsStoreError("configuration_unavailable", 503);
    }
  }

  async #project(canonical: AiProviderSnapshotV3, config: ProviderSettingsConfiguration) {
    try {
      let fundingSummary;
      let fundedPolicy;
      if (this.#fundingSummary && canonical.accessSources.some((source) =>
        source.fundingKind === "matrix_included" || source.fundingKind === "matrix_addon")) {
        try {
          const state = await this.#fundingSummary.getFundingSummary();
          fundingSummary = FundedAiFundingSummarySchema.parse(state.funding);
          fundedPolicy = FundedAiEffectivePolicySchema.parse(state.policy);
        } catch (error) {
          console.warn(
            "[provider-settings] Matrix funding summary unavailable:",
            error instanceof Error ? error.name : "UnknownError",
          );
        }
      }
      return await projectProviderSettings({
        canonical,
        config,
        now: this.#now(),
        dependencies: this.#dependencies,
        supportedActions: this.#supportedActions(config, canonical),
        fundingSummary,
        fundedPolicy,
        fundedPolicyAuthoritative: Boolean(this.#fundingSummary),
        configurationHarnessKinds: [...(this.#runtime?.supportedHarnessKinds ?? [])],
        loginMethods: (harness) => coordinatorLoginMethods({
          login: this.#login,
          harness,
          canonical,
        }),
      });
    } catch (error) {
      if (error instanceof ProviderSettingsStoreError) throw error;
      console.warn(
        "[provider-settings] Provider settings projection failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      throw new ProviderSettingsStoreError("projection_unavailable", 503);
    }
  }

  #supportedActions(
    config: ProviderSettingsConfiguration,
    canonical: AiProviderSnapshotV3,
  ): ProviderSettingsSupportedAction[] {
    return supportedProviderSettingsActions({
      runtime: this.#runtime,
      login: this.#login,
      lifecycle: this.#lifecycle,
      dependencies: this.#dependencies,
      config,
      canonical,
      gatewayPolicyAuthority: this.#fundingSummary ? "platform" : "local",
    });
  }

  #assertSupported(
    type: ProviderSettingsMutation["type"],
    config: ProviderSettingsConfiguration,
    canonical: AiProviderSnapshotV3,
  ): void {
    assertProviderSettingsAction({
      type,
      supportedActions: this.#supportedActions(config, canonical),
      hasDependencies: this.#dependencies !== undefined,
      hasLifecycle: this.#lifecycle !== undefined,
    });
  }

  async getSnapshot(): Promise<ProviderSettingsSnapshot> {
    return await this.#serialize(async () => {
      if (this.#runtime && !this.#runtime.isRecoveryReady()) {
        throw new ProviderSettingsStoreError("runtime_unavailable", 503);
      }
      const canonical = await this.#canonical();
      return await this.#project(canonical, await this.#configuration(canonical));
    });
  }

  async setAccountSecret(accountId: string, value: string): Promise<void> {
    await this.#serialize(async () => {
      const canonical = await this.#canonical();
      if (!canonical.accounts.some((account) => account.id === accountId)) {
        throw new ProviderSettingsStoreError("not_found", 404);
      }
      const secrets = await this.#readSecrets();
      secrets.accounts[accountId] = z.string().min(1).max(SECRET_MAX_CHARS).parse(value);
      await writeProviderJsonAtomic(this.secretsPath, secrets);
    });
  }

  async #readSecrets() {
    try { return await readProviderSecrets(this.secretsPath); }
    catch (error) {
      console.warn("[provider-settings] Provider secret storage unavailable");
      throw new ProviderSettingsStoreError("configuration_unavailable", 503);
    }
  }

  async #deleteSecret(accountId: string): Promise<void> {
    const secrets = await this.#readSecrets();
    if (!(accountId in secrets.accounts)) return;
    delete secrets.accounts[accountId];
    await writeProviderJsonAtomic(this.secretsPath, secrets);
  }

  async #coordinate(
    operation: () => Promise<void>,
    code: "lifecycle_unavailable" | "dependency_unavailable",
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (error instanceof ProviderSettingsStoreError) throw error;
      console.warn("[provider-settings] Provider coordination failed");
      throw new ProviderSettingsStoreError(code, 503);
    }
  }

  async #rollbackRuntime(input: ProviderSettingsRuntimeMutationInput): Promise<void> {
    try {
      await this.#runtime!.rollbackConfiguration(input);
    } catch (error) {
      console.warn(
        "[provider-settings] Provider runtime rollback failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      throw new ProviderSettingsStoreError("runtime_unavailable", 503);
    }
  }

  async #exactDependencies(
    accountId: string,
    config: ProviderSettingsConfiguration,
    expected: ProviderDependencyCounts,
  ): Promise<ProviderDependencyCounts> {
    if (!this.#dependencies) throw new ProviderSettingsStoreError("dependency_unavailable", 503);
    const harnessInstanceIds = config.harnesses
      .filter((harness) => harness.selectedAccountId === accountId)
      .map((harness) => harness.id);
    let actual: ProviderDependencyCounts;
    try {
      actual = ProviderDependencyCountsSchema.parse(
        await this.#dependencies.getAccountDependencies({ accountId, harnessInstanceIds }),
      );
    } catch (error) {
      console.warn("[provider-settings] Account dependency check unavailable");
      throw new ProviderSettingsStoreError("dependency_unavailable", 503);
    }
    if (!sameProviderDependencyCounts(actual, expected)) {
      throw new ProviderSettingsStoreError("revision_conflict", 409, {
        latestRevision: config.revision,
      });
    }
    return actual;
  }

  async #connectionAttempt(
    mutation: Extract<ProviderSettingsMutation, { type: "start_login" }>,
    harness: ProviderSettingsConfiguration["harnesses"][number],
    snapshot: ProviderSettingsSnapshot,
    canonical: AiProviderSnapshotV3,
  ): Promise<ProviderConnectionAttempt> {
    const methods = coordinatorLoginMethods({ login: this.#login, harness, canonical });
    if (!methods.includes(mutation.method)) {
      throw new ProviderSettingsStoreError("invalid_request", 400);
    }
    const account = mutation.accountId === null
      ? null
      : snapshot.accounts.find((candidate) => candidate.id === mutation.accountId);
    if (mutation.accountId !== null && !account) {
      throw new ProviderSettingsStoreError("not_found", 404);
    }
    if (account && account.providerId !== harness.route.providerId) {
      throw new ProviderSettingsStoreError("invalid_route", 400);
    }
    if (!this.#login) throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
    try {
      const attempt = ProviderConnectionAttemptSchema.parse(await this.#login.startLogin({
        mutation,
        harness: {
          ...coordinatorLoginHarness({ harness, canonical }),
          providerId: harness.route.providerId,
          modelId: harness.route.modelId,
        },
      }));
      if (attempt.harnessInstanceId !== harness.id || attempt.accountId !== mutation.accountId
        || attempt.method !== mutation.method) {
        throw new Error("Incoherent provider login attempt");
      }
      return attempt;
    } catch (error) {
      if (error instanceof ProviderSettingsStoreError) throw error;
      console.warn("[provider-settings] Provider login coordination failed");
      throw new ProviderSettingsStoreError("lifecycle_unavailable", 503);
    }
  }

  async #persist(
    config: ProviderSettingsConfiguration,
    mutation: ProviderSettingsMutation,
    payloadHash: string,
    attempt?: ProviderConnectionAttempt,
  ) {
    config.revision += 1;
    config.receipts.push({
      key: mutation.idempotencyKey,
      payloadHash,
      appliedRevision: config.revision,
      ...(attempt ? { attempt } : {}),
    });
    if (config.receipts.length > MAX_PROVIDER_SETTINGS_RECEIPTS) {
      config.receipts.splice(0, config.receipts.length - MAX_PROVIDER_SETTINGS_RECEIPTS);
    }
    const validated = ProviderSettingsConfigurationSchema.parse(config);
    try { await writeProviderJsonAtomic(this.configurationPath, validated); }
    catch (error) {
      console.warn(
        "[provider-settings] Failed to persist owner provider configuration:",
        error instanceof Error ? error.name : "UnknownError",
      );
      throw new ProviderSettingsStoreError("configuration_unavailable", 503);
    }
    return validated;
  }

  async mutate(input: ProviderSettingsMutation): Promise<ProviderSettingsMutationResponse> {
    const parsed = ProviderSettingsMutationSchema.safeParse(input);
    if (!parsed.success) throw new ProviderSettingsStoreError("invalid_request", 400);
    return await this.#serialize(async () => {
      let canonical = await this.#canonical();
      let config = await this.#configuration(canonical);
      const mutation = parsed.data;
      const payloadHash = hashProviderSettingsMutation(mutation);
      const duplicate = config.receipts.find((receipt) => receipt.key === mutation.idempotencyKey);
      if (duplicate) {
        if (duplicate.payloadHash !== payloadHash) {
          throw new ProviderSettingsStoreError("idempotency_conflict", 409);
        }
        const snapshot = await this.#project(canonical, config);
        const attempt = duplicate.attempt === undefined
          ? undefined
          : currentProviderConnectionAttempt(duplicate.attempt, this.#now());
        return attempt
          ? { kind: "login_attempt", snapshot, attempt }
          : { kind: "snapshot", snapshot };
      }
      if (mutation.expectedRevision !== config.revision) {
        throw new ProviderSettingsStoreError("revision_conflict", 409, {
          latestRevision: config.revision,
        });
      }
      this.#assertSupported(mutation.type, config, canonical);
      const snapshot = await this.#project(canonical, config);
      for (const account of snapshot.accounts) {
        if (config.accountProfiles.some((profile) => profile.id === account.id)) continue;
        config.accountProfiles.push({
          id: account.id,
          providerId: account.providerId,
          displayName: account.displayName,
          authMethod: account.authMethod,
          accessSourceId: account.accessSourceId,
        });
      }
      let attempt: ProviderConnectionAttempt | undefined;
      let runtimeMutation: ProviderSettingsRuntimeMutationInput | undefined;
      const previousConfig = structuredClone(config);
      const handled = applyProviderConfigurationMutation({
        mutation,
        config,
        canonical,
        snapshot,
        id: this.#id,
      });
      if (handled) {
        runtimeMutation = {
          mutation: mutation as ProviderConfigurationMutation,
          idempotencyKey: mutation.idempotencyKey,
          before: previousConfig,
          after: structuredClone(config),
          canonical: structuredClone(canonical),
          snapshot: structuredClone(snapshot),
        };
        try {
          await this.#runtime!.applyConfiguration(runtimeMutation);
        } catch (error) {
          if (error instanceof ProviderSettingsStoreError) throw error;
          console.warn("[provider-settings] Provider runtime configuration failed");
          throw new ProviderSettingsStoreError("runtime_unavailable", 503);
        }
        try {
          canonical = await this.#canonical(true);
        } catch (error) {
          await this.#rollbackRuntime(runtimeMutation);
          throw error;
        }
      }
      if (!handled) {
        switch (mutation.type) {
        case "start_login": {
          const harness = config.harnesses.find((candidate) => candidate.id === mutation.harnessInstanceId);
          if (!harness) throw new ProviderSettingsStoreError("not_found", 404);
          attempt = await this.#connectionAttempt(mutation, harness, snapshot, canonical);
          break;
        }
        case "logout_account": {
          if (!snapshot.accounts.some((account) => account.id === mutation.accountId)
            && !config.accountProfiles.some((account) => account.id === mutation.accountId)) {
            throw new ProviderSettingsStoreError("not_found", 404);
          }
          const account = requireCoordinatorLifecycleAccount(
            this.#lifecycle, mutation.accountId, config, canonical,
          );
          await this.#coordinate(() => this.#lifecycle!.logout({
            account,
            idempotencyKey: mutation.idempotencyKey,
          }), "lifecycle_unavailable");
          await this.#deleteSecret(mutation.accountId);
          canonical = await this.#canonical(true);
          break;
        }
        case "remove_account": {
          if (!snapshot.accounts.some((account) => account.id === mutation.accountId)
            && !config.accountProfiles.some((account) => account.id === mutation.accountId)) {
            throw new ProviderSettingsStoreError("not_found", 404);
          }
          const accountStillCanonical = snapshot.accounts.some((account) => account.id === mutation.accountId);
          const counts = accountStillCanonical
            ? await this.#exactDependencies(mutation.accountId, config, mutation.dependencyGuard)
            : mutation.dependencyGuard;
          if (Object.values(counts).some((count) => count > 0)) {
            throw new ProviderSettingsStoreError("account_in_use", 409);
          }
          const account = requireCoordinatorLifecycleAccount(
            this.#lifecycle, mutation.accountId, config, canonical,
          );
          await this.#coordinate(() => this.#lifecycle!.remove({
            account,
            idempotencyKey: mutation.idempotencyKey,
          }), "lifecycle_unavailable");
          await this.#deleteSecret(mutation.accountId);
          config.accountProfiles = config.accountProfiles.filter((profile) => profile.id !== mutation.accountId);
          canonical = await this.#canonical(true);
          break;
        }
        case "reassign_account": {
          if (!snapshot.accounts.some((account) => account.id === mutation.fromAccountId)
            && !config.accountProfiles.some((account) => account.id === mutation.fromAccountId)) {
            throw new ProviderSettingsStoreError("not_found", 404);
          }
          const target = mutation.target;
          const targetSourceId = target.kind === "account"
            ? snapshot.accounts.find((account) => account.id === target.accountId)?.accessSourceId
            : target.accessSourceId;
          const targetSource = snapshot.accessSources.find((source) => source.id === targetSourceId);
          if (!targetSource) throw new ProviderSettingsStoreError("not_found", 404);
          const affected = config.harnesses.filter((candidate) => candidate.selectedAccountId === mutation.fromAccountId);
          if ((mutation.scope === "harnesses" || mutation.scope === "all_dependencies")
            && affected.some((candidate) => candidate.route.providerId !== targetSource.providerId
              || !targetSource.eligibleModelIds.includes(candidate.route.modelId))) {
            throw new ProviderSettingsStoreError("invalid_route", 400);
          }
          await this.#coordinate(() => this.#dependencies!.reassignDependencies({
            fromAccountId: mutation.fromAccountId,
            target: mutation.target,
            scope: mutation.scope,
            dependencyGuard: mutation.dependencyGuard,
            harnessInstanceIds: affected.map((candidate) => candidate.id),
            idempotencyKey: mutation.idempotencyKey,
          }), "dependency_unavailable");
          if (mutation.scope === "harnesses" || mutation.scope === "all_dependencies") {
            for (const candidate of affected) {
              candidate.accessSourceId = targetSource.id;
              candidate.selectedAccountId = targetSource.accountId;
            }
          }
          break;
        }
        }
      }

      try {
        config = await this.#persist(config, mutation, payloadHash, attempt);
      } catch (error) {
        if (runtimeMutation) await this.#rollbackRuntime(runtimeMutation);
        throw error;
      }
      const projected = await this.#project(canonical, config);
      return ProviderSettingsMutationResponseSchema.parse(attempt
        ? { kind: "login_attempt", snapshot: projected, attempt }
        : { kind: "snapshot", snapshot: projected });
    });
  }
}
