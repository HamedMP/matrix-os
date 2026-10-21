import { describe, expect, it, vi } from "vitest";
import { createChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";

const principal = { userId: "owner_1", source: "jwt" as const };
const modelId = "@cf/zai-org/glm-5.3-flash";
const observedAt = new Date("2026-10-03T11:23:00.000Z");

function fixture() {
  const snapshot = makeAiProviderSnapshot();
  snapshot.accessSources[0] = { ...snapshot.accessSources[0]!, id: "matrix_cloudflare", vendor: "cloudflare", eligibleModelIds: [modelId] };
  snapshot.models[0] = { ...snapshot.models[0]!, id: modelId, displayName: "GLM 5.3 Flash", vendor: "cloudflare", eligibleAccessSourceIds: ["matrix_cloudflare"] };
  snapshot.accessSources[0]!.checkedAt = observedAt.toISOString();
  snapshot.accessSources[0]!.staleAfter = "2026-10-03T11:23:30.000Z";
  const getSnapshot = vi.fn(async () => structuredClone(snapshot));
  const service = createChatProviderCatalogService({
    codingProviders: { listProviders: vi.fn(async () => []), invalidate: vi.fn() },
    agentRuntimeSource: async () => { throw new Error("Unconfigured runtime"); },
    aiProviderSource: { getSnapshot }, now: () => observedAt,
  });
  return { snapshot, getSnapshot, service };
}

describe("single-observation canonical catalog refresh", () => {
  it("projects the refreshed Matrix receipt instead of discarding it and probing again", async () => {
    const { snapshot, getSnapshot, service } = fixture();
    const unavailable = structuredClone(snapshot);
    unavailable.accessSources[0]!.state = "unavailable";
    unavailable.accessSources[0]!.safeReason = "provider_unavailable";
    getSnapshot.mockResolvedValueOnce(snapshot).mockResolvedValue(unavailable);
    const catalog = await service.refresh(principal);
    expect(catalog.instances.find(instance => instance.id === "matrix_pi_default")).toMatchObject({
      availability: "available", models: [expect.objectContaining({ id: modelId, availability: "available" })],
    });
    expect(getSnapshot).toHaveBeenCalledExactlyOnceWith({ refresh: true });
  });

  it("preserves the refreshed unavailable receipt instead of replacing it with another observation", async () => {
    const { snapshot, getSnapshot, service } = fixture();
    snapshot.accessSources[0]!.state = "unavailable";
    snapshot.accessSources[0]!.safeReason = "credit_reserved";
    const catalog = await service.refresh(principal);
    expect(catalog.instances.find(instance => instance.id === "matrix_pi_default")).toMatchObject({
      availability: "unavailable", connectionState: "credit_reserved",
      models: [expect.objectContaining({ availability: "unavailable" })],
    });
    expect(getSnapshot).toHaveBeenCalledExactlyOnceWith({ refresh: true });
  });

  it("does not reread a failed refresh or reuse a prior ready snapshot", async () => {
    const { getSnapshot, service } = fixture();
    expect((await service.getCatalog(principal)).instances.find(instance => instance.id === "matrix_pi_default")?.availability).toBe("available");
    getSnapshot.mockRejectedValueOnce(new Error("private failure"));
    const catalog = await service.refresh(principal);
    expect(catalog.instances.some(instance => instance.driverKind === "matrix_pi")).toBe(false);
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it("keeps a silent read fresh and rejects expired evidence during projection", async () => {
    const { snapshot, getSnapshot, service } = fixture();
    snapshot.accessSources[0]!.staleAfter = observedAt.toISOString();
    const catalog = await service.getCatalog(principal);
    expect(catalog.instances.find(instance => instance.id === "matrix_pi_default")?.availability).toBe("unavailable");
    expect(getSnapshot).toHaveBeenCalledExactlyOnceWith({ refresh: false });
  });
});
