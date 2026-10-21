import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createProviderGenericHarnessCoordinator } from "../../packages/gateway/src/ai-providers/provider-generic-harness-coordinator.js";
import { createClaudeNativeAccountMetadataReader, normalizeClaudeNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/claude-native-account-metadata.js";
import { createNativeProviderWorkflowAdapters } from "../../packages/gateway/src/ai-providers/provider-workflow-native.js";
import { createProviderTerminalLoginHandoff } from "../../packages/gateway/src/ai-providers/provider-terminal-login-handoff.js";
import { createProviderWorkflowService } from "../../packages/gateway/src/ai-providers/provider-workflows.js";
import { createNativeProviderWriterLease } from "../../packages/gateway/src/ai-providers/native-provider-writer-lease.js";

const roots: string[] = [], services: AiProviderService[] = [];
afterEach(async () => { services.splice(0).forEach(service => service.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(unboundProof = false) {
  const root = await mkdtemp(join(tmpdir(), "claude-completion-admission-")); roots.push(root);
  const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
  let loggedIn = true, principal = "fixture@example.invalid", installed = true;
  let currentTime = new Date();
  const runCommand = vi.fn(async () => ({ stdout: JSON.stringify({ loggedIn, authMethod: "claude.ai", apiProvider: "firstParty",
    email: principal, subscriptionType: "max", configDirectory: join(home, ".claude") }) }));
  const readMetadata = createClaudeNativeAccountMetadataReader({ executable: "synthetic-native-cli", cwd: home, environment: { HOME: home }, runCommand, now: () => currentTime });
  const systemUpdate = vi.fn(async () => { throw new Error("fixed native completion cannot change system routing"); });
  const systemRead = vi.fn(async () => { throw new Error("fixed native completion cannot inspect system routing"); });
  const runtime = createProviderGenericHarnessCoordinator({ homePath: home, enabledCodingHarnesses: [], runtimeController: { update: systemUpdate }, runtimeSource: systemRead });
  const service = new AiProviderService({ homePath: home, env: { ANTHROPIC_API_KEY: "synthetic-existing-key" }, exposeClaudeProfileAccount: true,
    driverInventory: async () => [{ id: "claude_code", displayName: "Claude Code", installState: installed ? "installed" : "missing", kind: "cli", health: "ready", setupActions: [], capabilities: ["tools", "resume"] }] }); services.push(service);
  const store = new ProviderSettingsStore({ homePath: home, privateRootPath: join(root, "private"), providerSnapshotReader: service,
    loginCoordinator: { supportedMethods: () => ["terminal"], startLogin: async () => { throw new Error("native adoption must not start login"); } },
    runtimeCoordinator: runtime, claudeNativeAccountMetadataReader: unboundProof ? async () => normalizeClaudeNativeAccountMetadata({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: principal, configDirectory: join(home, ".claude") }, home, new Date()) : readMetadata });
  const initial = await store.getSnapshot(), harness = initial.harnesses.find(row => row.harness === "claude")!;
  await store.mutate({ type: "set_harness_enabled", harnessInstanceId: harness.id, enabled: false, expectedRevision: initial.revision, idempotencyKey: "fixture-off" });
  // Represent an existing owner API-key selection without enabling public route writes.
  const config = JSON.parse(await readFile(store.configurationPath, "utf8"));
  const saved = config.harnesses.find((row: { id: string }) => row.id === harness.id);
  saved.accessSourceId = "owner_anthropic_key"; saved.selectedAccountId = "owner_anthropic";
  await writeFile(store.configurationPath, JSON.stringify(config));
  const before = await store.getSnapshot();
  const input = { harnessInstanceId: harness.id, expectedRevision: before.revision, idempotencyKey: "fixture-complete" };
  return { store, before, input, runtime, systemRead, systemUpdate, readMetadata, runCommand, home,
    expireProof: () => { currentTime = new Date(+currentTime + 31_000); },
    setLoggedIn: (value: boolean) => { loggedIn = value; }, setPrincipal: (value: string) => { principal = value; },
    removeDriver: () => { installed = false;  } };
}

it("completes the production fixed Claude client, selects the verified subscription rather than its saved key, and replays without reenabling", async () => {
  const f = await fixture();
  const complete = await f.store.completeClaudeNativeLogin(f.input);
  const connected = complete.snapshot.harnesses.find(row => row.id === f.input.harnessInstanceId)!;
  expect(connected).toMatchObject({ accessSourceId: "owner_claude_profile", selectedAccountId: "owner_claude_profile", enabled: true, configuredEnabled: true });
  expect(connected.route).toEqual(f.before.harnesses.find(row => row.id === connected.id)!.route);
  expect(f.runtime.supportedActions).not.toContain("select_access_source");
  await expect(f.store.mutate({ ...f.input, expectedRevision: complete.snapshot.revision, type: "select_access_source", accessSourceId: "owner_anthropic_key", enableHarness: true, idempotencyKey: "public-selection" })).rejects.toMatchObject({ code: "runtime_unavailable" });
  const off = await f.store.mutate({ type: "set_harness_enabled", harnessInstanceId: connected.id, expectedRevision: complete.snapshot.revision, enabled: false, idempotencyKey: "owner-disconnect" });
  const replay = await f.store.completeClaudeNativeLogin(f.input);
  expect(replay.snapshot.revision).toBe(off.snapshot.revision);
  expect(replay.snapshot.harnesses.find(row => row.id === connected.id)?.configuredEnabled).toBe(false);
  expect(f.systemRead).not.toHaveBeenCalled(); expect(f.systemUpdate).not.toHaveBeenCalled();
});

it("foreground workflow adopts through the production Terminal facade/store/coordinator and replay preserves later Off", async () => {
  const f = await fixture();
  const terminal = { ensureWorkspace: vi.fn(), createTab: vi.fn(), terminateTab: vi.fn(), attach: vi.fn(), listWorkspaces: vi.fn() };
  const browserLogin = vi.fn(async () => ({ cancel: vi.fn(async () => {}), submitCode: vi.fn(async () => {}) }));
  const resolver = vi.fn(async () => { throw new Error("native adoption must not resolve Terminal"); });
  const adapters = await createNativeProviderWorkflowAdapters({
    store: createProviderTerminalLoginHandoff(f.store, resolver), terminal,
    runtimePrefix: "/synthetic/native-adoption-runtime", hostControl: { available: false, run: vi.fn() },
    claudeBrowserLogin: browserLogin,
  });
  const workflows = createProviderWorkflowService({ ownerId: "fixture-owner", adapters });
  const request = { harnessInstanceId: f.input.harnessInstanceId, optionId: "anthropic_browser", idempotencyKey: "foreground-existing-native" };
  try {
    await expect(workflows.startV2("other-owner", request)).rejects.toMatchObject({ code: "forbidden" });
    expect((await workflows.startV2("fixture-owner", request)).state).toBe("succeeded");
    const connected = await f.store.getSnapshot({ refresh: true, includeNativeAccountMetadata: true, includeNativeAccountUsage: false });
    expect(connected.harnesses.find(row => row.id === request.harnessInstanceId)).toMatchObject({
      configuredEnabled: true, accessSourceId: "owner_claude_profile", selectedAccountId: "owner_claude_profile", authState: "authenticated",
    });
    expect(f.runCommand).toHaveBeenCalled();
    const off = await f.store.mutate({ type: "set_harness_enabled", harnessInstanceId: request.harnessInstanceId,
      expectedRevision: connected.revision, enabled: false, idempotencyKey: "foreground-owner-off" });
    expect((await workflows.startV2("fixture-owner", request)).state).toBe("succeeded");
    const replayed = await f.store.getSnapshot();
    expect(replayed.revision).toBe(off.snapshot.revision);
    expect(replayed.harnesses.find(row => row.id === request.harnessInstanceId)?.configuredEnabled).toBe(false);
    expect(browserLogin).not.toHaveBeenCalled(); expect(resolver).not.toHaveBeenCalled();
    expect(terminal.createTab).not.toHaveBeenCalled(); expect(terminal.attach).not.toHaveBeenCalled();
    expect(f.systemRead).not.toHaveBeenCalled(); expect(f.systemUpdate).not.toHaveBeenCalled();
  } finally { await workflows.close(); }
});

it("failed adoption never falls back to OAuth and releases no-resource workflow admission for an explicit retry", async () => {
  const f = await fixture();
  const complete = vi.spyOn(f.store, "completeClaudeNativeLogin").mockRejectedValueOnce(new Error("synthetic ambiguous completion"));
  const browserLogin = vi.fn(async () => ({ cancel: vi.fn(async () => {}), submitCode: vi.fn(async () => {}) }));
  const terminal = { ensureWorkspace: vi.fn(), createTab: vi.fn(), terminateTab: vi.fn(), attach: vi.fn(), listWorkspaces: vi.fn() };
  const adapters = await createNativeProviderWorkflowAdapters({ store: f.store, terminal,
    runtimePrefix: "/synthetic/native-adoption-runtime", hostControl: { available: false, run: vi.fn() }, claudeBrowserLogin: browserLogin });
  const workflows = createProviderWorkflowService({ ownerId: "fixture-owner", adapters });
  const request = { harnessInstanceId: f.input.harnessInstanceId, optionId: "anthropic_browser", idempotencyKey: "failed-adoption" };
  try {
    expect((await workflows.startV2("fixture-owner", request)).state).toBe("failed");
    expect(browserLogin).not.toHaveBeenCalled(); expect(terminal.createTab).not.toHaveBeenCalled();
    expect((await workflows.startV2("fixture-owner", { ...request, idempotencyKey: "explicit-adoption-retry" })).state).toBe("succeeded");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(browserLogin).not.toHaveBeenCalled();
  } finally { await workflows.close(); }
});

it.each(["signed-out", "changed-principal", "missing-driver", "stale-revision", "wrong-harness"] as const)("preserves the previous key and Off when completion admission rejects %s", async mode => {
  const f = await fixture();
  // A successful outer workflow/UI read cannot authorize the later commit.
  expect(await f.readMetadata()).not.toBeNull();
  if (mode === "signed-out") f.setLoggedIn(false);
  if (mode === "changed-principal") {
    f.runCommand.mockImplementationOnce(async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "old@example.invalid", configDirectory: join(roots.at(-1)!, "home/.claude") }) }));
    f.setPrincipal("new@example.invalid");
  }
  if (mode === "missing-driver") f.removeDriver();
  const input = { ...f.input, ...(mode === "stale-revision" ? { expectedRevision: f.input.expectedRevision - 1 } : {}), ...(mode === "wrong-harness" ? { harnessInstanceId: "harness_codex" } : {}) };
  await expect(f.store.completeClaudeNativeLogin(input)).rejects.toBeDefined();
  const after = await f.store.getSnapshot();
  expect(after.revision).toBe(f.before.revision);
  expect(after.harnesses.find(row => row.id === f.input.harnessInstanceId)).toMatchObject({ configuredAccessSourceId: "owner_anthropic_key", configuredEnabled: false });
  expect(f.systemRead).not.toHaveBeenCalled(); expect(f.systemUpdate).not.toHaveBeenCalled();
});

