import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IsolatedChatEnvelopeSchema, isPortableGenericHarnessCredentialRoute } from "@matrix-os/contracts";
import { buildBundledModelCatalog, MATRIX_DEFAULT_MODEL_ID } from "../../packages/gateway/src/ai-providers/model-catalog.js";
import { projectMatrixModelInventory } from "../../packages/gateway/src/ai-providers/provider-matrix-model-inventory.js";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { managedPiChatInstances } from "../../packages/gateway/src/chat/managed-chat-catalog.js";
import { resolveBotRoute, resolveManagedPiRoute } from "../../packages/gateway/src/bots/route-resolver.js";
import { buildOpenCodeRunConfiguration, preparePiRunEnvironment } from "../../packages/gateway/src/coding-agents/managed-harness-process-config.js";
import { deriveCanonicalProviderChoices } from "../../packages/ui/src/canonical-provider-choice.js";
import { deriveChatPickerModelRows } from "../../packages/ui/src/chat-picker-entries.js";
import { createChatProviderCatalogService, validateChatProviderSelection } from "../../packages/gateway/src/chat/provider-catalog.js";

const IDS = [
  "@cf/zai-org/glm-5.3-flash", "@cf/deepseek-ai/deepseek-v4-flash-0731", "@cf/zai-org/glm-5.3",
  "@cf/moonshotai/kimi-k2.7-code", "@cf/openai/gpt-oss-120b", "@cf/google/gemma-4-26b-a4b-it",
  "@cf/deepseek-ai/deepseek-v4-pro-0813", "@cf/qwen/qwen3.8-27b", "@cf/openai/gpt-oss-20b",
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017", "@cf/thinkingmachines/inkling-2-small",
];
const FULL_GLM = "@cf/zai-org/glm-5.3";
const DEEPSEEK_V41 = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
const INKLING = "@cf/thinkingmachines/inkling-2-small";
const OFFERED = [
  FULL_GLM, "@cf/openai/gpt-oss-120b", "@cf/google/gemma-4-26b-a4b-it",
  "@cf/qwen/qwen3.8-27b", "@cf/openai/gpt-oss-20b", DEEPSEEK_V41, INKLING,
];
const NOW = new Date("2026-11-25T10:00:00.000Z");
const credentials = { OPENAI_API_KEY: "private-lease", OPENAI_BASE_URL: "https://relay.example.test/v1" };

