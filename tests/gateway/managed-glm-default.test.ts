import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiProviderSnapshotV3Schema } from "@matrix-os/contracts";
import { buildBundledModelCatalog } from "../../packages/gateway/src/ai-providers/model-catalog.js";
import { initialProviderSettingsConfiguration, readProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";
import { projectProviderSettings } from "../../packages/gateway/src/ai-providers/provider-settings-projector.js";

const glm = "@cf/zai-org/glm-5.3-flash";
function fixture() {
  const snapshot = providerSettingsCanonicalFixture();
  snapshot.models = buildBundledModelCatalog();
  snapshot.accessSources.push({ ...snapshot.accessSources[0]!, id: "matrix_cloudflare", vendor: "cloudflare", eligibleModelIds: [glm] });
  const sourceIds = new Set(snapshot.accessSources.map((source) => source.id));
  snapshot.models = snapshot.models.map((model) => ({ ...model,
    eligibleAccessSourceIds: model.eligibleAccessSourceIds.filter((id) => sourceIds.has(id)),
    dataPolicies: model.dataPolicies.filter((policy) => sourceIds.has(policy.accessSourceId)),
  }));
  snapshot.drivers.push(...(["pi", "opencode"] as const).map((id) => ({ ...snapshot.drivers[1]!, id, displayName: id })));
  return snapshot;
}

describe("managed GLM defaults", () => {
  it("publishes Cloudflare GLM with Matrix access in V3", () => {
    const snapshot = fixture();
    expect(snapshot.models.find((model) => model.id === glm)).toMatchObject({
      vendor: "cloudflare", displayName: "GLM 5.3 Flash", eligibleAccessSourceIds: ["matrix_cloudflare"],
    });
    expect(AiProviderSnapshotV3Schema.safeParse(snapshot).success).toBe(true);
  });
  it("defaults generic harnesses to GLM without changing Claude's Anthropic model", () => {
    const config = initialProviderSettingsConfiguration(fixture());
    for (const harness of ["pi", "opencode"]) {
      expect(config.harnesses.find((item) => item.harness === harness)?.route)
        .toEqual({ kind: "configurable", providerId: "cloudflare", modelId: glm });
    }
    expect(config.harnesses.find((item) => item.harness === "claude")?.route.providerId).toBe("anthropic");
  });
  it("projects both managed serving providers under one gateway policy", async () => {
    const canonical = fixture();
    const config = initialProviderSettingsConfiguration(canonical);
    const snapshot = await projectProviderSettings({ canonical, config, supportedActions: [], now: new Date("2026-08-30T10:00:00.000Z") });
    expect(snapshot.gatewayPolicy?.allowedModelIds).toEqual(expect.arrayContaining([glm, "claude-sonnet-5"]));
    expect(snapshot.modelProviders.find((provider) => provider.id === "cloudflare")?.displayName).toBe("Cloudflare Workers AI");
  });
  it("preserves an explicit saved generic route during reconciliation", async () => {
    const canonical = fixture();
    const config = initialProviderSettingsConfiguration(canonical);
    const pi = config.harnesses.find((item) => item.harness === "pi")!;
    pi.route = { kind: "configurable", providerId: "anthropic", modelId: "claude-sonnet-5" };
    pi.accessSourceId = "matrix_included";
    const directory = await mkdtemp(join(tmpdir(), "managed-glm-selection-"));
    try {
      const path = join(directory, "providers.json");
      await writeFile(path, JSON.stringify(config), { mode: 0o600 });
      expect((await readProviderSettingsConfiguration(path, canonical)).harnesses.find((item) => item.harness === "pi")?.route).toEqual(pi.route);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
