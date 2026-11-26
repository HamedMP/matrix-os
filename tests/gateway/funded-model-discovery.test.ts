import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AiModelDescriptorViewSchema, FUNDED_PRICING_CATALOG, MANAGED_WORKERS_AI_MODEL_IDS,
  isManagedFundedOpenAiModel, retiredManagedWorkersAiModel, type AiProviderReadiness,
} from "@matrix-os/contracts";
import { buildBundledModelCatalog } from "../../packages/gateway/src/ai-providers/model-catalog.js";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { managedPiChatInstances } from "../../packages/gateway/src/chat/managed-chat-catalog.js";
import { resolveManagedPiRoute } from "../../packages/gateway/src/bots/route-resolver.js";
import { applyCanonicalComposerPreference, createCanonicalComposerSelection } from "../../packages/ui/src/canonical-composer-selection.js";
import { deriveCanonicalProviderChoices } from "../../packages/ui/src/canonical-provider-choice.js";
import { chatPickerModelAvailabilityLabel, deriveChatPickerModelRows } from "../../packages/ui/src/chat-picker-entries.js";

const now = new Date("2026-11-25T15:40:00.000Z");
const workers = [...MANAGED_WORKERS_AI_MODEL_IDS];
const offeredWorkers = workers.filter(id => !retiredManagedWorkersAiModel(id));
const sonnet = "claude-sonnet-5";
const glmFlash = "@cf/zai-org/glm-5.3-flash";
const glmFull = "@cf/zai-org/glm-5.3";
const deepSeekV41 = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
async function observe(readiness: AiProviderReadiness, readyIds: string[], policyIds: string[]) {
  const homePath = await mkdtemp(join(tmpdir(), "funded-model-discovery-"));
  const service = new AiProviderService({ homePath, env: {}, now: () => now, driverInventory: async () => [],
    fundedCredentialProvider: { enabled: true, maxRunMs: 600_000,
      getCredential: async () => { throw new Error("Discovery cannot acquire credentials"); }, invalidate: () => {}, close: () => {} },
    fundedReadinessReader: { read: async () => ({ readiness, allowedModelIds: readyIds, discoverableModelIds: policyIds }) } });
  try { return await service.getSnapshot(); }
  finally { service.close(); await rm(homePath, { recursive: true, force: true }); }
}
const fresh: AiProviderReadiness = { state: "ready", checkedAt: now.toISOString(),
  staleAfter: new Date(+now + 30_000).toISOString(), action: "none", safeReason: null };

it("defaults to DeepSeek V4.1 Flash for new managed Chats and preserves explicit full GLM selections", async () => {
  const ids = [glmFlash, glmFull, deepSeekV41];
  const snapshot = await observe(fresh, ids, ids);
  const instance = managedPiChatInstances(snapshot, +now)[0]!;
  expect(instance.defaultSelection?.model).toBe(deepSeekV41);
  const catalog = { revision: "test", drivers: [], instances: [{ ...instance, catalogRevision: "test" }] };
  const selection = createCanonicalComposerSelection(catalog);
  expect(selection?.model).toBe(deepSeekV41);
  expect(applyCanonicalComposerPreference(catalog, selection!, {
    model: glmFull, options: [], permissionMode: "supervised",
  }).model).toBe(glmFull);
  expect(instance.models).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: glmFull, displayName: "GLM 5.3", availability: "available", supportsVision: false }),
    expect.objectContaining({ id: deepSeekV41, displayName: "DeepSeek V4.1 Flash", availability: "available", supportsVision: true }),
  ]));
  expect(resolveManagedPiRoute(snapshot, { instanceId: instance.id, model: glmFull }, +now).route)
    .toMatchObject({ modelId: glmFull, input: ["text"] });
  expect(resolveManagedPiRoute(snapshot, { instanceId: instance.id, model: deepSeekV41 }, +now).route)
    .toMatchObject({ modelId: deepSeekV41, input: ["text", "image"] });
});

it("uses the ready full GLM model when the preferred DeepSeek route is unavailable", async () => {
  const snapshot = await observe(fresh, [glmFull], [glmFull, deepSeekV41]);
  const instance = managedPiChatInstances(snapshot, +now)[0]!;
  expect(instance.defaultSelection?.model).toBe(glmFull);
  expect(instance.models).toContainEqual(expect.objectContaining({ id: deepSeekV41, availability: "unavailable" }));
});

