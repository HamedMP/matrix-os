import { mkdtemp, rm, readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createDefaultProviderCliAccountLifecycleCoordinator } from "../../packages/gateway/src/ai-providers/provider-cli-account-lifecycle.js";
import { createClaudeNativeAccountMetadataReader } from "../../packages/gateway/src/ai-providers/claude-native-account-metadata.js";
import { createNativeProviderProfileGuard } from "../../packages/gateway/src/ai-providers/native-provider-profile-guard.js";
import { createNativeProviderWriterLease } from "../../packages/gateway/src/ai-providers/native-provider-writer-lease.js";
import { readOwnerAnthropicKey, createOwnerAnthropicKeySaver } from "../../packages/gateway/src/ai-providers/owner-anthropic-key.js";

const homes: string[] = [], services: AiProviderService[] = [];
afterEach(async () => { vi.unstubAllEnvs(); services.splice(0).forEach(service => service.close()); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function fixture(key = false, legacyProfile = false) {
  const homePath = await mkdtemp(join(tmpdir(), "claude-native-lifecycle-")); homes.push(homePath);
  let legacyInUse = false, unknownWriter = false;
  let loggedIn = true, email = "synthetic@example.invalid", org = "synthetic-org", fail = false;
  const runStatus = vi.fn(async () => {
    if (fail) throw new Error("synthetic-private-error");
    return { stdout: JSON.stringify({ loggedIn, email, orgId: org, authMethod: "claude.ai", apiProvider: "firstParty", configDirectory: join(homePath, ".claude") }) };
  });
  const readMetadata = createClaudeNativeAccountMetadataReader({ executable: "claude", cwd: homePath, environment: { HOME: homePath }, runCommand: runStatus });
  const guard = createNativeProviderProfileGuard({ homePath, registry: {
    listProfileSessions: async () => unknownWriter ? [{ name: "synthetic-unknown-writer", agent: "claude" }] : [], get: async () => { throw Object.assign(new Error("missing"), { code: "session_not_found" }); }, observeAgentLiveness: async () => unknownWriter ? "unknown" : "stopped",
  } });
  const readUnderLease = createClaudeNativeAccountMetadataReader({ executable: "claude", cwd: homePath, environment: { HOME: homePath }, runCommand: runStatus,
    assertProfileAvailable: async () => { await expect(createNativeProviderWriterLease(homePath).assertAvailable("claude")).rejects.toBeDefined(); },
  });
  const runLogout = vi.fn(async () => { loggedIn = false; return { stdout: "", stderr: "" }; });
  const lifecycle = createDefaultProviderCliAccountLifecycleCoordinator({ homePath, enabledHarnesses: ["claude"], run: runLogout, profileGuard: guard, readClaudeAccountUnderLease: readUnderLease });
  const service = new AiProviderService({ homePath, env: {}, exposeClaudeProfileAccount: true, driverInventory: async () => [{ id: "claude_code", displayName: "Claude Code", kind: "cli", installState: "installed", health: "ready", setupActions: [], capabilities: ["tools", "resume"] }] }); services.push(service);
  if (key) await createOwnerAnthropicKeySaver({ homePath })("synthetic-private-key");
  const reader = { getSnapshot: async (options?: Parameters<typeof service.getSnapshot>[0]) => {
    const canonical = await service.getSnapshot(options);
    if (legacyProfile) Object.assign(canonical.accounts.find(row => row.id === "owner_anthropic")!, { authMethod: "provider_profile", state: "ready", action: "none", safeReason: null });
    return canonical;
  } };
  const store = new ProviderSettingsStore({ homePath, providerSnapshotReader: reader, claudeNativeAccountMetadataReader: readMetadata, accountLifecycle: lifecycle,
    dependencyCoordinator: { getAccountDependencies: async ({ accountId }) => ({ activeChatCount: legacyInUse && accountId === "owner_anthropic" ? 1 : 0, resumableChatCount: 0, harnessInstanceCount: 0 }), reassignDependencies: async () => {} },
  });
  const snapshot = await store.getSnapshot({ includeNativeAccountMetadata: true, includeNativeAccountUsage: false });
  return { homePath, store, snapshot, service, runLogout, guard, lifecycle, readMetadata,
    legacyInUse: () => { legacyInUse = true; }, unknownWriter: () => { unknownWriter = true; },
    changeEmail: () => { email = "replacement@example.invalid"; }, changeOrg: () => { org = "replacement-org"; }, failStatus: () => { fail = true; } };
}

it.each([false, true])("advertises and executes owner-native logout with independent key=%s", async key => {
  const f = await fixture(key);
  expect((await f.service.getSnapshot()).accounts.find(row => row.id === "owner_claude_profile")?.state).toBe("unknown");
  expect(f.snapshot.accounts.find(row => row.id === "owner_claude_profile")?.authState).toBe("authenticated");
  expect(f.snapshot.supportedActions).toContain("logout_account");
  const mutation = { type: "logout_account" as const, accountId: "owner_claude_profile", expectedRevision: f.snapshot.revision, idempotencyKey: "native-logout" };
  await f.store.mutate(mutation);
  await f.store.mutate(mutation);
  expect(f.runLogout).toHaveBeenCalledOnce();
  expect((await f.store.getSnapshot({ includeNativeAccountMetadata: true, includeNativeAccountUsage: false })).accounts.find(row => row.id === "owner_claude_profile")?.authState).not.toBe("authenticated");
  if (key) expect((await readOwnerAnthropicKey(f.homePath)).key).toBe("synthetic-private-key");
  expect(await readFile(join(f.homePath, "system/ai-providers/lifecycle-receipts.json"), "utf8")).not.toMatch(/synthetic@example|synthetic-org|nativeClaudeAccount|principal|stdout/);
});

it("removes only the native account record after exact dependency check", async () => {
  const f = await fixture(true);
  await f.store.mutate({ type: "remove_account", accountId: "owner_claude_profile", expectedRevision: f.snapshot.revision, idempotencyKey: "native-remove", confirmation: "remove_account", dependencyGuard: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 } });
  expect(f.runLogout).toHaveBeenCalledOnce();
  expect((await readOwnerAnthropicKey(f.homePath)).key).toBe("synthetic-private-key");
  const config = JSON.parse(await readFile(f.store.configurationPath, "utf8"));
  expect(config.accountProfiles.some((row: { id: string }) => row.id === "owner_claude_profile")).toBe(false);
  expect(config.accountProfiles.some((row: { id: string }) => row.id === "owner_anthropic")).toBe(true);
});

it.each(["email", "org", "unavailable"] as const)("refuses native logout if %s changes after admission observation", async mode => {
  const f = await fixture();
  const original = f.guard.run.bind(f.guard);
  f.guard.run = async (profile, admission, operation) => {
    if (mode === "email") f.changeEmail(); else if (mode === "org") f.changeOrg(); else f.failStatus();
    return original(profile, admission, operation);
  };
  await expect(f.store.mutate({ type: "logout_account", accountId: "owner_claude_profile", expectedRevision: f.snapshot.revision, idempotencyKey: "drift-logout" })).rejects.toMatchObject({ code: "lifecycle_unavailable" });
  expect(f.runLogout).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(f.store.configurationPath, "utf8")).revision).toBe(f.snapshot.revision);
});

