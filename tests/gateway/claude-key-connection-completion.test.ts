import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createProviderGenericHarnessCoordinator } from "../../packages/gateway/src/ai-providers/provider-generic-harness-coordinator.js";
import { createOwnerAnthropicKeySaver, readOwnerAnthropicKey, revokeOwnerAnthropicKey } from "../../packages/gateway/src/ai-providers/owner-anthropic-key.js";
import { NativeProviderWriteRestoredError } from "../../packages/gateway/src/ai-providers/native-provider-profile-guard.js";

const roots: string[] = [], services: AiProviderService[] = [];
afterEach(async () => { services.splice(0).forEach(service => service.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(options: { installed?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "claude-key-completion-")); roots.push(root);
  const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
  let installed = options.installed ?? true;
  const systemUpdate = vi.fn(async () => { throw new Error("fixed key completion cannot change system routing"); });
  const systemRead = vi.fn(async () => { throw new Error("fixed key completion cannot inspect system routing"); });
  const runtime = createProviderGenericHarnessCoordinator({ homePath: home, enabledCodingHarnesses: [], runtimeController: { update: systemUpdate }, runtimeSource: systemRead });
  const service = new AiProviderService({ homePath: home, env: {},
    driverInventory: async () => [{ id: "claude_code", displayName: "Claude Code", installState: installed ? "installed" : "missing", kind: "cli", health: "ready", setupActions: [], capabilities: ["tools", "resume"] }] }); services.push(service);
  const store = new ProviderSettingsStore({ homePath: home, privateRootPath: join(root, "private"), providerSnapshotReader: service, runtimeCoordinator: runtime });
  const initial = await store.getSnapshot(), harness = initial.harnesses.find(row => row.harness === "claude")!;
  const off = await store.mutate({ type: "set_harness_enabled", harnessInstanceId: harness.id, enabled: false, expectedRevision: initial.revision, idempotencyKey: "fixture-off" });
  const input = { harnessInstanceId: harness.id, expectedRevision: off.snapshot.revision, idempotencyKey: "fixture-key-complete" };
  // Production order: publish the verified key, then complete inside the saver's commit.
  const connect = () => createOwnerAnthropicKeySaver({ homePath: home }).connect("synthetic-owner-key", async () => {
    const current = await store.getSnapshot({ refresh: true });
    await store.completeClaudeKeyConnection({ ...input, expectedRevision: current.revision });
  });
  return { home, store, input, runtime, systemRead, systemUpdate, connect, removeDriver: () => { installed = false; } };
}

it("switches fixed Claude to the verified owner API key and turns it on", async () => {
  const f = await fixture();
  await f.connect();
  const done = { snapshot: await f.store.getSnapshot() };
  expect(done.snapshot.harnesses.find(row => row.id === f.input.harnessInstanceId)).toMatchObject({
    accessSourceId: "owner_anthropic_key", selectedAccountId: "owner_anthropic", enabled: true, configuredEnabled: true });
  expect(f.systemRead).not.toHaveBeenCalled(); expect(f.systemUpdate).not.toHaveBeenCalled();
  // Replay with the same key returns the committed result without a second write.
  const replay = await f.store.completeClaudeKeyConnection({ ...f.input, expectedRevision: f.input.expectedRevision });
  expect(replay.snapshot.revision).toBe(done.snapshot.revision);
});

it("keeps the public access-source write refused for fixed Claude", async () => {
  const f = await fixture();
  expect(f.runtime.supportedActions).not.toContain("select_access_source");
  await expect(f.store.mutate({ ...f.input, type: "select_access_source", accessSourceId: "owner_anthropic_key", enableHarness: true }))
    .rejects.toMatchObject({ code: "runtime_unavailable" });
});

it("refuses key completion when no owner key is saved", async () => {
  const f = await fixture();
  await expect(f.store.completeClaudeKeyConnection(f.input)).rejects.toMatchObject({ code: "invalid_route" });
  const after = await f.store.getSnapshot();
  expect(after.revision).toBe(f.input.expectedRevision);
  expect(after.harnesses.find(row => row.id === f.input.harnessInstanceId)?.configuredEnabled).toBe(false);
});

it("rolls the staged key back and keeps Claude Off when the driver is missing", async () => {
  const f = await fixture();
  f.removeDriver();
  // The saver restores the previous key state when completion refuses.
  await expect(f.connect()).rejects.toBeInstanceOf(NativeProviderWriteRestoredError);
  expect((await readOwnerAnthropicKey(f.home)).state).not.toBe("unverified");
  const after = await f.store.getSnapshot();
  expect(after.revision).toBe(f.input.expectedRevision);
  expect(after.harnesses.find(row => row.id === f.input.harnessInstanceId)?.configuredEnabled).toBe(false);
});

it("reports fixed Claude as signed in on the saved owner key, and signed out once the key is removed", async () => {
  const f = await fixture();
  await f.connect();
  const connected = (await f.store.getSnapshot({ refresh: true })).harnesses.find(row => row.id === f.input.harnessInstanceId)!;
  expect(connected).toMatchObject({ accessSourceId: "owner_anthropic_key", authState: "authenticated" });
  await revokeOwnerAnthropicKey(f.home);
  const removed = (await f.store.getSnapshot({ refresh: true })).harnesses.find(row => row.id === f.input.harnessInstanceId)!;
  expect(removed.authState).not.toBe("authenticated");
});
