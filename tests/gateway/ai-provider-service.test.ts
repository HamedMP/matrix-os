import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiProviderSnapshotV3Schema, type AiProviderSnapshotV3 } from "@matrix-os/contracts";
import {
  AiProviderService,
  type AiProviderHealthProbe,
} from "../../packages/gateway/src/ai-providers/service.js";

const NOW = new Date("2026-08-29T21:00:00.000Z");

describe("AiProviderService", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "ai-provider-service-"));
    await mkdir(join(homePath, "system"), { recursive: true });
  });

  afterEach(async () => {
    await rm(homePath, { recursive: true, force: true });
  });

  function createService(options: {
    platformKey?: string;
    fundedEnabled?: boolean;
    healthProbe?: AiProviderHealthProbe;
    healthTimeoutMs?: number;
    driverInventory?: () => Promise<AiProviderSnapshotV3["drivers"]>;
  } = {}) {
    return new AiProviderService({
      homePath,
      env: options.platformKey ? {
        ANTHROPIC_API_KEY: options.platformKey,
        MATRIX_FUNDED_AI_ENABLED: options.fundedEnabled === false ? "0" : "1",
      } : {},
      now: () => NOW,
      healthProbe: options.healthProbe,
      healthTimeoutMs: options.healthTimeoutMs,
      driverInventory: options.driverInventory === undefined
        ? undefined
        : async () => options.driverInventory!(),
    });
  }

  it("projects Matrix-funded readiness independently from disconnected owner accounts", async () => {
    const service = createService({ platformKey: "platform-secret" });
    const snapshot = await service.getSnapshot();

    expect(AiProviderSnapshotV3Schema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.accessSources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "matrix_included",
        fundingKind: "matrix_included",
        state: "ready",
        eligibleModelIds: ["claude-sonnet-5"],
      }),
    ]));
    expect(snapshot.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "owner_anthropic", state: "setup_required", authMethod: null }),
      expect.objectContaining({ id: "owner_openrouter", state: "setup_required", authMethod: null }),
    ]));
    expect(snapshot.drivers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "kernel", kind: "agent_sdk", health: "ready" }),
    ]));
    expect(snapshot.active).toEqual({
      providerInstanceId: "kernel_matrix_included",
      accessSourceId: "matrix_included",
      modelId: "claude-sonnet-5",
    });
    expect(JSON.stringify(snapshot)).not.toContain("platform-secret");
  });

  it("adds only validated real driver inventory while keeping the kernel driver canonical", async () => {
    const snapshot = await createService({
      driverInventory: async () => [{
        id: "codex",
        displayName: "Codex",
        kind: "cli",
        installState: "installed",
        health: "ready",
        capabilities: ["tools", "resume", "project_context"],
        setupActions: ["connect_account", "open_terminal"],
      }],
    }).getSnapshot();
    expect(snapshot.drivers.map((driver) => driver.id)).toEqual(["kernel", "codex"]);
    expect(AiProviderSnapshotV3Schema.safeParse(snapshot).success).toBe(true);
  });

  it("does not label a legacy platform key as Matrix-funded access", async () => {
    const snapshot = await createService({
      platformKey: "legacy-platform-secret",
      fundedEnabled: false,
    }).getSnapshot();

    expect(snapshot.accessSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "matrix_included", state: "disabled" }),
    ]));
    expect(snapshot.instances).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "kernel_matrix_included", readiness: { state: "ready" } }),
    ]));
    expect(snapshot.active).toEqual({
      providerInstanceId: null,
      accessSourceId: null,
      modelId: null,
    });
  });

  it("does not silently fall back to Matrix funding when an owner source is explicitly selected", async () => {
    await writeFile(
      join(homePath, "system/config.json"),
      JSON.stringify({ kernel: { anthropicApiKey: "owner-secret" } }),
    );
    const snapshot = await createService({ platformKey: "platform-secret" }).getSnapshot();

    expect(snapshot.accessSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "owner_anthropic_key", state: "unknown" }),
      expect.objectContaining({ id: "matrix_included", state: "ready" }),
    ]));
    expect(snapshot.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "owner_anthropic", authMethod: "api_key", state: "unknown" }),
    ]));
    expect(snapshot.active).toEqual({
      providerInstanceId: null,
      accessSourceId: null,
      modelId: null,
    });
    expect(JSON.stringify(snapshot)).not.toContain("owner-secret");
  });

  it("uses a verified owner source and retains an explicitly saved legacy model", async () => {
    await writeFile(
      join(homePath, "system/config.json"),
      JSON.stringify({ kernel: { anthropicApiKey: "owner-secret", model: "claude-sonnet-4-5" } }),
    );
    const healthProbe: AiProviderHealthProbe = async (sourceId) => sourceId === "owner_anthropic_key"
      ? {
          state: "ready",
          checkedAt: NOW.toISOString(),
          staleAfter: "2026-08-29T21:05:00.000Z",
          action: "none",
          safeReason: null,
        }
      : null;

    const snapshot = await createService({ platformKey: "platform-secret", healthProbe }).getSnapshot({ refresh: true });
    const ownerInstance = snapshot.instances.find((instance) => instance.id === "kernel_owner_anthropic_key");

    expect(ownerInstance).toMatchObject({
      readiness: { state: "ready" },
      defaultModelId: "claude-sonnet-4-5",
    });
    expect(ownerInstance?.modelIds).toEqual(expect.arrayContaining([
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "claude-sonnet-4-5",
    ]));
    expect(snapshot.active).toEqual({
      providerInstanceId: "kernel_owner_anthropic_key",
      accessSourceId: "owner_anthropic_key",
      modelId: "claude-sonnet-4-5",
    });
    expect(snapshot.models.find((model) => model.id === "claude-sonnet-5")?.dataPolicies)
      .toEqual(expect.arrayContaining([
        {
          accessSourceId: "matrix_included",
          route: "matrix_relay",
          disclosureKey: "matrix-cloudflare-anthropic",
        },
        {
          accessSourceId: "owner_anthropic_key",
          route: "owner_direct",
          disclosureKey: "owner-direct-anthropic",
        },
      ]));
  });

  it("makes Fable selectable through verified owner Anthropic access", async () => {
    await writeFile(
      join(homePath, "system/config.json"),
      JSON.stringify({ kernel: { anthropicApiKey: "owner-secret", model: "claude-fable-5" } }),
    );
    const healthProbe: AiProviderHealthProbe = async (sourceId) => sourceId === "owner_anthropic_key"
      ? {
          state: "ready",
          checkedAt: NOW.toISOString(),
          staleAfter: "2026-08-29T21:05:00.000Z",
          action: "none",
          safeReason: null,
        }
      : null;

    const snapshot = await createService({ healthProbe }).getSnapshot({ refresh: true });

    expect(snapshot.accessSources.find((source) => source.id === "owner_anthropic_key")?.eligibleModelIds)
      .toContain("claude-fable-5");
    expect(snapshot.models.find((model) => model.id === "claude-fable-5")).toMatchObject({
      eligibleAccessSourceIds: ["owner_anthropic_key", "owner_anthropic_profile"],
      dataPolicies: [{
        accessSourceId: "owner_anthropic_key",
        route: "owner_direct",
        disclosureKey: "owner-direct-anthropic",
      }, {
        accessSourceId: "owner_anthropic_profile",
        route: "owner_direct",
        disclosureKey: "owner-direct-anthropic",
      }],
    });
    expect(snapshot.active).toEqual({
      providerInstanceId: "kernel_owner_anthropic_key",
      accessSourceId: "owner_anthropic_key",
      modelId: "claude-fable-5",
    });
  });

  it("does not silently replace a saved Fable route when Matrix policy excludes it", async () => {
    await writeFile(
      join(homePath, "system/config.json"),
      JSON.stringify({ kernel: { model: "claude-fable-5" } }),
    );

    const snapshot = await createService({ platformKey: "platform-secret" }).getSnapshot();
    const matrixInstance = snapshot.instances.find((instance) => instance.id === "kernel_matrix_included");

    expect(snapshot.accessSources.find((source) => source.id === "matrix_included")?.eligibleModelIds)
      .not.toContain("claude-fable-5");
    expect(matrixInstance?.defaultModelId).toBeNull();
    expect(snapshot.active).toEqual({
      providerInstanceId: null,
      accessSourceId: null,
      modelId: null,
    });
  });

  it("enforces the readiness deadline when a probe ignores its abort signal", async () => {
    await writeFile(
      join(homePath, "system/config.json"),
      JSON.stringify({ kernel: { anthropicApiKey: "owner-secret" } }),
    );
    let probeSignal: AbortSignal | null = null;
    const service = createService({
      healthTimeoutMs: 5,
      healthProbe: async (sourceId, signal) => {
        if (sourceId !== "owner_anthropic_key") return null;
        probeSignal = signal;
        return await new Promise(() => {});
      },
    });

    const pending = service.getSnapshot({ refresh: true });
    const snapshot = await pending;

    expect(probeSignal?.aborted).toBe(true);
    expect(snapshot.accessSources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "owner_anthropic_key",
        state: "unavailable",
        safeReason: "timeout",
      }),
    ]));
    service.close();
  });

  it("projects disabled Matrix access and unavailable owner credential reads safely", async () => {
    await mkdir(join(homePath, "system/config.json"));
    const snapshot = await createService().getSnapshot();

    expect(snapshot.accessSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "matrix_included", state: "disabled" }),
      expect.objectContaining({ id: "owner_anthropic_key", state: "unavailable" }),
    ]));
    expect(snapshot.active.modelId).toBeNull();
  });

  it("reuses bounded health results until refresh is requested", async () => {
    await writeFile(
      join(homePath, "system/config.json"),
      JSON.stringify({ kernel: { anthropicApiKey: "owner-secret" } }),
    );
    let calls = 0;
    const healthProbe: AiProviderHealthProbe = async () => {
      calls += 1;
      return {
        state: "stale",
        checkedAt: NOW.toISOString(),
        staleAfter: NOW.toISOString(),
        action: "retry",
        safeReason: "timeout",
      };
    };
    const service = createService({ healthProbe });

    expect((await service.getSnapshot()).instances.find((value) => value.id === "kernel_owner_anthropic_key")?.readiness.state).toBe("stale");
    await service.getSnapshot();
    expect(calls).toBe(1);
    await service.getSnapshot({ refresh: true });
    expect(calls).toBe(2);
    service.close();
  });
});
