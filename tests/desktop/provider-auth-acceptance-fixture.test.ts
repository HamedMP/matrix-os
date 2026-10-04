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

it("rejects stale disable without a write and returns increasing committed revisions", async () => {
  gateway = await startProviderAuthGateway(); gateway.setAuthenticated(true);
  const read = async () => ProviderSettingsSnapshotSchema.parse(await (await fetch(`${gateway!.url}/api/ai/provider-settings`, { signal: AbortSignal.timeout(1000) })).json());
  const before = await read();
  const write = (expectedRevision: number, enabled: boolean, idempotencyKey: string) => fetch(`${gateway!.url}/api/ai/provider-settings/actions`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(1000), body: JSON.stringify({ type: "set_harness_enabled", harnessInstanceId: "claude_harness", enabled, idempotencyKey, expectedRevision }) });
  const stale = await write(before.revision - 1, false, "stale");
  expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ error: { code: "revision_conflict" }, latestRevision: before.revision });
  expect(await read()).toEqual(before);
  const success = await write(before.revision, false, "disable"); expect(success.status).toBe(200);
  const committed = ProviderSettingsSnapshotSchema.parse((await success.json()).snapshot);
  expect(committed.revision).toBe(before.revision + 1);
  const replay = await write(before.revision, false, "disable"); expect(replay.status).toBe(200);
  expect((await replay.json()).snapshot.revision).toBe(committed.revision);
  const reused = await write(before.revision, true, "disable"); expect(reused.status).toBe(409);
  expect((await reused.json()).error.code).toBe("idempotency_conflict");
  const restore = await write(committed.revision, true, "restore"); expect(restore.status).toBe(200);
  expect((await restore.json()).snapshot.revision).toBe(committed.revision + 1);
  gateway.setAuthenticated(false); expect((await read()).revision).toBe(committed.revision + 1);
  expect(gateway.commands).toHaveLength(0);
});

it("evicts old disable receipts without accepting their stale revisions", async () => {
  gateway = await startProviderAuthGateway(); gateway.setAuthenticated(true);
  const write = (expectedRevision: number, index: number) => fetch(`${gateway!.url}/api/ai/provider-settings/actions`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(1000), body: JSON.stringify({ type: "set_harness_enabled", harnessInstanceId: "claude_harness", enabled: index % 2 === 0, idempotencyKey: `bounded_${index}`, expectedRevision }) });
  for (let index = 0; index < 33; index++) expect((await write(2 + index, index)).status).toBe(200);
  expect((await write(34, 32)).status).toBe(200);
  const expired = await write(2, 0); expect(expired.status).toBe(409);
  expect((await expired.json()).error.code).toBe("revision_conflict");
  const snapshot = ProviderSettingsSnapshotSchema.parse(await (await fetch(`${gateway.url}/api/ai/provider-settings`, { signal: AbortSignal.timeout(1000) })).json());
  expect(snapshot.revision).toBe(35); expect(snapshot.accounts[0]?.authState).toBe("authenticated");
});
