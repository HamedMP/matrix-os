import type { AiProviderSnapshotV3 } from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";
import { BotRouteError, resolveBotRoute } from "../../../packages/gateway/src/bots/route-resolver.js";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const ready = { state: "ready", checkedAt: null, staleAfter: null, action: "none", safeReason: null };

function snapshot(overrides: {
  active?: { accessSourceId: string | null; modelId: string | null };
  sources?: Array<{ id: string; state?: string; staleAfter?: string | null; models: string[] }>;
  models?: Array<{ id: string; vendor: string; capabilities?: string[]; status?: string; sources: string[] }>;
  instances?: Array<{ accessSourceId: string; defaultModelId: string | null; state?: string }>;
} = {}): AiProviderSnapshotV3 {
  return {
    active: { providerInstanceId: null, ...(overrides.active ?? { accessSourceId: null, modelId: null }) },
    accessSources: (overrides.sources ?? []).map((source) => ({
      ...ready, id: source.id, state: source.state ?? "ready", staleAfter: source.staleAfter ?? null, eligibleModelIds: source.models,
    })),
    models: (overrides.models ?? []).map((model) => ({
      id: model.id, vendor: model.vendor, status: model.status ?? "current",
      capabilities: model.capabilities ?? ["tools"], eligibleAccessSourceIds: model.sources,
    })),
    instances: (overrides.instances ?? []).map((instance, index) => ({
      id: `instance_${index}`, accessSourceId: instance.accessSourceId, defaultModelId: instance.defaultModelId,
      readiness: { ...ready, state: instance.state ?? "ready" },
    })),
  } as unknown as AiProviderSnapshotV3;
}

const GLM = "@cf/zai-org/glm-5.3-flash";
const SONNET = "claude-sonnet-5";

describe("bot route resolver", () => {
  it("uses the owner's active choice when bots can run on it", () => {
    const resolved = resolveBotRoute(snapshot({
      active: { accessSourceId: "owner_anthropic_key", modelId: SONNET },
      sources: [{ id: "owner_anthropic_key", models: [SONNET] }, { id: "matrix_included", models: [GLM] }],
      models: [{ id: SONNET, vendor: "anthropic", capabilities: ["tools", "vision"], sources: ["owner_anthropic_key"] }, { id: GLM, vendor: "zai", sources: ["matrix_included"] }],
      instances: [{ accessSourceId: "matrix_included", defaultModelId: GLM }],
    }), NOW);
    expect(resolved).toEqual({
      accessSourceId: "owner_anthropic_key",
      route: { api: "anthropic-messages", modelId: SONNET, input: ["text", "image"], contextWindow: 200_000, maxOutputTokens: 8_192 },
    });
  });

  it("prefers Matrix AI's GLM route, launched with the Matrix AI credential as chat completions", () => {
    const resolved = resolveBotRoute(snapshot({
      sources: [{ id: "matrix_cloudflare", models: [GLM] }, { id: "matrix_included", models: [SONNET] }],
      models: [{ id: GLM, vendor: "cloudflare", sources: ["matrix_cloudflare"] }, { id: SONNET, vendor: "anthropic", sources: ["matrix_included"] }],
      instances: [{ accessSourceId: "matrix_included", defaultModelId: SONNET }, { accessSourceId: "matrix_cloudflare", defaultModelId: GLM }],
    }), NOW);
    expect(resolved).toMatchObject({ accessSourceId: "matrix_included", route: { api: "openai-completions", modelId: GLM } });
    // Matrix AI's Anthropic source never serves another vendor's model.
    expect(() => resolveBotRoute(snapshot({
      sources: [{ id: "matrix_included", models: [GLM] }],
      models: [{ id: GLM, vendor: "cloudflare", sources: ["matrix_included"] }],
      instances: [{ accessSourceId: "matrix_included", defaultModelId: GLM }],
    }), NOW)).toThrow(BotRouteError);
  });

  it("falls back to Matrix AI's default, served as chat completions for other vendors", () => {
    const resolved = resolveBotRoute(snapshot({
      active: { accessSourceId: "owner_openai_profile", modelId: "gpt-5" },
      sources: [{ id: "matrix_cloudflare", models: [GLM] }],
      models: [{ id: GLM, vendor: "zai", sources: ["matrix_cloudflare"] }],
      instances: [{ accessSourceId: "matrix_cloudflare", defaultModelId: GLM }],
    }), NOW);
    expect(resolved).toMatchObject({ accessSourceId: "matrix_included", route: { api: "openai-completions", modelId: GLM, input: ["text"] } });
  });

  it("never selects stale or unready sources, retired or tool-less models, or other vendors off Matrix AI", () => {
    const refused = [
      snapshot({ sources: [{ id: "matrix_included", state: "setup_required", models: [GLM] }], models: [{ id: GLM, vendor: "zai", sources: ["matrix_included"] }], instances: [{ accessSourceId: "matrix_included", defaultModelId: GLM }] }),
      snapshot({ sources: [{ id: "matrix_included", staleAfter: "2026-09-28T11:00:00.000Z", models: [GLM] }], models: [{ id: GLM, vendor: "zai", sources: ["matrix_included"] }], instances: [{ accessSourceId: "matrix_included", defaultModelId: GLM }] }),
      snapshot({ sources: [{ id: "matrix_included", models: [GLM] }], models: [{ id: GLM, vendor: "zai", status: "retired", sources: ["matrix_included"] }], instances: [{ accessSourceId: "matrix_included", defaultModelId: GLM }] }),
      snapshot({ sources: [{ id: "matrix_included", models: [GLM] }], models: [{ id: GLM, vendor: "zai", capabilities: [], sources: ["matrix_included"] }], instances: [{ accessSourceId: "matrix_included", defaultModelId: GLM }] }),
      snapshot({ sources: [{ id: "owner_anthropic_key", models: ["gpt-5"] }], models: [{ id: "gpt-5", vendor: "openai", sources: ["owner_anthropic_key"] }], instances: [{ accessSourceId: "owner_anthropic_key", defaultModelId: "gpt-5" }] }),
      snapshot({ sources: [{ id: "matrix_included", models: [] }], models: [{ id: GLM, vendor: "zai", sources: ["matrix_included"] }], instances: [{ accessSourceId: "matrix_included", defaultModelId: GLM }] }),
      snapshot(),
    ];
    for (const value of refused) expect(() => resolveBotRoute(value, NOW)).toThrow(BotRouteError);
  });

  it("tries sources in order: Matrix AI, own key, own profile", () => {
    const resolved = resolveBotRoute(snapshot({
      sources: [{ id: "owner_anthropic_profile", models: [SONNET] }, { id: "owner_anthropic_key", models: [SONNET] }],
      models: [{ id: SONNET, vendor: "anthropic", sources: ["owner_anthropic_profile", "owner_anthropic_key"] }],
      instances: [{ accessSourceId: "owner_anthropic_profile", defaultModelId: SONNET }, { accessSourceId: "owner_anthropic_key", defaultModelId: SONNET }],
    }), NOW);
    expect(resolved.accessSourceId).toBe("owner_anthropic_key");
  });
});
