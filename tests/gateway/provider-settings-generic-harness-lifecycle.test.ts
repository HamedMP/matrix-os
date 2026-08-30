import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiProviderSnapshotV3 } from "@matrix-os/contracts";
import { createProviderGenericHarnessCoordinator } from "../../packages/gateway/src/ai-providers/provider-generic-harness-coordinator.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import type { ProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

function genericCanonical(): AiProviderSnapshotV3 {
  const canonical = providerSettingsCanonicalFixture();
  canonical.drivers.push(
    {
      id: "hermes",
      displayName: "Hermes",
      kind: "cli",
      installState: "installed",
      health: "ready",
      capabilities: ["tools", "resume"],
      setupActions: [],
    },
    {
      id: "openclaw",
      displayName: "OpenClaw",
      kind: "cli",
      installState: "installed",
      health: "ready",
      capabilities: ["tools", "resume"],
      setupActions: [],
    },
    {
      id: "pi",
      displayName: "Pi",
      kind: "cli",
      installState: "installed",
      health: "ready",
      capabilities: ["tools", "resume"],
      setupActions: [],
    },
  );
  return canonical;
}

function config(
  harnesses: ProviderSettingsConfiguration["harnesses"],
): ProviderSettingsConfiguration {
  return {
    schemaVersion: 1,
    revision: 0,
    harnesses,
    accountProfiles: [],
    gatewayPolicy: null,
    receipts: [],
  };
}

const hermes = {
  id: "harness_hermes",
  driverId: "hermes",
  harness: "hermes" as const,
  displayName: "Hermes",
  accentColor: null,
  enabled: true,
  selectedAccountId: null,
  accessSourceId: "matrix_included",
  route: {
    kind: "configurable" as const,
    providerId: "anthropic",
    modelId: "claude-sonnet-5",
  },
};

