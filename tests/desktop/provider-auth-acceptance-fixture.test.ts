import { ProviderSettingsSnapshotSchema, ProviderSettingsMutationResponseSchema } from "@matrix-os/contracts";
import { afterEach, expect, it } from "vitest";
import { codingAgentProjectWorkspace } from "../e2e/desktop/fixtures/stub-gateway";
import { startProviderAuthGateway } from "../e2e/desktop/fixtures/provider-auth-gateway";
let gateway: Awaited<ReturnType<typeof startProviderAuthGateway>> | undefined;
afterEach(async () => { await gateway?.close(); gateway = undefined; });
it("advertises agent disable and preserves native authentication, allowance and route", async () => {
  gateway = await startProviderAuthGateway(); gateway.setAuthenticated(true);
  const read = async () => ProviderSettingsSnapshotSchema.parse(await (await fetch(`${gateway!.url}/api/ai/provider-settings`, { signal: AbortSignal.timeout(1000) })).json());
  const before = await read(); expect(before.supportedActions).toContain("set_harness_enabled");
  const response = await fetch(`${gateway.url}/api/ai/provider-settings/actions`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(1000), body: JSON.stringify({ type: "set_harness_enabled", harnessInstanceId: "claude_harness", enabled: false, idempotencyKey: "fixture_disable", expectedRevision: before.revision }) });
  expect(response.status).toBe(200);
  const receipt = ProviderSettingsMutationResponseSchema.parse(await response.json());
  if (receipt.kind !== "snapshot") throw new Error("Expected disable snapshot");
  const { snapshot } = receipt;
  expect(snapshot.harnesses[0]).toMatchObject({ enabled: false, configuredEnabled: false, authState: "authenticated" });
  expect(snapshot.accounts).toEqual(before.accounts); expect(snapshot.accessSources).toEqual(before.accessSources);
  expect(snapshot.harnesses[0].route).toEqual(before.harnesses[0].route);
  expect((await read()).harnesses[0].enabled).toBe(false); expect(gateway.commands).toHaveLength(0);
});
it("rejects an unknown disable target without changing the real fixture agent", async () => {
  gateway = await startProviderAuthGateway(); gateway.setAuthenticated(true);
  const response = await fetch(`${gateway.url}/api/ai/provider-settings/actions`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(1000), body: JSON.stringify({ type: "set_harness_enabled", harnessInstanceId: "other", enabled: false, idempotencyKey: "fixture_disable", expectedRevision: 2 }) });
  expect(response.status).toBe(400);
  const snapshot = ProviderSettingsSnapshotSchema.parse(await (await fetch(`${gateway.url}/api/ai/provider-settings`, { signal: AbortSignal.timeout(1000) })).json());
  expect(snapshot.harnesses[0]).toMatchObject({ enabled: true, authState: "authenticated" });
  expect(gateway.commands).toHaveLength(0);
});

it("projects minimal task inputs and rejects invalid canonical status", () => {
  const workspace = codingAgentProjectWorkspace([{ id: "task_polish", status: "blocked", revision: 7 }]);
  expect(workspace.tasks.items.find(task => task.id === "task_polish")).toMatchObject({ status: "blocked", revision: 7 });
  expect(() => codingAgentProjectWorkspace([{ id: "task_polish", status: "unsupported", revision: 7 }])).toThrow();
});
