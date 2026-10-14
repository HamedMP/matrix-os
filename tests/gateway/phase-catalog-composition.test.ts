import { expect, it, vi } from "vitest";
import { composePhaseCatalog } from "../../packages/gateway/src/chat/phase-catalog-composition.js";
import { createChatProviderCatalogService, type ChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";
import { withMatrixAnthropicProviderInstances } from "../../packages/gateway/src/bots/matrix-anthropic-provider-instance.js";
import { withChatGptPlanProviderInstance } from "../../packages/gateway/src/bots/chatgpt-plan-provider-instance.js";
import { ChatGptPlanPeerError } from "../../packages/gateway/src/bots/chatgpt-plan-peers.js";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";

const principal = { userId: "owner_1", source: "jwt" as const };
const modelId = "@cf/zai-org/glm-5.3-flash";
const now = new Date("2026-10-03T11:23:00.000Z");

function fixture() {
  const snapshot = makeAiProviderSnapshot();
  snapshot.accessSources[0] = { ...snapshot.accessSources[0]!, id: "matrix_cloudflare", vendor: "cloudflare",
    eligibleModelIds: [modelId], checkedAt: now.toISOString(), staleAfter: "2026-10-03T11:23:30.000Z" };
  snapshot.models[0] = { ...snapshot.models[0]!, id: modelId, displayName: "GLM 5.3 Flash", vendor: "cloudflare",
    eligibleAccessSourceIds: ["matrix_cloudflare"] };
  const getSnapshot = vi.fn(async () => structuredClone(snapshot));
  const base = createChatProviderCatalogService({
    codingProviders: { listProviders: vi.fn(async () => []), invalidate: vi.fn() },
    agentRuntimeSource: async () => { throw new Error("Unconfigured runtime"); },
    aiProviderSource: { getSnapshot }, now: () => now,
  });
  const anthropic = vi.fn(async () => makeAiProviderSnapshot());
  const plan = vi.fn(async () => { throw new ChatGptPlanPeerError("forbidden"); });
  const decorate = (catalog: ChatProviderCatalogService) => withChatGptPlanProviderInstance(
    withMatrixAnthropicProviderInstances(catalog, { getSnapshot: anthropic }, () => true, principal.userId),
    { observe: plan }, () => true,
  );
  return { snapshot, getSnapshot, anthropic, plan, base, decorate };
}

it("production decorators retain the refreshed ready receipt without a second funded catalog observation", async () => {
  const f = fixture();
  const later = structuredClone(f.snapshot);
  later.accessSources[0]!.state = "unavailable";
  later.accessSources[0]!.safeReason = "provider_unavailable";
  f.getSnapshot.mockResolvedValueOnce(f.snapshot).mockResolvedValue(later);
  const catalog = await composePhaseCatalog(f.base, false, f.decorate).refresh(principal);
  expect(catalog.instances.find(instance => instance.id === "matrix_pi_default")).toMatchObject({
    availability: "available", models: [expect.objectContaining({ id: modelId, availability: "available" })],
  });
  expect(f.getSnapshot).toHaveBeenCalledExactlyOnceWith({ refresh: true });
  expect(f.anthropic).toHaveBeenCalledExactlyOnceWith({ admissionScope: "managed_matrix", suppressFundedProbes: true });
  expect(f.plan).toHaveBeenCalledExactlyOnceWith(principal.userId);
});

it("separate refreshes observe current source state without retaining the prior receipt", async () => {
  const f = fixture();
  const service = composePhaseCatalog(f.base, false, f.decorate);
  expect((await service.refresh(principal)).instances.find(i => i.id === "matrix_pi_default")?.availability).toBe("available");
  f.snapshot.accessSources[0]!.state = "unavailable";
  f.snapshot.accessSources[0]!.safeReason = "credit_reserved";
  expect((await service.refresh(principal)).instances.find(i => i.id === "matrix_pi_default")).toMatchObject({
    availability: "unavailable", connectionState: "credit_reserved",
  });
  expect(f.getSnapshot).toHaveBeenCalledTimes(2);
  expect(f.getSnapshot).toHaveBeenNthCalledWith(1, { refresh: true });
  expect(f.getSnapshot).toHaveBeenNthCalledWith(2, { refresh: true });
  expect(f.anthropic).toHaveBeenCalledTimes(2);
  expect(f.plan).toHaveBeenCalledTimes(2);
});

it("propagates a failed base refresh without a fallback read or account observations", async () => {
  const f = fixture();
  const refresh = vi.fn(async () => { throw new Error("Refresh unavailable"); });
  const getCatalog = vi.fn(f.base.getCatalog);
  const service = composePhaseCatalog({ refresh, getCatalog }, false, f.decorate);
  await expect(service.refresh(principal, { includeSettingsSetupActions: true })).rejects.toThrow("Refresh unavailable");
  expect(refresh).toHaveBeenCalledExactlyOnceWith(principal, { includeSettingsSetupActions: true });
  expect(getCatalog).not.toHaveBeenCalled();
  expect(f.anthropic).not.toHaveBeenCalled();
  expect(f.plan).not.toHaveBeenCalled();
});

it("canonical refresh keeps the trusted base path and skips ordinary account decorators", async () => {
  const f = fixture();
  const decorate = vi.fn(f.decorate);
  const catalog = await composePhaseCatalog(f.base, true, decorate).refresh(principal);
  expect(f.getSnapshot).toHaveBeenCalledExactlyOnceWith({ refresh: true });
  expect(decorate).not.toHaveBeenCalled();
  expect(f.anthropic).not.toHaveBeenCalled();
  expect(f.plan).not.toHaveBeenCalled();
  expect(catalog.instances.find(i => i.id === "matrix_pi_chatgpt_plan")).toMatchObject({ availability: "unavailable", models: [] });
});
