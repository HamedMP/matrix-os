import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IsolatedChatEnvelopeSchema, isPortableGenericHarnessCredentialRoute } from "@matrix-os/contracts";
import { buildBundledModelCatalog, MATRIX_DEFAULT_MODEL_ID } from "../../packages/gateway/src/ai-providers/model-catalog.js";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { managedPiChatInstances } from "../../packages/gateway/src/chat/managed-chat-catalog.js";
import { resolveBotRoute, resolveManagedPiRoute } from "../../packages/gateway/src/bots/route-resolver.js";
import { buildOpenCodeRunConfiguration, preparePiRunEnvironment } from "../../packages/gateway/src/coding-agents/managed-harness-process-config.js";

const IDS = [
  "@cf/zai-org/glm-5.3-flash", "@cf/deepseek-ai/deepseek-v4-flash-0731", "@cf/zai-org/glm-5.3",
  "@cf/moonshotai/kimi-k2.7-code", "@cf/openai/gpt-oss-120b", "@cf/google/gemma-4-26b-a4b-it",
  "@cf/deepseek-ai/deepseek-v4-pro-0813", "@cf/qwen/qwen3.8-27b", "@cf/openai/gpt-oss-20b",
];
const NOW = new Date("2026-10-15T10:00:00.000Z");
const credentials = { OPENAI_API_KEY: "private-lease", OPENAI_BASE_URL: "https://relay.example.test/v1" };

describe("managed Workers AI model consumers", () => {
  it("shares exactly nine managed models while preserving Flash first and as default", () => {
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
      const env = await preparePiRunEnvironment({ homePath: home, credentials });
      const text = await readFile(join(env.PI_CODING_AGENT_DIR!, "models.json"), "utf8");
      expect(text).not.toContain("private-lease");
      expect(JSON.parse(text).providers.cloudflare.models.map((model: { id: string }) => model.id)).toEqual(IDS);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it.each(IDS)("allows the exact portable managed route and isolated envelope for %s", modelId => {
    const source = { id: "matrix_cloudflare", kind: "matrix_gateway" as const, fundingKind: "matrix_included" as const,
      providerId: "cloudflare", accountId: null };
    for (const harness of ["pi", "opencode"] as const) {
      expect(isPortableGenericHarnessCredentialRoute({ harness, accessSourceId: source.id,
        route: { kind: "configurable", providerId: "cloudflare", modelId } }, source)).toBe(true);
    }
    const envelope = { phaseId: "phase_models", ownerId: "owner", machineId: "machine", runtimeSlot: "primary",
      runtimeTokenEpoch: 1, runtimeCredentialSha256: "a".repeat(64), chatId: "chat_models", modelId,
      sourceSha: "b".repeat(40), startsAt: NOW.toISOString(), expiresAt: "2026-10-15T10:05:00.000Z" };
    expect(IsolatedChatEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(IsolatedChatEnvelopeSchema.safeParse({ ...envelope, modelId: "@cf/unreviewed/model" }).success).toBe(false);
    expect(isPortableGenericHarnessCredentialRoute({ harness: "pi", accessSourceId: source.id,
      route: { kind: "configurable", providerId: "cloudflare", modelId: "@cf/unreviewed/model" } }, source)).toBe(false);
  });

  it("exposes only the healthy model on a partially ready shared Workers source", async () => {
    const home = await mkdtemp(join(tmpdir(), "managed-workers-readiness-"));
    const healthy = IDS[1]!;
    const service = new AiProviderService({ homePath: home, env: {}, now: () => NOW,
      fundedCredentialProvider: { enabled: true, maxRunMs: 600_000,
        getCredential: async () => { throw new Error("Catalog reads must not acquire credentials"); },
        invalidate: () => {}, close: () => {} },
      fundedReadinessReader: { read: async () => ({ readiness: { state: "ready", checkedAt: NOW.toISOString(),
        staleAfter: "2026-10-15T10:00:30.000Z", action: "none", safeReason: null },
        allowedModelIds: [healthy], discoverableModelIds: IDS }) } });
    try {
      const snapshot = await service.getSnapshot();
      expect(snapshot.accessSources.find(source => source.id === "matrix_cloudflare"))
        .toMatchObject({ state: "ready", eligibleModelIds: [healthy] });
      expect(snapshot.accessSources.find(source => source.id === "matrix_included")?.state).toBe("unavailable");
      const instance = managedPiChatInstances(snapshot, +NOW)[0]!;
      expect(instance.models.filter(model => model.availability === "available").map(model => model.id)).toEqual([healthy]);
      expect(instance.defaultSelection?.model).toBe(healthy);
      expect(resolveBotRoute(snapshot, +NOW).route.modelId).toBe(healthy);
      expect(resolveManagedPiRoute(snapshot, { instanceId: "matrix_pi_default", model: healthy }, +NOW).route.modelId).toBe(healthy);
      expect(() => resolveManagedPiRoute(snapshot, { instanceId: "matrix_pi_default", model: IDS[0]! }, +NOW)).toThrow("model_unavailable");
    } finally { service.close(); await rm(home, { recursive: true, force: true }); }
  });
});