it("retains a policy-authorized unready Anthropic peer without borrowing Workers health or owner-key inventory", async () => {
  const healthy = [glmFull, deepSeekV41];
  const snapshot = await observe(fresh, healthy, [...workers, sonnet, "unsupported/model"]);
  expect(snapshot.accessSources.find(source => source.id === "matrix_included")).toMatchObject({
    state: "unavailable", discoverableModelIds: [sonnet] });
  const instance = managedPiChatInstances(snapshot, +now)[0]!;
  expect(instance.models.map(model => model.id)).toEqual([...offeredWorkers, sonnet]);
  expect(instance.models.filter(model => model.availability === "available").map(model => model.id)).toEqual(healthy);
  expect(() => resolveManagedPiRoute(snapshot, { instanceId: instance.id, model: sonnet }, +now)).toThrow("model_unavailable");
  expect(instance.models.some(model => model.id === "claude-opus-4-6" || model.id === "unsupported/model")).toBe(false);
});

it.each(["credit_reserved", "credit_required", "budget_exceeded", "provider_unavailable", "auth"] as const)(
  "keeps active allowed models disabled with honest %s state", async safeReason => {
    const snapshot = await observe({ ...fresh, state: "unavailable", action: "retry", safeReason }, [], workers);
    const instance = managedPiChatInstances(snapshot, +now)[0]!;
    expect(instance.models.map(model => model.id)).toEqual(offeredWorkers);
    expect(instance.models.every(model => model.availability === "unavailable")).toBe(true);
    expect(instance.availability).toBe("unavailable");
    expect(instance.defaultSelection).toBeUndefined();
    const catalog = { revision: "test", drivers: [], instances: [{ ...instance, catalogRevision: "test" }] };
    expect(deriveCanonicalProviderChoices(catalog)).toEqual([]);
    const rows = deriveChatPickerModelRows(catalog, []);
    expect(rows).toHaveLength(offeredWorkers.length);
    expect(rows.every(row => row.choice === undefined)).toBe(true);
    expect(chatPickerModelAvailabilityLabel(rows[0]!, catalog.instances[0])).not.toBe("Available");
    for (const model of workers) {
      expect(() => resolveManagedPiRoute(snapshot, { instanceId: instance.id, model }, +now)).toThrow("model_unavailable");
    }
  });

it("never discovers bundled models without a fresh exact policy observation", async () => {
  for (const readiness of [fresh, { ...fresh, staleAfter: now.toISOString() }, { ...fresh, checkedAt: new Date(+now + 1000).toISOString() }]) {
    const policy = readiness === fresh ? [] : workers;
    const snapshot = await observe(readiness, [], policy);
    expect(managedPiChatInstances(snapshot, +now)[0]!.models).toEqual([]);
  }
});