it("does not admit native logout while a durable writer is active", async () => {
  const f = await fixture();
  const release = await createNativeProviderWriterLease(f.homePath).acquire("claude");
  try {
    await expect(f.store.mutate({ type: "logout_account", accountId: "owner_claude_profile", expectedRevision: f.snapshot.revision, idempotencyKey: "busy-logout" })).rejects.toMatchObject({ code: "lifecycle_unavailable" });
    expect(f.runLogout).not.toHaveBeenCalled();
  } finally { await release(); }
});

it("rejects a stale revision before obtaining a native logout proof", async () => {
  const f = await fixture();
  const config = JSON.parse(await readFile(f.store.configurationPath, "utf8")); config.revision += 1;
  await writeFile(f.store.configurationPath, JSON.stringify(config));
  await expect(f.store.mutate({ type: "logout_account", accountId: "owner_claude_profile", expectedRevision: f.snapshot.revision, idempotencyKey: "stale-logout" })).rejects.toMatchObject({ code: "revision_conflict" });
  expect(f.runLogout).not.toHaveBeenCalled();
});


it("wires the default native status reader to the exact owner HOME under its own lease", async () => {
  const f = await fixture();
  const bin = join(f.homePath, "synthetic-bin"); await mkdir(bin);
  const cli = join(bin, "claude");
  const lease = join(dirname(f.homePath), ".matrix-private", basename(f.homePath), "native-writers/claude.json");
  await writeFile(cli, `#!/bin/sh
[ "$1 $2 $3" = "auth status --json" ] || exit 2
[ "$HOME" = '${f.homePath}' ] || exit 3
[ -f '${lease}' ] || exit 4
printf '%s' '{"loggedIn":true,"email":"synthetic@example.invalid","orgId":"synthetic-org","authMethod":"claude.ai","apiProvider":"firstParty","configDirectory":"${join(f.homePath, ".claude")}"}'
`);
  await chmod(cli, 0o700);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  const lifecycle = createDefaultProviderCliAccountLifecycleCoordinator({ homePath: f.homePath, enabledHarnesses: ["claude"], profileGuard: f.guard, run: f.runLogout });
  const store = new ProviderSettingsStore({ homePath: f.homePath, providerSnapshotReader: f.service, claudeNativeAccountMetadataReader: f.readMetadata, accountLifecycle: lifecycle });
  await store.mutate({ type: "logout_account", accountId: "owner_claude_profile", expectedRevision: f.snapshot.revision, idempotencyKey: "default-reader-logout" });
  expect(f.runLogout).toHaveBeenCalledOnce();
  await expect(createNativeProviderWriterLease(f.homePath).assertAvailable("claude")).resolves.toBeUndefined();
});

