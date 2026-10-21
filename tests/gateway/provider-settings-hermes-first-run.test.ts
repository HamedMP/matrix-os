import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderSettingsMutationSchema, type AgentSettingsUpdate, type AiProviderSnapshotV3 } from "@matrix-os/contracts";
import { AgentConfigError } from "../../packages/gateway/src/agent-config/errors.js";
import type { AgentRuntimeSettingsSnapshot } from "../../packages/gateway/src/agent-config/service.js";
import { createProviderGenericHarnessCoordinator } from "../../packages/gateway/src/ai-providers/provider-generic-harness-coordinator.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createProviderSettingsRoutes } from "../../packages/gateway/src/ai-providers/provider-settings-routes.js";
import { writeProviderJsonAtomic } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import {
  providerSettingsCanonicalFixture,
  providerSettingsFundingSummaryFixture,
} from "./provider-settings-test-support.js";

type Route = { provider: string; model: string } | null;

function firstRunCanonical(): AiProviderSnapshotV3 {
  const canonical = providerSettingsCanonicalFixture();
  const ownerSource = canonical.accessSources.find((source) => source.id === "owner_anthropic_profile")!;
  ownerSource.id = "owner_anthropic_key";
  ownerSource.displayName = "Anthropic API key";
  ownerSource.fundingKind = "owner_api_key";
  canonical.accounts[0]!.authMethod = "api_key";
  for (const instance of canonical.instances) {
    if (instance.accessSourceId === "owner_anthropic_profile") instance.accessSourceId = "owner_anthropic_key";
  }
  for (const model of canonical.models) {
    model.eligibleAccessSourceIds = model.eligibleAccessSourceIds.map((id) =>
      id === "owner_anthropic_profile" ? "owner_anthropic_key" : id);
    for (const policy of model.dataPolicies) {
      if (policy.accessSourceId === "owner_anthropic_profile") policy.accessSourceId = "owner_anthropic_key";
    }
  }
  canonical.drivers.push({
    id: "hermes",
    displayName: "Hermes",
    kind: "cli",
    installState: "installed",
    health: "ready",
    capabilities: ["tools", "resume"],
    setupActions: [],
  });
  return canonical;
}