it.each(["principal", "driver", "proof-expiry"] as const)("compensates the real coordinator receipt if the native %s changes before owner settings commit", async mode => {
  const f = await fixture();
  const apply = f.runtime.applyConfiguration.bind(f.runtime);
  f.runtime.applyConfiguration = async input => {
    await apply(input);
    if (mode === "principal") f.setPrincipal("replacement@example.invalid");
    else if (mode === "proof-expiry") f.expireProof();
    else f.removeDriver();
  };
  await expect(f.store.completeClaudeNativeLogin(f.input)).rejects.toMatchObject({ code: "invalid_route" });
  const after = await f.store.getSnapshot();
  expect(after.revision).toBe(f.before.revision);
  expect(after.harnesses.find(row => row.id === f.input.harnessInstanceId)).toMatchObject({ configuredAccessSourceId: "owner_anthropic_key", configuredEnabled: false });
  const config = JSON.parse(await readFile(f.store.configurationPath, "utf8"));
  expect(config.receipts.some((receipt: { key: string }) => receipt.key === f.input.idempotencyKey)).toBe(false);
  const runtimeReceipts = JSON.parse(await readFile(join(roots.at(-1)!, "home/system/ai-providers/runtime-receipts.json"), "utf8"));
  expect(runtimeReceipts.receipts.some((receipt: { key: string }) => receipt.key === f.input.idempotencyKey)).toBe(false);
});