describe("generic provider harness lifecycle coordinator", () => {
  let homePath: string | undefined;

  afterEach(async () => {
    if (homePath) await rm(homePath, { recursive: true, force: true });
    homePath = undefined;
  });

  async function makeCoordinator(options: {
    selected?: "hermes" | "openclaw";
    codingHarnesses?: Array<"pi" | "opencode">;
    inactiveOpenClawHealth?: "healthy" | "stopped" | "unknown";
    inactiveOpenClawInstallState?: "installed" | "missing";
  } = {}) {
    homePath = await mkdtemp(join(tmpdir(), "provider-generic-harness-"));
    await mkdir(join(homePath, "system"), { recursive: true });
    await writeFile(join(homePath, "system/config.json"), JSON.stringify({
      agent: { messagingRuntime: options.selected ?? "hermes", revision: 4 },
    }));
    const update = vi.fn(async (input) => ({
      revision: 5,
      runtime: input.runtime ?? "hermes",
      selection: {
        runtime: input.runtime ?? "hermes",
        provider: input.provider ?? null,
        model: input.messagingModel ?? null,
        configured: input.provider !== undefined,
      },
    }));
    const coordinator = createProviderGenericHarnessCoordinator({
      homePath,
      runtimeController: { update },
      runtimeSource: async () => ({
        runtime: {
          selected: options.selected ?? "hermes",
          options: [
            {
              id: "hermes",
              displayName: "Hermes",
              installState: "installed",
              health: "healthy",
              selectionState: options.selected === "openclaw" ? "available" : "active",
              configured: true,
              capabilities: ["provider_catalog", "model_selection"],
            },
            {
              id: "openclaw",
              displayName: "OpenClaw",
              installState: options.selected === "openclaw"
                ? "installed"
                : options.inactiveOpenClawInstallState ?? "installed",
              health: options.selected === "openclaw"
                ? "healthy"
                : options.inactiveOpenClawHealth ?? "healthy",
              selectionState: options.selected === "openclaw" ? "active" : "available",
              configured: true,
              capabilities: ["provider_catalog", "model_selection"],
            },
          ],
          transition: null,
        },
        providers: [],
        messaging: {
          runtime: options.selected ?? "hermes",
          provider: "anthropic",
          model: "claude-sonnet-5",
          configured: true,
        },
      }),
      enabledCodingHarnesses: options.codingHarnesses ?? ["pi"],
    });
    return { coordinator, update };
  }

  it("configures an enabled Hermes route through the existing runtime controller", async () => {
    const { coordinator, update } = await makeCoordinator();
    expect(coordinator.supportedActions).toEqual([
      "add_harness",
      "remove_harness",
      "update_harness",
      "set_harness_enabled",
      "set_route",
    ]);
    expect(coordinator.supportedHarnessKinds).toEqual([
      "hermes",
      "openclaw",
      "pi",
      "opencode",
    ]);
    const before = config([hermes]);
    const after = structuredClone(before);
    after.harnesses[0]!.route.modelId = "claude-opus-5";

    await coordinator.applyConfiguration({
      mutation: {
        type: "set_route",
        expectedRevision: 0,
        idempotencyKey: "route_hermes_1",
        harnessInstanceId: hermes.id,
        route: after.harnesses[0]!.route,
        accessSourceId: "owner_anthropic_profile",
        accountId: "owner_anthropic",
      },
      before,
      after,
      canonical: genericCanonical(),
      idempotencyKey: "route_hermes_1",
    });

    expect(update).toHaveBeenCalledWith({
      revision: 4,
      runtime: "hermes",
      provider: "anthropic",
      messagingModel: "claude-opus-5",
    });
  });

  it("switches to another enabled system harness before disabling the active one", async () => {
    const { coordinator, update } = await makeCoordinator();
    const openclaw = {
      ...hermes,
      id: "harness_openclaw",
      driverId: "openclaw",
      harness: "openclaw" as const,
      displayName: "OpenClaw",
      enabled: true,
    };
    const before = config([hermes, openclaw]);
    const after = structuredClone(before);
    after.harnesses[0]!.enabled = false;

    await coordinator.applyConfiguration({
      mutation: {
        type: "set_harness_enabled",
        expectedRevision: 0,
        idempotencyKey: "disable_hermes_1",
        harnessInstanceId: hermes.id,
        enabled: false,
      },
      before,
      after,
      canonical: genericCanonical(),
      idempotencyKey: "disable_hermes_1",
    });

    expect(update).toHaveBeenCalledWith({
      revision: 4,
      runtime: "openclaw",
      provider: "anthropic",
      messagingModel: "claude-sonnet-5",
    });
  });

  it("activates an installed OpenClaw runtime reported stopped and available", async () => {
    const { coordinator, update } = await makeCoordinator({ inactiveOpenClawHealth: "stopped" });
    const canonical = genericCanonical();
    canonical.drivers = canonical.drivers.map((driver) => driver.id === "openclaw"
      ? { ...driver, health: "stopped" as const }
      : driver);
    const openclaw = {
      ...hermes,
      id: "harness_openclaw",
      driverId: "openclaw",
      harness: "openclaw" as const,
      displayName: "OpenClaw",
      enabled: false,
    };

    await coordinator.applyConfiguration({
      mutation: {
        type: "set_harness_enabled",
        expectedRevision: 0,
        idempotencyKey: "activate_stopped_openclaw_1",
        harnessInstanceId: openclaw.id,
        enabled: true,
      },
      before: config([hermes, openclaw]),
      after: config([hermes, { ...openclaw, enabled: true }]),
      canonical,
      idempotencyKey: "activate_stopped_openclaw_1",
    });

    expect(update).toHaveBeenCalledWith({
      revision: 4,
      runtime: "openclaw",
      provider: "anthropic",
      messagingModel: "claude-sonnet-5",
    });
  });

  it.each([
    { inactiveOpenClawHealth: "unknown" as const },
    { inactiveOpenClawInstallState: "missing" as const },
  ])("fails closed an invalid OpenClaw activation target %#", async (runtimeState) => {
    const { coordinator, update } = await makeCoordinator(runtimeState);
    const openclaw = {
      ...hermes,
      id: "harness_openclaw",
      driverId: "openclaw",
      harness: "openclaw" as const,
      enabled: false,
    };

    await expect(coordinator.applyConfiguration({
      mutation: {
        type: "set_harness_enabled",
        expectedRevision: 0,
        idempotencyKey: "reject_invalid_openclaw_1",
        harnessInstanceId: openclaw.id,
        enabled: true,
      },
      before: config([hermes, openclaw]),
      after: config([hermes, { ...openclaw, enabled: true }]),
      canonical: genericCanonical(),
      idempotencyKey: "reject_invalid_openclaw_1",
    })).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(update).not.toHaveBeenCalled();
  });

  it("fails closed for unregistered coding drivers and specialized Claude/Codex harnesses", async () => {
    const { coordinator, update } = await makeCoordinator({ codingHarnesses: [] });
    const before = config([]);
    const pi = { ...hermes, id: "harness_pi", driverId: "pi", harness: "pi" as const, enabled: false };
    const after = config([pi]);

    await expect(coordinator.applyConfiguration({
      mutation: {
        type: "add_harness",
        expectedRevision: 0,
        idempotencyKey: "add_pi_unsupported_1",
        harness: "pi",
        displayName: "Pi",
        route: pi.route,
        accessSourceId: "matrix_included",
        accountId: null,
      },
      before,
      after,
      canonical: genericCanonical(),
      idempotencyKey: "add_pi_unsupported_1",
    })).rejects.toMatchObject({ code: "runtime_unavailable" });

    const specialized = config([{ ...hermes, id: "harness_codex", driverId: "codex", harness: "codex" as const }]);
    await expect(coordinator.applyConfiguration({
      mutation: {
        type: "update_harness",
        expectedRevision: 0,
        idempotencyKey: "rename_codex_1",
        harnessInstanceId: "harness_codex",
        displayName: "Other Codex",
      },
      before: specialized,
      after: specialized,
      canonical: genericCanonical(),
      idempotencyKey: "rename_codex_1",
    })).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(update).not.toHaveBeenCalled();
  });

  it("removes only a disabled generic settings instance and durably deduplicates retries", async () => {
    const { coordinator, update } = await makeCoordinator({ codingHarnesses: ["pi"] });
    const disabledPi = { ...hermes, id: "harness_pi", driverId: "pi", harness: "pi" as const, enabled: false };
    const before = config([disabledPi]);
    const after = config([]);
    const input = {
      mutation: {
        type: "remove_harness" as const,
        expectedRevision: 0,
        idempotencyKey: "remove_pi_1",
        harnessInstanceId: disabledPi.id,
        confirmation: "remove_harness" as const,
      },
      before,
      after,
      canonical: genericCanonical(),
      idempotencyKey: "remove_pi_1",
    };

    await coordinator.applyConfiguration(input);
    await coordinator.applyConfiguration(input);
    expect(update).not.toHaveBeenCalled();
    const receipts = JSON.parse(await readFile(
      join(homePath!, "system/ai-providers/runtime-receipts.json"),
      "utf8",
    ));
    expect(receipts.receipts).toHaveLength(1);

    await expect(coordinator.applyConfiguration({
      ...input,
      mutation: { ...input.mutation, idempotencyKey: "remove_pi_enabled_1" },
      idempotencyKey: "remove_pi_enabled_1",
      before: config([{ ...disabledPi, enabled: true }]),
    })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("allows local cleanup of disabled or non-active generic settings after runtime loss", async () => {
    const { coordinator, update } = await makeCoordinator({ codingHarnesses: [] });
    const unavailableCanonical = genericCanonical();
    unavailableCanonical.drivers = unavailableCanonical.drivers.map((driver) =>
      driver.id === "pi" || driver.id === "openclaw"
        ? { ...driver, health: "unavailable" as const }
        : driver,
    );
    const disabledPi = { ...hermes, id: "harness_pi", driverId: "pi", harness: "pi" as const, enabled: false };

    await coordinator.applyConfiguration({
      mutation: {
        type: "remove_harness",
        expectedRevision: 0,
        idempotencyKey: "remove_unavailable_pi_1",
        harnessInstanceId: disabledPi.id,
        confirmation: "remove_harness",
      },
      before: config([disabledPi]),
      after: config([]),
      canonical: unavailableCanonical,
      idempotencyKey: "remove_unavailable_pi_1",
    });

    const inactiveOpenClaw = {
      ...hermes,
      id: "harness_openclaw",
      driverId: "openclaw",
      harness: "openclaw" as const,
      enabled: true,
    };
    await coordinator.applyConfiguration({
      mutation: {
        type: "set_harness_enabled",
        expectedRevision: 0,
        idempotencyKey: "disable_unavailable_openclaw_1",
        harnessInstanceId: inactiveOpenClaw.id,
        enabled: false,
      },
      before: config([hermes, inactiveOpenClaw]),
      after: config([hermes, { ...inactiveOpenClaw, enabled: false }]),
      canonical: unavailableCanonical,
      idempotencyKey: "disable_unavailable_openclaw_1",
    });

    expect(update).not.toHaveBeenCalled();
  });

  it("runs add, enable, disable, and remove through the real settings store without touching binaries", async () => {
    const { coordinator, update } = await makeCoordinator({ codingHarnesses: ["pi"] });
    const canonical = genericCanonical();
    let nextId = 0;
    const store = new ProviderSettingsStore({
      homePath: homePath!,
      providerSnapshotReader: {
        getSnapshot: async () => structuredClone(canonical),
      },
      runtimeCoordinator: coordinator,
      now: () => new Date(canonical.refreshedAt),
      idGenerator: () => `generic_${++nextId}`,
    });

    let result = await store.mutate({
      type: "add_harness",
      expectedRevision: 0,
      idempotencyKey: "store_add_pi_1",
      harness: "pi",
      displayName: "Pi",
      route: { kind: "configurable", providerId: "anthropic", modelId: "claude-sonnet-5" },
      accessSourceId: "matrix_included",
      accountId: null,
    });
    const pi = result.snapshot.harnesses.find((harness) => harness.harness === "pi")!;
    expect(pi).toMatchObject({ enabled: false, installState: "installed" });

    result = await store.mutate({
      type: "set_harness_enabled",
      expectedRevision: result.snapshot.revision,
      idempotencyKey: "store_enable_pi_1",
      harnessInstanceId: pi.id,
      enabled: true,
    });
    expect(result.snapshot.harnesses.find((harness) => harness.id === pi.id)?.enabled).toBe(true);

    await expect(store.mutate({
      type: "remove_harness",
      expectedRevision: result.snapshot.revision,
      idempotencyKey: "store_remove_enabled_pi_1",
      harnessInstanceId: pi.id,
      confirmation: "remove_harness",
    })).rejects.toMatchObject({ code: "invalid_request" });

    result = await store.mutate({
      type: "set_harness_enabled",
      expectedRevision: result.snapshot.revision,
      idempotencyKey: "store_disable_pi_1",
      harnessInstanceId: pi.id,
      enabled: false,
    });
    result = await store.mutate({
      type: "remove_harness",
      expectedRevision: result.snapshot.revision,
      idempotencyKey: "store_remove_pi_1",
      harnessInstanceId: pi.id,
      confirmation: "remove_harness",
    });
    expect(result.snapshot.harnesses.some((harness) => harness.id === pi.id)).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});