describe("Cloudflare Preview managed catalog", () => {
  const gemini = "google/gemini-3.8-flash";
  const kimi = "moonshotai/kimi-k3.1-pro";
  const qwen = "alibaba/qwen3.7-plus";
  const inkling = "@cf/thinkingmachines/inkling-2-small";
  const qwenWorkers = "@cf/qwen/qwen3.8-27b";

  it("describes the Cloudflare Gemini route with its own pricing attestation and disclosure", () => {
    expect(AiModelDescriptorViewSchema.parse(buildBundledModelCatalog().find(model => model.id === gemini)))
      .toMatchObject({ id: gemini, vendor: "google", displayName: "Gemini 3.8 Flash", status: "preview",
        capabilities: ["tools", "reasoning", "long_context"],
        eligibleAccessSourceIds: ["matrix_google_preview"],
        dataPolicies: [{ accessSourceId: "matrix_google_preview", route: "matrix_relay", disclosureKey: "matrix-cloudflare-google" }] });
    expect(FUNDED_PRICING_CATALOG[gemini]).toMatchObject({ version: "cloudflare-2026-11-26-gemini-3.8-flash", input: 750, output: 3750, cached: 75,
      cacheWrite5m: 750, cacheWrite1h: 750 });
  });

  it("registers the exact Kimi 3.1 Pro Cloudflare rate and routed model", () => {
    expect(AiModelDescriptorViewSchema.parse(buildBundledModelCatalog().find(model => model.id === kimi)))
      .toMatchObject({ id: kimi, vendor: "moonshotai", displayName: "Kimi K3.1 Pro", status: "preview",
        capabilities: ["tools", "reasoning", "long_context"],
        dataPolicies: [{ accessSourceId: "matrix_moonshot_preview", route: "matrix_relay", disclosureKey: "matrix-cloudflare-moonshot" }] });
    expect(isManagedFundedOpenAiModel(kimi)).toBe(true);
    expect(FUNDED_PRICING_CATALOG[kimi]).toMatchObject({ version: "cloudflare-2026-11-26-kimi-k3.1-pro",
      input: 2000, output: 10000, cached: 200, cacheWrite5m: 2000, cacheWrite1h: 2000 });
  });

  it("registers the exact Qwen 3.7 Plus Cloudflare rate and routed model", () => {
    expect(AiModelDescriptorViewSchema.parse(buildBundledModelCatalog().find(model => model.id === qwen)))
      .toMatchObject({ id: qwen, vendor: "alibaba", displayName: "Qwen 3.7 Plus", status: "preview",
        capabilities: ["tools", "reasoning", "long_context"],
        dataPolicies: [{ accessSourceId: "matrix_alibaba_preview", route: "matrix_relay", disclosureKey: "matrix-cloudflare-alibaba" }] });
    expect(isManagedFundedOpenAiModel(qwen)).toBe(true);
    expect(FUNDED_PRICING_CATALOG[qwen]).toMatchObject({ version: "cloudflare-2026-11-26-qwen3.7-plus",
      input: 320, output: 1280, cached: 64, cacheWrite5m: 320, cacheWrite1h: 320 });
  });

  it("offers the Cloudflare Preview models only after exact scoped readiness, keeping DeepSeek first and full GLM available", async () => {
    const ready = [deepSeekV41, glmFull, qwenWorkers, inkling, gemini, kimi, qwen];
    const discovered = await observe(fresh, ready, ready);
    expect(discovered.accessSources.find(source => source.id === "matrix_moonshot_preview"))
      .toMatchObject({ state: "ready", vendor: "moonshotai", eligibleModelIds: [kimi] });
    expect(discovered.accessSources.find(source => source.id === "matrix_google_preview"))
      .toMatchObject({ state: "ready", vendor: "google", eligibleModelIds: [gemini] });
    expect(discovered.accessSources.find(source => source.id === "matrix_alibaba_preview"))
      .toMatchObject({ state: "ready", vendor: "alibaba", eligibleModelIds: [qwen] });
    const [managed] = managedPiChatInstances(discovered, +now);
    expect(managed?.defaultSelection?.model).toBe(deepSeekV41);
    for (const model of ready) {
      expect(managed?.models).toContainEqual(expect.objectContaining({ id: model, availability: "available" }));
    }
    for (const model of [gemini, kimi, qwen]) {
      expect(resolveManagedPiRoute(discovered, { instanceId: managed!.id, model }, +now))
        .toMatchObject({ route: { modelId: model, api: "openai-completions", input: ["text"], maxOutputTokens: 2_048 },
          accessSourceId: "matrix_included" });
    }
    for (const model of [deepSeekV41, glmFull, qwenWorkers, inkling]) {
      expect(resolveManagedPiRoute(discovered, { instanceId: managed!.id, model }, +now).route.maxOutputTokens).toBe(8_192);
    }

    const unready = await observe(fresh, ready.filter(model => model !== kimi), ready);
    expect(managedPiChatInstances(unready, +now)[0]?.models)
      .toContainEqual(expect.objectContaining({ id: kimi, availability: "unavailable" }));
    expect(() => resolveManagedPiRoute(unready, { instanceId: managed!.id, model: kimi }, +now))
      .toThrow("model_unavailable");

    const ordinary = await observe(fresh, [deepSeekV41, glmFull], [deepSeekV41, glmFull]);
    expect(ordinary.models.map(model => model.id)).not.toContain(kimi);
    expect(ordinary.models.map(model => model.id)).not.toContain(gemini);
    expect(ordinary.models.map(model => model.id)).not.toContain(qwen);
    expect(ordinary.models.map(model => model.id)).not.toContain(inkling);
    expect(ordinary.accessSources.map(source => source.id)).not.toContain("matrix_moonshot_preview");
    expect(ordinary.accessSources.map(source => source.id)).not.toContain("matrix_google_preview");
    expect(ordinary.accessSources.map(source => source.id)).not.toContain("matrix_alibaba_preview");
    expect(managedPiChatInstances(ordinary, +now)[0]?.defaultSelection?.model).toBe(deepSeekV41);
  });
});