describe("Hermes enablement for a first-run owner", () => {
  let homePath: string | undefined;

  afterEach(async () => {
    if (homePath) await rm(homePath, { recursive: true, force: true });
    homePath = undefined;
  });

  async function setup(options: {
    initialRoute?: Route;
    runtimeCatalog?: string[];
    routeObserved?: boolean;
    updateError?: AgentConfigError;
  } = {}) {
    homePath = await mkdtemp(join(tmpdir(), "provider-hermes-first-run-"));
    await mkdir(join(homePath, "system"), { recursive: true });
    let revision = 0;
    // A first-run owner has no agent section and no Hermes model selection.
    await writeFile(join(homePath, "system/config.json"), JSON.stringify({}));
    let route: Route = options.initialRoute ?? null;
    const catalog = new Set(options.runtimeCatalog ?? ["claude-opus-5"]);
    const update = vi.fn(async (input: AgentSettingsUpdate) => {
      if (input.revision !== revision) throw new AgentConfigError("agent_config_conflict");
      if (options.updateError) throw options.updateError;
      // Mirrors the Hermes adapter: only models in the live runtime catalog are accepted.
      if (!input.provider || !input.messagingModel || !catalog.has(input.messagingModel)) {
        throw new AgentConfigError("not_configured");
      }
      route = { provider: input.provider, model: input.messagingModel };
      revision += 1;
      await writeFile(join(homePath!, "system/config.json"), JSON.stringify({
        agent: { messagingRuntime: "hermes", revision },
      }));
      return {
        revision,
        runtime: "hermes" as const,
        selection: { runtime: "hermes" as const, provider: route.provider, model: route.model, configured: true },
      };
    });
    const runtimeSource = async (): Promise<AgentRuntimeSettingsSnapshot> => ({
      runtime: {
        selected: "hermes",
        options: [
          {
            id: "hermes",
            displayName: "Hermes",
            installState: "installed",
            health: "healthy",
            selectionState: "active",
            configured: route !== null,
            capabilities: ["provider_catalog", "model_selection"],
          },
          {
            id: "openclaw",
            displayName: "OpenClaw",
            installState: "missing",
            health: "stopped",
            selectionState: "unavailable",
            configured: false,
            capabilities: ["install"],
            setupAction: "install",
          },
        ],
        transition: null,
      },
      providers: [],
      messaging: {
        runtime: "hermes",
        provider: route?.provider ?? null,
        model: route?.model ?? null,
        configured: route !== null,
      },
      messagingObserved: options.routeObserved ?? true,
    });
    const createCoordinator = () => createProviderGenericHarnessCoordinator({
      homePath: homePath!,
      runtimeController: { update },
      runtimeSource,
      enabledCodingHarnesses: [],
    });
    const coordinator = createCoordinator();
    const canonical = firstRunCanonical();
    const store = new ProviderSettingsStore({
      homePath,
      providerSnapshotReader: { getSnapshot: async () => structuredClone(canonical) },
      runtimeCoordinator: coordinator,
      fundingSummaryReader: {
        getFundingSummary: async () => providerSettingsFundingSummaryFixture(),
      },
      now: () => new Date(canonical.refreshedAt),
      idGenerator: () => "first_run",
    });
    return {
      coordinator,
      createCoordinator,
      store,
      update,
      currentRoute: () => route,
      receiptsPath: join(homePath, "system/ai-providers/runtime-receipts.json"),
    };
  }

  async function selectDisabledHermesRoute(store: ProviderSettingsStore, modelId: string) {
    const initial = await store.getSnapshot();
    const hermes = initial.harnesses.find((harness) => harness.harness === "hermes");
    expect(hermes).toMatchObject({ enabled: false });
    const ownerKey = initial.accessSources.find((source) => source.id === "owner_anthropic_key");
    expect(ownerKey).toMatchObject({ kind: "provider_account", accountId: "owner_anthropic" });
    const routed = await store.mutate({
      type: "set_route",
      expectedRevision: initial.revision,
      idempotencyKey: "first_run_route",
      harnessInstanceId: hermes!.id,
      route: { kind: "configurable", providerId: "anthropic", modelId },
      accessSourceId: "owner_anthropic_key",
      accountId: "owner_anthropic",
    });
    expect(routed.snapshot.harnesses.find((harness) => harness.id === hermes!.id)).toMatchObject({
      enabled: false,
      accessSourceId: "owner_anthropic_key",
      route: { providerId: "anthropic", modelId },
    });
    return { hermesId: hermes!.id, revision: routed.snapshot.revision };
  }

  function enableMutation(hermesId: string, revision: number, idempotencyKey = "first_run_enable") {
    return {
      type: "set_harness_enabled" as const,
      expectedRevision: revision,
      idempotencyKey,
      harnessInstanceId: hermesId,
      enabled: true,
    };
  }

  it("rejects source-less Hermes enable before changing the route or owner settings", async () => {
    const { store, update, currentRoute } = await setup();
    await writeProviderJsonAtomic(store.configurationPath, {
      schemaVersion: 1, revision: 0, accountProfiles: [], gatewayPolicy: null, receipts: [],
      harnesses: [{ id: "harness_hermes", driverId: "hermes", harness: "hermes", displayName: "Hermes",
        accentColor: null, enabled: false, enablementOrigin: "owner_configuration", selectedAccountId: null,
        accessSourceId: null, route: { kind: "configurable", providerId: "anthropic", modelId: "claude-fable-5" } }],
    });
    const before = await store.getSnapshot();
    const hermes = before.harnesses.find(harness => harness.harness === "hermes")!;
    expect(hermes).toMatchObject({ enabled: false, accessSourceId: null });
    await expect(store.mutate(enableMutation(hermes.id, before.revision))).rejects.toMatchObject({
      code: "invalid_route", status: 400,
    });
    const app = createProviderSettingsRoutes({ store, getPrincipal: () => ({ userId: "fixture-owner" }) });
    const response = await app.request("/provider-settings/actions?includeCapabilities=true&includeModelCapabilities=true", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ProviderSettingsMutationSchema.parse(enableMutation(hermes.id, before.revision, "0367981b-c1b2-4fda-85b8-6e5c48eee891"))),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "Invalid provider settings request." } });
    expect(update).not.toHaveBeenCalled();
    expect(currentRoute()).toBeNull();
    const after = await store.getSnapshot();
    expect(after.revision).toBe(before.revision);
    expect(after.harnesses.find(harness => harness.id === hermes.id)).toEqual(hermes);
  });

  it("enables Hermes with the selected route when the runtime has no messaging route yet", async () => {
    const { store, update, currentRoute, receiptsPath } = await setup();
    const { hermesId, revision } = await selectDisabledHermesRoute(store, "claude-opus-5");
    expect(update).not.toHaveBeenCalled();

    const enabled = await store.mutate(enableMutation(hermesId, revision));

    expect(enabled.snapshot.revision).toBe(revision + 1);
    expect(enabled.snapshot.harnesses.find((harness) => harness.id === hermesId)).toMatchObject({
      enabled: true,
      route: { providerId: "anthropic", modelId: "claude-opus-5" },
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      revision: 0,
      runtime: "hermes",
      provider: "anthropic",
      messagingModel: "claude-opus-5",
    });
    expect(currentRoute()).toEqual({ provider: "anthropic", model: "claude-opus-5" });
    const receipts = JSON.parse(await readFile(receiptsPath, "utf8"));
    expect(receipts.receipts).toEqual([expect.objectContaining({
      key: "first_run_enable",
      state: "applied",
      beforeRoute: { harness: "hermes", providerId: null, modelId: null },
      afterRoute: { harness: "hermes", providerId: "anthropic", modelId: "claude-opus-5" },
      beforeRevision: 0,
      afterRevision: 1,
    })]);
  });

  it("refuses a route the runtime catalog rejects without leaving a pending runtime receipt", async () => {
    const { store, coordinator, update, currentRoute, receiptsPath } = await setup({ runtimeCatalog: [] });
    const { hermesId, revision } = await selectDisabledHermesRoute(store, "claude-opus-5");

    await expect(store.mutate(enableMutation(hermesId, revision))).rejects.toMatchObject({
      code: "invalid_route",
      status: 400,
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(currentRoute()).toBeNull();
    expect(coordinator.isRecoveryReady()).toBe(true);
    expect(JSON.parse(await readFile(receiptsPath, "utf8")).receipts).toEqual([]);
    const after = await store.getSnapshot();
    expect(after.revision).toBe(revision);
    expect(after.harnesses.find((harness) => harness.id === hermesId)?.enabled).toBe(false);
  });

  it("fails closed when the runtime cannot prove that its messaging route is empty", async () => {
    const { store, coordinator, update, receiptsPath } = await setup({ routeObserved: false });
    const { hermesId, revision } = await selectDisabledHermesRoute(store, "claude-opus-5");

    await expect(store.mutate(enableMutation(hermesId, revision))).rejects.toMatchObject({
      code: "runtime_unavailable",
      status: 503,
    });

    expect(update).not.toHaveBeenCalled();
    expect(coordinator.isRecoveryReady()).toBe(true);
    // The route is read before a prepared receipt is written, so none remains.
    expect(JSON.parse(await readFile(receiptsPath, "utf8")).receipts)
      .not.toContainEqual(expect.objectContaining({ key: "first_run_enable" }));
    expect((await store.getSnapshot()).harnesses.find((harness) => harness.id === hermesId)?.enabled).toBe(false);
  });

  it("does not report runtime configuration failures as route refusals", async () => {
    const { store, update, receiptsPath } = await setup({
      updateError: new AgentConfigError("agent_config_invalid"),
    });
    const { hermesId, revision } = await selectDisabledHermesRoute(store, "claude-opus-5");

    await expect(store.mutate(enableMutation(hermesId, revision))).rejects.toMatchObject({
      code: "runtime_unavailable",
      status: 503,
    });

    expect(update).toHaveBeenCalledTimes(1);
    // The runtime state is uncertain, so the prepared receipt stays for recovery.
    expect(JSON.parse(await readFile(receiptsPath, "utf8")).receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "first_run_enable", state: "prepared" }),
    ]));
  });

  it("rolls back a first-run enable without inventing a prior runtime route", async () => {
    const { coordinator, store, update, receiptsPath } = await setup();
    const { hermesId, revision } = await selectDisabledHermesRoute(store, "claude-opus-5");
    const before = JSON.parse(await readFile(join(homePath!, "system/ai-providers/settings.json"), "utf8"));
    const after = structuredClone(before);
    after.harnesses.find((harness: { id: string }) => harness.id === hermesId).enabled = true;
    const input = {
      mutation: enableMutation(hermesId, revision, "first_run_rollback"),
      idempotencyKey: "first_run_rollback",
      before,
      after,
      canonical: firstRunCanonical(),
      snapshot: await store.getSnapshot(),
    };

    await coordinator.applyConfiguration(input);
    expect(update).toHaveBeenCalledTimes(1);
    await coordinator.rollbackConfiguration(input);

    // An unset route has no Agent settings representation, so rollback must
    // neither fabricate a fallback route nor block later mutations on it.
    expect(update).toHaveBeenCalledTimes(1);
    expect(coordinator.isRecoveryReady()).toBe(true);
    expect(JSON.parse(await readFile(receiptsPath, "utf8")).receipts).toEqual([]);
    const enabled = await store.mutate(enableMutation(hermesId, revision, "first_run_retry"));
    expect(enabled.snapshot.harnesses.find((harness) => harness.id === hermesId)?.enabled).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("retires a crashed first-run prepared receipt at startup without replaying an unset route", async () => {
    const { createCoordinator, update, receiptsPath } = await setup({
      initialRoute: { provider: "anthropic", model: "claude-opus-5" },
    });
    await mkdir(join(homePath!, "system/ai-providers"), { recursive: true });
    await writeProviderJsonAtomic(receiptsPath, {
      version: 1,
      receipts: [{
        key: "first_run_crashed",
        payloadHash: "a".repeat(64),
        state: "prepared",
        beforeRoute: { harness: "hermes", providerId: null, modelId: null },
        afterRoute: { harness: "hermes", providerId: "anthropic", modelId: "claude-opus-5" },
        beforeRevision: 0,
      }],
    });

    const restarted = createCoordinator();
    await restarted.reconcilePending();

    expect(update).not.toHaveBeenCalled();
    expect(restarted.isRecoveryReady()).toBe(true);
    expect(JSON.parse(await readFile(receiptsPath, "utf8")).receipts).toEqual([]);
  });

  it("records and restores a managed Workers AI route as the rollback target", async () => {
    const managed = { provider: "cloudflare", model: "@cf/zai-org/glm-5.3-flash" };
    const { coordinator, store, update, currentRoute } = await setup({
      initialRoute: managed,
      runtimeCatalog: ["claude-opus-5", managed.model],
    });
    const { hermesId, revision } = await selectDisabledHermesRoute(store, "claude-opus-5");
    const before = JSON.parse(await readFile(join(homePath!, "system/ai-providers/settings.json"), "utf8"));
    const after = structuredClone(before);
    after.harnesses.find((harness: { id: string }) => harness.id === hermesId).enabled = true;
    const input = {
      mutation: enableMutation(hermesId, revision, "managed_rollback"),
      idempotencyKey: "managed_rollback",
      before,
      after,
      canonical: firstRunCanonical(),
      snapshot: await store.getSnapshot(),
    };

    await coordinator.applyConfiguration(input);
    expect(currentRoute()).toEqual({ provider: "anthropic", model: "claude-opus-5" });
    await coordinator.rollbackConfiguration(input);

    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: managed.provider,
      messagingModel: managed.model,
    }));
    expect(currentRoute()).toEqual(managed);
  });
});
