import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiProviderSnapshotV3Schema,
  ProviderSettingsSnapshotSchema,
  type AiProviderSnapshotV3,
  type ProviderDependencyCounts,
} from "@matrix-os/contracts";
import {
  ProviderSettingsStore,
  ProviderSettingsStoreError,
  type ProviderAccountDependencyCoordinator,
  type ProviderAccountLifecycleCoordinator,
  type ProviderLoginCoordinator,
  type ProviderSettingsRuntimeCoordinator,
} from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import {
  PROVIDER_SETTINGS_NOW as NOW,
  providerReady as ready,
  providerSettingsCanonicalFixture,
} from "./provider-settings-test-support.js";

describe("ProviderSettingsStore", () => {
  let homePath: string;
  let privateRootPath: string;
  let canonical: AiProviderSnapshotV3;
  let dependencyCounts: Omit<ProviderDependencyCounts, "harnessInstanceCount">;
  let dependencies: ProviderAccountDependencyCoordinator;
  let lifecycle: ProviderAccountLifecycleCoordinator;
  let login: ProviderLoginCoordinator;
  let runtime: ProviderSettingsRuntimeCoordinator;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "provider-settings-store-"));
    privateRootPath = join(dirname(homePath), `.matrix-private-${homePath.split("-").at(-1)}`);
    canonical = providerSettingsCanonicalFixture();
    dependencyCounts = { activeChatCount: 0, resumableChatCount: 0 };
    dependencies = {
      getAccountDependencies: vi.fn(async ({ harnessInstanceIds }) => ({
        ...dependencyCounts,
        harnessInstanceCount: harnessInstanceIds.length,
      })),
      reassignDependencies: vi.fn(async () => undefined),
    };
    lifecycle = {
      logout: vi.fn(async ({ accountId }) => {
        canonical = AiProviderSnapshotV3Schema.parse({
          ...canonical,
          revision: canonical.revision + 1,
          accounts: canonical.accounts.map((account) => account.id === accountId ? {
            ...account,
            authMethod: null,
            state: "setup_required",
            checkedAt: null,
            staleAfter: null,
            action: "connect",
          } : account),
          accessSources: canonical.accessSources.map((source) => source.id === "owner_anthropic_profile" ? {
            ...source,
            state: "setup_required",
            checkedAt: null,
            staleAfter: null,
            action: "connect",
          } : source),
          instances: canonical.instances.map((instance) => instance.accountId === accountId ? {
            ...instance,
            readiness: {
              state: "setup_required",
              checkedAt: null,
              staleAfter: null,
              action: "connect",
              safeReason: null,
            },
            defaultModelId: null,
          } : instance),
        });
      }),
      remove: vi.fn(async ({ accountId }) => {
        canonical = AiProviderSnapshotV3Schema.parse({
          ...canonical,
          revision: canonical.revision + 1,
          accounts: canonical.accounts.filter((account) => account.id !== accountId),
          accessSources: canonical.accessSources.filter((source) => source.id !== "owner_anthropic_profile"),
          instances: canonical.instances.filter((instance) => instance.accountId !== accountId),
          models: canonical.models.map((model) => ({
            ...model,
            eligibleAccessSourceIds: model.eligibleAccessSourceIds.filter((id) => id !== "owner_anthropic_profile"),
            dataPolicies: model.dataPolicies.filter((policy) => policy.accessSourceId !== "owner_anthropic_profile"),
          })),
        });
      }),
    };
    login = {
      supportedMethods: vi.fn(() => ["terminal", "oauth", "api_key"]),
      startLogin: vi.fn(async ({ mutation }) => ({
        id: "attempt_real_terminal_1",
        harnessInstanceId: mutation.harnessInstanceId,
        accountId: mutation.accountId,
        method: mutation.method,
        state: "pending",
        action: { kind: "open_terminal", terminalSessionId: "terminal_real_1" },
        expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
        safeFailure: null,
      })),
    };
    runtime = {
      supportedActions: [
        "add_harness",
        "update_harness",
        "set_harness_enabled",
        "set_route",
        "select_account",
        "select_access_source",
        "set_gateway_budget",
        "set_gateway_allowlist",
      ],
      applyConfiguration: vi.fn(async () => undefined),
    };
  });

  afterEach(async () => {
    await rm(homePath, { recursive: true, force: true });
    await rm(privateRootPath, { recursive: true, force: true });
  });

  function createStore(options: {
    withDependencies?: boolean;
    withLifecycle?: boolean;
    withLogin?: boolean;
    withRuntime?: boolean;
    snapshot?: () => AiProviderSnapshotV3;
  } = {}) {
    let nextId = 0;
    return new ProviderSettingsStore({
      homePath,
      privateRootPath,
      providerSnapshotReader: {
        getSnapshot: async () => structuredClone((options.snapshot ?? (() => canonical))()),
      },
      dependencyCoordinator: options.withDependencies === false ? undefined : dependencies,
      accountLifecycle: options.withLifecycle === false ? undefined : lifecycle,
      loginCoordinator: options.withLogin === false ? undefined : login,
      runtimeCoordinator: options.withRuntime === false ? undefined : runtime,
      now: () => NOW,
      idGenerator: () => `generated_${++nextId}`,
    });
  }

  it("projects fresh V3 truth and persists owner configuration without readiness or usage copies", async () => {
    const store = createStore();
    const initial = await store.getSnapshot();
    expect(ProviderSettingsSnapshotSchema.safeParse(initial).success).toBe(true);
    expect(initial).toMatchObject({
      projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 7 },
      revision: 0,
      access: { mode: "writable" },
    });
    expect(initial.accessSources[0]!.usage).toMatchObject({
      kind: "unavailable",
      authority: "unavailable",
      reason: "ledger_not_available",
    });

    const response = await store.mutate({
      type: "add_harness",
      expectedRevision: 0,
      idempotencyKey: "add_opencode_1",
      harness: "opencode",
      displayName: "OpenCode",
      route: { kind: "configurable", providerId: "anthropic", modelId: "claude-sonnet-5" },
      accessSourceId: "matrix_included",
      accountId: null,
    });
    expect(response.kind).toBe("snapshot");
    expect(response.snapshot.revision).toBe(1);
    expect(response.snapshot.harnesses).toEqual(expect.arrayContaining([
      expect.objectContaining({ harness: "opencode", enabled: false, installState: "missing" }),
    ]));
    const stored = await readFile(store.configurationPath, "utf8");
    expect((await stat(store.configurationPath)).mode & 0o777).toBe(0o600);
    expect(stored).not.toMatch(/"readiness"|"usage"|apiKey|accessToken/);
  });

  it("normalizes a persisted legacy Claude driver to canonical inventory for projection and login", async () => {
    canonical = AiProviderSnapshotV3Schema.parse({
      ...canonical,
      drivers: canonical.drivers.filter((driver) => driver.id === "claude_code"),
      instances: canonical.instances.map((instance) => ({ ...instance, driverId: "claude_code" })),
    });
    login.supportedMethods = vi.fn(({ driverId, installState }) =>
      driverId === "claude_code" && installState === "installed" ? ["terminal"] : []);
    const store = createStore();
    await mkdir(dirname(store.configurationPath), { recursive: true });
    await writeFile(store.configurationPath, JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      harnesses: [{
        id: "harness_legacy_claude",
        driverId: "kernel",
        harness: "claude",
        displayName: "Claude",
        accentColor: null,
        enabled: true,
        selectedAccountId: null,
        accessSourceId: "matrix_included",
        route: { kind: "fixed", providerId: "anthropic", modelId: "claude-sonnet-5" },
      }],
      accountProfiles: [],
      gatewayPolicy: {
        accessSourceId: "matrix_included",
        monthlyBudgetMicrousd: null,
        allowedModelIds: ["claude-sonnet-5"],
        topUpEnabled: false,
      },
      receipts: [],
    }), { mode: 0o600 });

    const snapshot = await store.getSnapshot();
    expect(snapshot.supportedActions).toContain("start_login");
    expect(snapshot.harnesses).toContainEqual(expect.objectContaining({
      id: "harness_legacy_claude",
      harness: "claude",
      enabled: true,
      installState: "installed",
      loginMethods: ["terminal"],
      recommendedLoginMethod: "terminal",
    }));

    await expect(store.mutate({
      type: "start_login",
      expectedRevision: 0,
      idempotencyKey: "legacy_claude_login_1",
      harnessInstanceId: "harness_legacy_claude",
      accountId: null,
      method: "terminal",
    })).resolves.toMatchObject({
      kind: "login_attempt",
      snapshot: {
        harnesses: [expect.objectContaining({ enabled: true, installState: "installed" })],
      },
    });
    expect(login.startLogin).toHaveBeenCalledWith(expect.objectContaining({
      harness: expect.objectContaining({
        id: "harness_legacy_claude",
        driverId: "claude_code",
        harness: "claude",
        installState: "installed",
      }),
    }));
  });

  it("is read-only and rejects cosmetic mutations without a runtime coordinator", async () => {
    const store = createStore({
      withRuntime: false,
      withLogin: false,
      withLifecycle: false,
      withDependencies: false,
    });
    const snapshot = await store.getSnapshot();
    expect(snapshot.access).toEqual({ mode: "read_only", reason: "runtime_unavailable" });
    expect(snapshot.supportedActions).toEqual([]);
    await expect(store.mutate({
      type: "set_gateway_budget",
      expectedRevision: 0,
      idempotencyKey: "budget_unwired_1",
      monthlyBudgetMicrousd: 1,
    })).rejects.toMatchObject({ code: "runtime_unavailable" });
  });

  it("rejects missing, malformed, and stale canonical projections", async () => {
    expect(() => new ProviderSettingsStore({
      homePath,
      providerSnapshotReader: undefined as never,
    })).toThrow("Canonical provider snapshot reader is required");
    const stale = { ...canonical, refreshedAt: "2026-08-30T09:00:00.000Z" };
    await expect(createStore({ snapshot: () => stale }).getSnapshot())
      .rejects.toMatchObject({ code: "projection_unavailable" });
  });

  it("enforces revision concurrency and bounded idempotency", async () => {
    const store = createStore();
    const mutation = {
      type: "set_gateway_budget" as const,
      expectedRevision: 0,
      idempotencyKey: "budget_1",
      monthlyBudgetMicrousd: 2_000_000,
    };
    expect((await store.mutate(mutation)).snapshot.revision).toBe(1);
    expect((await store.mutate(mutation)).snapshot.revision).toBe(1);
    await expect(store.mutate({ ...mutation, monthlyBudgetMicrousd: 3_000_000 }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });

    const results = await Promise.allSettled([
      store.mutate({ ...mutation, expectedRevision: 1, idempotencyKey: "budget_2", monthlyBudgetMicrousd: 3_000_000 }),
      store.mutate({ ...mutation, expectedRevision: 1, idempotencyKey: "budget_3", monthlyBudgetMicrousd: 4_000_000 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected"))
      .toMatchObject({ reason: expect.objectContaining({ code: "revision_conflict" }) });
  });

  it("returns an idempotent visible Terminal login attempt and keeps secrets outside sync/export", async () => {
    const store = createStore();
    const mutation = {
      type: "start_login" as const,
      expectedRevision: 0,
      idempotencyKey: "login_1",
      harnessInstanceId: "harness_kernel",
      accountId: null,
      method: "terminal" as const,
    };
    const first = await store.mutate(mutation);
    const retried = await store.mutate(mutation);
    expect(first).toMatchObject({
      kind: "login_attempt",
      attempt: { state: "pending", action: { kind: "open_terminal" } },
    });
    expect(retried).toEqual(first);
    expect(login.startLogin).toHaveBeenCalledOnce();
    expect(first.kind === "login_attempt" && first.attempt.action).toEqual({
      kind: "open_terminal",
      terminalSessionId: "terminal_real_1",
    });

    await store.setAccountSecret("owner_anthropic", "secret-value");
    expect(store.secretsPath.startsWith(homePath)).toBe(false);
    expect((await stat(store.secretsPath)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(await store.getSnapshot())).not.toContain("secret-value");
  });

  it("does not fabricate login sessions and rejects account/provider mismatches", async () => {
    await expect(createStore({ withLogin: false }).mutate({
      type: "start_login",
      expectedRevision: 0,
      idempotencyKey: "login_unwired_1",
      harnessInstanceId: "harness_kernel",
      accountId: null,
      method: "terminal",
    })).rejects.toMatchObject({ code: "lifecycle_unavailable" });

    canonical = AiProviderSnapshotV3Schema.parse({
      ...canonical,
      accessSources: [...canonical.accessSources, {
        id: "owner_openai_profile",
        displayName: "OpenAI account",
        fundingKind: "owner_account",
        vendor: "openai",
        accountLabel: "OpenAI",
        eligibleModelIds: ["gpt-5"],
        policyVersion: "policy_1",
        ...ready,
      }],
      accounts: [...canonical.accounts, {
        id: "owner_openai",
        vendor: "openai",
        authMethod: "provider_profile",
        accountLabel: "OpenAI",
        ...ready,
      }],
      instances: [...canonical.instances, {
        id: "kernel_openai",
        driverId: "kernel",
        vendor: "openai",
        accountId: "owner_openai",
        accessSourceId: "owner_openai_profile",
        label: "OpenAI",
        readiness: ready,
        capabilitySnapshot: ["tools", "resume"],
        modelIds: ["gpt-5"],
        defaultModelId: "gpt-5",
        catalogVersion: "catalog_1",
      }],
      models: [...canonical.models, {
        id: "gpt-5",
        vendor: "openai",
        displayName: "GPT-5",
        status: "current",
        capabilities: ["tools", "reasoning"],
        effortControls: ["high"],
        eligibleAccessSourceIds: ["owner_openai_profile"],
        dataPolicies: [{
          accessSourceId: "owner_openai_profile",
          route: "owner_direct",
          disclosureKey: "owner-openai",
        }],
        aliases: [],
        catalogVersion: "catalog_1",
      }],
    });
    await expect(createStore().mutate({
      type: "start_login",
      expectedRevision: 0,
      idempotencyKey: "login_wrong_provider_1",
      harnessInstanceId: "harness_kernel",
      accountId: "owner_openai",
      method: "terminal",
    })).rejects.toMatchObject({ code: "invalid_route" });
    expect(login.startLogin).not.toHaveBeenCalled();

    login.startLogin = vi.fn(async ({ mutation }) => ({
      id: "attempt_wrong_1",
      harnessInstanceId: "harness_other",
      accountId: mutation.accountId,
      method: mutation.method,
      state: "pending",
      action: { kind: "open_terminal", terminalSessionId: "terminal_wrong_1" },
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      safeFailure: null,
    }));
    await expect(createStore().mutate({
      type: "start_login",
      expectedRevision: 0,
      idempotencyKey: "login_incoherent_1",
      harnessInstanceId: "harness_kernel",
      accountId: null,
      method: "terminal",
    })).rejects.toMatchObject({ code: "lifecycle_unavailable" });
  });

  it("recovers a deterministic stale atomic-write temp and validates receipt attempts", async () => {
    const store = createStore();
    const tempPath = join(dirname(store.configurationPath), ".settings.json.tmp");
    await mkdir(dirname(tempPath), { recursive: true });
    await writeFile(tempPath, "stale", { mode: 0o600 });
    await store.mutate({
      type: "set_gateway_budget",
      expectedRevision: 0,
      idempotencyKey: "budget_atomic_1",
      monthlyBudgetMicrousd: 2_000_000,
    });
    await expect(stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });

    const sentinelPath = join(homePath, "sentinel.txt");
    await writeFile(sentinelPath, "untouched");
    await symlink(sentinelPath, tempPath);
    await expect(store.mutate({
      type: "set_gateway_budget",
      expectedRevision: 1,
      idempotencyKey: "budget_atomic_2",
      monthlyBudgetMicrousd: 3_000_000,
    })).rejects.toMatchObject({ code: "configuration_unavailable" });
    expect(await readlink(tempPath)).toBe(sentinelPath);
    expect(await readFile(sentinelPath, "utf8")).toBe("untouched");
    await unlink(tempPath);

    const persisted = JSON.parse(await readFile(store.configurationPath, "utf8"));
    persisted.receipts[0].attempt = { secret: "must-not-persist" };
    await writeFile(store.configurationPath, JSON.stringify(persisted), { mode: 0o600 });
    await expect(store.getSnapshot()).rejects.toMatchObject({ code: "configuration_unavailable" });
  });

  it("keeps logout distinct and blocks removal until exact dependencies are reassigned", async () => {
    const store = createStore();
    let response = await store.mutate({
      type: "select_account",
      expectedRevision: 0,
      idempotencyKey: "select_owner_1",
      harnessInstanceId: "harness_kernel",
      accountId: "owner_anthropic",
    });
    await store.setAccountSecret("owner_anthropic", "secret-value");
    response = await store.mutate({
      type: "logout_account",
      expectedRevision: response.snapshot.revision,
      idempotencyKey: "logout_owner_1",
      accountId: "owner_anthropic",
    });
    expect(response.snapshot.accounts).toEqual([
      expect.objectContaining({ id: "owner_anthropic", authState: "unauthenticated" }),
    ]);
    expect(await readFile(store.secretsPath, "utf8")).not.toContain("secret-value");

    await expect(store.mutate({
      type: "remove_account",
      expectedRevision: response.snapshot.revision,
      idempotencyKey: "remove_owner_1",
      accountId: "owner_anthropic",
      dependencyGuard: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 1 },
      confirmation: "remove_account",
    })).rejects.toMatchObject({ code: "account_in_use" });

    response = await store.mutate({
      type: "reassign_account",
      expectedRevision: response.snapshot.revision,
      idempotencyKey: "reassign_owner_1",
      fromAccountId: "owner_anthropic",
      target: { kind: "access_source", accessSourceId: "matrix_included" },
      scope: "all_dependencies",
      dependencyGuard: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 1 },
    });
    expect(dependencies.reassignDependencies).toHaveBeenCalledOnce();

    response = await store.mutate({
      type: "remove_account",
      expectedRevision: response.snapshot.revision,
      idempotencyKey: "remove_owner_2",
      accountId: "owner_anthropic",
      dependencyGuard: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 },
      confirmation: "remove_account",
    });
    expect(response.snapshot.accounts).toEqual([]);
    expect(lifecycle.remove).toHaveBeenCalledWith({
      accountId: "owner_anthropic",
      idempotencyKey: "remove_owner_2",
    });
    expect(dependencies.reassignDependencies).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "reassign_owner_1",
    }));
  });

  it("recovers an idempotent account removal after owner-config persistence fails", async () => {
    const store = createStore();
    await store.getSnapshot();
    const tempPath = join(dirname(store.configurationPath), ".settings.json.tmp");
    const sentinelPath = join(homePath, "remove-sentinel.txt");
    await writeFile(sentinelPath, "untouched");
    await symlink(sentinelPath, tempPath);
    const mutation = {
      type: "remove_account" as const,
      expectedRevision: 0,
      idempotencyKey: "remove_recovery_1",
      accountId: "owner_anthropic",
      dependencyGuard: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 },
      confirmation: "remove_account" as const,
    };
    await expect(store.mutate(mutation)).rejects.toMatchObject({ code: "configuration_unavailable" });
    expect(canonical.accounts).toEqual([]);
    await unlink(tempPath);

    const response = await store.mutate(mutation);
    expect(response.snapshot.accounts).toEqual([]);
    expect(lifecycle.remove).toHaveBeenNthCalledWith(1, {
      accountId: "owner_anthropic",
      idempotencyKey: "remove_recovery_1",
    });
    expect(lifecycle.remove).toHaveBeenNthCalledWith(2, {
      accountId: "owner_anthropic",
      idempotencyKey: "remove_recovery_1",
    });
  });

  it("fails closed without dependency and lifecycle coordinators and preserves malformed owner files", async () => {
    const store = createStore({ withDependencies: false, withLifecycle: false });
    await expect(store.mutate({
      type: "remove_account",
      expectedRevision: 0,
      idempotencyKey: "remove_unwired_1",
      accountId: "owner_anthropic",
      dependencyGuard: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 },
      confirmation: "remove_account",
    })).rejects.toMatchObject({ code: "dependency_unavailable" });

    await mkdir(dirname(store.configurationPath), { recursive: true });
    await writeFile(store.configurationPath, "{not valid json", { mode: 0o600 });
    await expect(store.getSnapshot()).rejects.toBeInstanceOf(ProviderSettingsStoreError);
    await expect(store.getSnapshot()).rejects.toMatchObject({ code: "configuration_unavailable" });
    expect(await readFile(store.configurationPath, "utf8")).toBe("{not valid json");
  });
});