describe("managed Workers AI model consumers", () => {
  it("preserves the original descriptors and adds Inkling after the existing choices", () => {
    const models = buildBundledModelCatalog().filter(model => model.eligibleAccessSourceIds.includes("matrix_cloudflare"));
    expect(models.map(model => model.id)).toEqual(IDS);
    expect(MATRIX_DEFAULT_MODEL_ID).toBe(IDS[0]);
    expect(models.every(model => model.vendor === "cloudflare" && model.capabilities.includes("tools"))).toBe(true);
  });

  it("configures every approved model for both portable harnesses without persisting the lease", async () => {
    const home = await mkdtemp(join(tmpdir(), "managed-workers-models-"));
    try {
      const openCode = JSON.parse(buildOpenCodeRunConfiguration(credentials));
      expect(Object.keys(openCode.provider.cloudflare.models)).toEqual(IDS);
      expect(openCode.provider.cloudflare.models[DEEPSEEK_V41]).toMatchObject({
        attachment: true, modalities: { input: ["text", "image"], output: ["text"] },
      });
      expect(openCode.provider.cloudflare.models[IDS[0]!].attachment).toBeUndefined();
      const env = await preparePiRunEnvironment({ homePath: home, credentials });
      const text = await readFile(join(env.PI_CODING_AGENT_DIR!, "models.json"), "utf8");
      expect(text).not.toContain("private-lease");
      const models = JSON.parse(text).providers.cloudflare.models as { id: string; input: string[] }[];
      expect(models.map(model => model.id)).toEqual(IDS);
      expect(models.filter(model => model.input.includes("image")).map(model => model.id)).toEqual([DEEPSEEK_V41]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it.each(IDS)("checks the portable managed route and legacy phase eligibility for %s", modelId => {
    const source = { id: "matrix_cloudflare", kind: "matrix_gateway" as const, fundingKind: "matrix_included" as const,
      providerId: "cloudflare", accountId: null };
    for (const harness of ["pi", "opencode"] as const) {
      expect(isPortableGenericHarnessCredentialRoute({ harness, accessSourceId: source.id,
        route: { kind: "configurable", providerId: "cloudflare", modelId } }, source)).toBe(true);
    }
    const envelope = { phaseId: "phase_models", ownerId: "owner", machineId: "machine", runtimeSlot: "primary",
      runtimeTokenEpoch: 1, runtimeCredentialSha256: "a".repeat(64), chatId: "chat_models", modelId,
      sourceSha: "b".repeat(40), startsAt: NOW.toISOString(), expiresAt: "2026-11-25T10:05:00.000Z" };
    expect(IsolatedChatEnvelopeSchema.safeParse(envelope).success).toBe(modelId !== INKLING);
    expect(IsolatedChatEnvelopeSchema.safeParse({ ...envelope, modelId: "@cf/unreviewed/model" }).success).toBe(false);
    expect(isPortableGenericHarnessCredentialRoute({ harness: "pi", accessSourceId: source.id,
      route: { kind: "configurable", providerId: "cloudflare", modelId: "@cf/unreviewed/model" } }, source)).toBe(false);
  });

  it("hides retired Workers choices across Chat and Settings while keeping active unavailable models visible", async () => {
    const home = await mkdtemp(join(tmpdir(), "managed-workers-readiness-"));
    let healthy = [FULL_GLM, DEEPSEEK_V41, INKLING, IDS[0]!];
    const service = new AiProviderService({ homePath: home, env: {}, now: () => NOW,
      fundedCredentialProvider: { enabled: true, maxRunMs: 600_000,
        getCredential: async () => { throw new Error("Catalog reads must not acquire credentials"); },
        invalidate: () => {}, close: () => {} },
      fundedReadinessReader: { read: async () => ({ readiness: { state: "ready", checkedAt: NOW.toISOString(),
        staleAfter: "2026-11-25T10:00:30.000Z", action: "none", safeReason: null },
        allowedModelIds: healthy, discoverableModelIds: IDS }) } });
    try {
      const snapshot = await service.getSnapshot();
      expect(snapshot.accessSources.find(source => source.id === "matrix_cloudflare"))
        .toMatchObject({ state: "ready", eligibleModelIds: [FULL_GLM, DEEPSEEK_V41, INKLING], discoverableModelIds: OFFERED });
      expect(snapshot.accessSources.find(source => source.id === "matrix_included")?.state).toBe("unavailable");
      expect(snapshot.models.find(model => model.id === IDS[0])).toMatchObject({ displayName: "GLM 5.3 Flash", status: "retired" });
      const inventory = projectMatrixModelInventory(snapshot, { enabled: true, globalRevision: 1,
        runtimeRevision: 1, allowedModelIds: IDS, monthlyBudgetMicrousd: 1_000_000,
        checkedAt: NOW.toISOString(), staleAfter: "2026-11-25T10:00:30.000Z" });
      expect(inventory.map(model => model.id)).toEqual(OFFERED);
      const instance = managedPiChatInstances(snapshot, +NOW)[0]!;
      expect(instance.models.map(model => model.id)).toEqual(OFFERED);
      expect(instance.models.filter(model => model.availability === "available").map(model => model.id)).toEqual([FULL_GLM, DEEPSEEK_V41, INKLING]);
      expect(instance.defaultSelection?.model).toBe(DEEPSEEK_V41);
      expect(resolveBotRoute(snapshot, +NOW).route.modelId).toBe(FULL_GLM);
      expect(resolveManagedPiRoute(snapshot, { instanceId: "matrix_pi_default", model: FULL_GLM }, +NOW).route.modelId).toBe(FULL_GLM);
      const retiredSelection = { instanceId: "matrix_pi_default", model: IDS[0]! };
      expect(() => resolveManagedPiRoute(snapshot, retiredSelection, +NOW)).toThrow("model_unavailable");
      const catalogs = createChatProviderCatalogService({ aiProviderSource: service, now: () => NOW,
        codingProviders: { listProviders: async () => { throw new Error("Unrequested CLI discovery"); }, invalidate: () => {} },
        agentRuntimeSource: async () => { throw new Error("Unrequested runtime discovery"); } });
      const catalog = await catalogs.getCatalog({ userId: "owner_1", source: "jwt" }, retiredSelection);
      const rows = deriveChatPickerModelRows(catalog, deriveCanonicalProviderChoices(catalog));
      expect(rows.map(row => row.modelId)).toEqual(OFFERED);
      expect(rows.filter(row => row.choice).map(row => row.modelId)).toEqual([FULL_GLM, DEEPSEEK_V41, INKLING]);
      expect(validateChatProviderSelection({ catalog, selection: retiredSelection, boundInstanceId: instance.id }))
        .toMatchObject({ ok: false, error: { code: "model_unavailable", recoveryActions: ["select_provider"] } });
      const replacement = { instanceId: instance.id, model: FULL_GLM };
      expect(validateChatProviderSelection({ catalog, selection: replacement, boundInstanceId: instance.id }))
        .toMatchObject({ ok: true, selection: replacement });

      healthy = ["@cf/openai/gpt-oss-20b"];
      const next = managedPiChatInstances(await service.getSnapshot(), +NOW)[0]!;
      expect(next.models.map(model => model.id)).toEqual(OFFERED);
      expect(next.models.filter(model => model.availability === "available").map(model => model.id)).toEqual(healthy);
      expect(managedPiChatInstances(snapshot, +NOW + 30_001)[0]!.models).toEqual([]);
    } finally { service.close(); await rm(home, { recursive: true, force: true }); }
  });
});
