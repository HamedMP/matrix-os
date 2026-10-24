import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MANAGED_WORKERS_AI_MODEL_IDS, type AiProviderReadiness } from "@matrix-os/contracts";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { managedPiChatInstances } from "../../packages/gateway/src/chat/managed-chat-catalog.js";
import { resolveManagedPiRoute } from "../../packages/gateway/src/bots/route-resolver.js";
import { deriveCanonicalProviderChoices } from "../../packages/ui/src/canonical-provider-choice.js";
import { chatPickerModelAvailabilityLabel, deriveChatPickerModelRows } from "../../packages/ui/src/chat-picker-entries.js";

const now = new Date("2026-10-23T15:40:00.000Z");
const workers = [...MANAGED_WORKERS_AI_MODEL_IDS];
const sonnet = "claude-sonnet-5";
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

it("retains a policy-authorized unready Anthropic peer without borrowing Workers health or owner-key inventory", async () => {
  const snapshot = await observe(fresh, workers.slice(1, 3), [...workers, sonnet, "unsupported/model"]);
  expect(snapshot.accessSources.find(source => source.id === "matrix_included")).toMatchObject({
    state: "unavailable", discoverableModelIds: [sonnet] });
  const instance = managedPiChatInstances(snapshot, +now)[0]!;
  expect(instance.models.map(model => model.id)).toEqual(snapshot.models.filter(model => [...workers, sonnet].includes(model.id)).map(model => model.id));
  expect(instance.models.filter(model => model.availability === "available").map(model => model.id)).toEqual(workers.slice(1, 3));
  expect(() => resolveManagedPiRoute(snapshot, { instanceId: instance.id, model: sonnet }, +now)).toThrow("model_unavailable");
  expect(instance.models.some(model => model.id === "claude-opus-4-6" || model.id === "unsupported/model")).toBe(false);
});

it.each(["credit_reserved", "credit_required", "budget_exceeded", "provider_unavailable", "auth"] as const)(
  "keeps the complete allowed list disabled with honest %s state", async safeReason => {
    const snapshot = await observe({ ...fresh, state: "unavailable", action: "retry", safeReason }, [], workers);
    const instance = managedPiChatInstances(snapshot, +now)[0]!;
    expect(instance.models.map(model => model.id)).toEqual(workers);
    expect(instance.models.every(model => model.availability === "unavailable")).toBe(true);
    expect(instance.availability).toBe("unavailable");
    expect(instance.defaultSelection).toBeUndefined();
    const catalog = { revision: "test", drivers: [], instances: [{ ...instance, catalogRevision: "test" }] };
    expect(deriveCanonicalProviderChoices(catalog)).toEqual([]);
    const rows = deriveChatPickerModelRows(catalog, []);
    expect(rows).toHaveLength(workers.length);
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
