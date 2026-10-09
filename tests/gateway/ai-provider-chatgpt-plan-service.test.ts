import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BotProviderConnection } from "@matrix-os/contracts";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { initialProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { projectProviderSettings } from "../../packages/gateway/src/ai-providers/provider-settings-projector.js";
import { projectChatGptPlanAppRoutes } from "../../packages/gateway/src/app-ai/chatgpt-plan-projection.js";

const now = new Date("2026-10-08T12:00:00.000Z");
const source: BotProviderConnection = { id: "matrix_chatgpt_plan", providerId: "openai", executionKind: "direct_pi", availability: "available", accountId: "account-own", models: [{ id: "gpt-own", displayName: "Own model" }], authorization: { revision: 3, enabled: true, background: false }, coordinatorFunding: "subscription" };
let homePath: string;
const services: AiProviderService[] = [];
beforeEach(async () => { homePath = await mkdtemp(join(tmpdir(), "ai-plan-service-")); await mkdir(join(homePath, "system")); });
afterEach(async () => { for (const service of services.splice(0)) service.close(); vi.useRealTimers(); await rm(homePath, { recursive: true, force: true }); });
function service(observe?: (signal: AbortSignal) => Promise<BotProviderConnection | undefined>) {
  const result = new AiProviderService({ homePath, env: {}, now: () => now, chatGptPlanObservation: observe, driverInventory: async () => [
    { id: "hermes", displayName: "Hermes", kind: "cli", installState: "installed", health: "unknown", capabilities: [], setupActions: [] },
    { id: "openclaw", displayName: "OpenClaw", kind: "cli", installState: "installed", health: "unknown", capabilities: [], setupActions: [] },
  ] });
  services.push(result);
  return result;
}
it("real service feeds identical canonical account/source/model truth to Settings and apps", async () => {
  const observed = vi.fn(async () => source);
  const snapshot = await service(observed).getSnapshot();
  const config = initialProviderSettingsConfiguration(snapshot, undefined, now);
  const settings = await projectProviderSettings({ canonical: snapshot, config, now, supportedActions: [] });
  const routes = projectChatGptPlanAppRoutes(snapshot, true, +now);
  expect(routes).toEqual([{ harnessId: source.id, accessSourceId: source.id, accountId: source.accountId, modelId: source.models[0]!.id, displayName: "ChatGPT subscription", availability: "available", readiness: "ready", reason: null }]);
  expect(settings.accounts.find(account => account.id === routes[0]!.accountId)).toMatchObject({ authState: "authenticated", accessSourceId: routes[0]!.accessSourceId, authMethod: "oauth" });
  expect(settings.accessSources.find(entry => entry.id === routes[0]!.accessSourceId)).toMatchObject({ accountId: routes[0]!.accountId, eligibleModelIds: [routes[0]!.modelId], readiness: { state: "ready", checkedAt: snapshot.accessSources.find(entry => entry.id === source.id)!.checkedAt } });
  expect(observed).toHaveBeenCalledTimes(1);
});
it("native defaults cannot select the paired device's route or invent its harness", async () => {
  const snapshot = await service(async () => source).getSnapshot();
  const config = initialProviderSettingsConfiguration(snapshot, undefined, now);
  expect(config.harnesses.some(harness => harness.accessSourceId === source.id)).toBe(false);
  expect(config.harnesses.some(harness => harness.driverId === "chatgpt_plan_peer")).toBe(false);
});
it("reobserves grant revocation and absence without caching ready source truth", async () => {
  const observe = vi.fn().mockResolvedValueOnce(source).mockResolvedValueOnce({ ...source, availability: "setup_required", unavailableReason: "authorization_required", authorization: { revision: 4, enabled: false, background: false } }).mockResolvedValueOnce(undefined);
  const instance = service(observe);
  expect((await instance.getSnapshot()).accessSources.find(entry => entry.id === source.id)?.state).toBe("ready");
  const revoked = await instance.getSnapshot();
  expect(revoked.accessSources.find(entry => entry.id === source.id)?.state).toBe("disabled");
  expect(projectChatGptPlanAppRoutes(revoked, true, +now)).toEqual([]);
  expect((await instance.getSnapshot()).accessSources.some(entry => entry.id === source.id)).toBe(false);
});
it("a failed optional peer observation preserves all unrelated routes", async () => {
  const base = await service().getSnapshot();
  const failed = await service(async () => { throw new Error("private peer detail"); }).getSnapshot();
  expect(failed).toEqual(base);
});
it("skips paired peer work for exact managed Matrix admission", async () => {
  const observe = vi.fn(async () => source);
  const snapshot = await service(observe).getSnapshot({ admissionScope: "managed_matrix" });
  expect(observe).not.toHaveBeenCalled();
  expect(snapshot.accessSources.some(entry => entry.id === source.id)).toBe(false);
});
it("bounds even an observer ignoring cancellation and aborts its signal", async () => {
  vi.useFakeTimers();
  const observe = vi.fn((_signal: AbortSignal): Promise<BotProviderConnection> => new Promise(() => {}));
  const result = service(observe).getSnapshot();
  await vi.waitFor(() => expect(observe).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(2000);
  const snapshot = await result;
  expect(observe.mock.calls[0]![0].aborted).toBe(true);
  expect(snapshot.accessSources.some(entry => entry.id === source.id)).toBe(false);
});
it("parent cancellation rejects snapshot rather than returning false success", async () => {
  const observe = vi.fn((_signal: AbortSignal): Promise<BotProviderConnection> => new Promise(() => {}));
  const controller = new AbortController();
  const result = service(observe).getSnapshot({ signal: controller.signal });
  const rejected = expect(result).rejects.toThrow();
  await vi.waitFor(() => expect(observe).toHaveBeenCalled());
  controller.abort();
  await rejected;
  expect(observe.mock.calls[0]![0].aborted).toBe(true);
});