it("a busy real native writer rejects selection and preserves the previous source and Off", async () => {
  const f = await fixture();
  const release = await createNativeProviderWriterLease(f.home).acquire("claude");
  try {
    await expect(f.store.completeClaudeNativeLogin(f.input)).rejects.toMatchObject({ code: "invalid_route" });
    const after = await f.store.getSnapshot();
    expect(after.revision).toBe(f.before.revision);
    expect(after.harnesses.find(row => row.id === f.input.harnessInstanceId)).toMatchObject({
      configuredAccessSourceId: "owner_anthropic_key", configuredEnabled: false,
    });
    expect(f.systemRead).not.toHaveBeenCalled(); expect(f.systemUpdate).not.toHaveBeenCalled();
  } finally { await release(); }
});


it("rejects an authenticated-looking metadata object without the private current-principal binding", async () => {
  const f = await fixture(true);
  await expect(f.store.completeClaudeNativeLogin(f.input)).rejects.toMatchObject({ code: "invalid_route" });
  const after = await f.store.getSnapshot();
  expect(after.revision).toBe(f.before.revision);
  expect(after.harnesses.find(row => row.id === f.input.harnessInstanceId)).toMatchObject({ configuredAccessSourceId: "owner_anthropic_key", configuredEnabled: false });
  expect(f.systemRead).not.toHaveBeenCalled();
  expect(f.systemUpdate).not.toHaveBeenCalled();
});

it("does not accept a trusted-completion flag from a public settings mutation", async () => {
  const f = await fixture();
  const forged = { ...f.input, type: "select_access_source" as const, accessSourceId: "owner_claude_profile", enableHarness: true, claudeNativeCompletion: true };
  await expect(f.store.mutate(forged)).rejects.toMatchObject({ code: "invalid_request" });
  const after = await f.store.getSnapshot();
  expect(after.revision).toBe(f.before.revision);
  expect(after.harnesses.find(row => row.id === f.input.harnessInstanceId)?.configuredEnabled).toBe(false);
  expect(f.runCommand).not.toHaveBeenCalled();
});