it("cannot use another HOME's privately bound metadata to authorize this profile", async () => {
  const first = await fixture(), other = await fixture();
  const proof = await other.readMetadata();
  const canonical = await first.service.getSnapshot();
  const native = canonical.accounts.find(row => row.id === "owner_claude_profile")!;
  await expect(first.lifecycle.logout({ account: { id: native.id, providerId: "anthropic", driverId: "claude_code", harness: "claude", authMethod: "terminal", accessSourceId: "owner_claude_profile", installState: "installed", driverAccountCount: 1, authenticated: true, nativeClaudeAccount: proof! }, idempotencyKey: "foreign-home-proof" })).rejects.toBeDefined();
  expect(first.runLogout).not.toHaveBeenCalled();
});


it("includes an in-use legacy alias in native profile dependency guards", async () => {
  const f = await fixture(false, true); f.legacyInUse();
  const snapshot = await f.store.getSnapshot({ includeNativeAccountMetadata: true, includeNativeAccountUsage: false });
  const dependencies = snapshot.accounts.find(row => row.id === "owner_claude_profile")!.dependencies;
  expect(dependencies.activeChatCount).toBe(1);
  await expect(f.store.mutate({ type: "remove_account", accountId: "owner_claude_profile", expectedRevision: snapshot.revision, idempotencyKey: "alias-in-use-remove", confirmation: "remove_account", dependencyGuard: dependencies })).rejects.toMatchObject({ code: "account_in_use" });
  expect(f.runLogout).not.toHaveBeenCalled();
});


it("rejects unknown native writer liveness without starting a destructive command", async () => {
  const f = await fixture(); f.unknownWriter();
  await expect(f.store.mutate({ type: "logout_account", accountId: "owner_claude_profile", expectedRevision: f.snapshot.revision, idempotencyKey: "unknown-writer-logout" })).rejects.toMatchObject({ code: "lifecycle_unavailable" });
  expect(f.runLogout).not.toHaveBeenCalled();
});

it("does not treat a ready API-key account as an authenticated legacy subscription alias", async () => {
  const f = await fixture(true);
  const config = JSON.parse(await readFile(f.store.configurationPath, "utf8"));
  const key = config.accountProfiles.find((row: { id: string }) => row.id === "owner_anthropic");
  key.authMethod = "terminal"; key.accessSourceId = "owner_anthropic_profile";
  await writeFile(f.store.configurationPath, JSON.stringify(config));
  await expect(f.store.mutate({ type: "logout_account", accountId: "owner_anthropic", expectedRevision: f.snapshot.revision, idempotencyKey: "stale-legacy-profile" })).rejects.toMatchObject({ code: "lifecycle_unavailable" });
  expect(f.runLogout).not.toHaveBeenCalled();
  expect((await readOwnerAnthropicKey(f.homePath)).key).toBe("synthetic-private-key");
});
