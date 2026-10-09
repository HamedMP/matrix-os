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
afterEach(async () => { vi.unstubAllEnvs(); services.splice(0).forEach(service => service.close()); await Promise.all(homes.splice(0).flatMap(home => [rm(home, { recursive: true, force: true }), rm(join(dirname(home), ".matrix-private", basename(home)), { recursive: true, force: true })])); });
async function fixture(key = false, legacyProfile = false) {
  const homePath = await mkdtemp(join(tmpdir(), "claude-native-lifecycle-")); homes.push(homePath);
  let legacyInUse = false, unknownWriter = false;
  let loggedIn = true, email = "synthetic@example.invalid", org = "synthetic-org", fail = false;
  const runStatus = vi.fn(async () => {
    if (fail) throw new Error("synthetic-private-error");
    if (!loggedIn) throw Object.assign(new Error("synthetic-signed-out"), { code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty", configDirectory: join(homePath, ".claude") }), stderr: "" });
    return { stdout: JSON.stringify({ loggedIn, email, orgId: org, authMethod: "claude.ai", apiProvider: "firstParty", configDirectory: join(homePath, ".claude") }) };
  });
  const readMetadata = createClaudeNativeAccountMetadataReader({ executable: "claude", cwd: homePath, environment: { HOME: homePath }, runCommand: runStatus,
    usageReader: async () => ({ usage: { kind: "subscription_allowance", authority: "provider_allowance", state: "current", scope: "account", usedBasisPoints: 4200, resetsAt: new Date(Date.now() + 3600000).toISOString(), asOf: new Date().toISOString() }, isCurrent: async () => loggedIn }),
  });
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
    signOut: () => { loggedIn = false; }, signIn: () => { loggedIn = true; },
    changeEmail: () => { email = "replacement@example.invalid"; }, changeOrg: () => { org = "replacement-org"; }, failStatus: () => { fail = true; } };
}

it.each([false, true])("advertises and executes owner-native logout with independent key=%s", async key => {
  const f = await fixture(key);
  expect((await f.service.getSnapshot()).accounts.find(row => row.id === "owner_claude_profile")?.state).toBe("unknown");
  expect(f.snapshot.accounts.find(row => row.id === "owner_claude_profile")?.authState).toBe("authenticated");
  expect(f.snapshot.supportedActions).toContain("logout_account");
  const mutation = { type: "logout_account" as const, accountId: "owner_claude_profile", expectedRevision: f.snapshot.revision, idempotencyKey: "native-logout" };
  const response = await f.store.mutate(mutation);
  expect(response.snapshot.accounts.find(row => row.id === "owner_claude_profile")?.authState).not.toBe("authenticated");
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


it("removes the logged-out native record without running logout again", async () => {
  const f = await fixture(true);
  const loggedOut = await f.store.mutate({ type: "logout_account", accountId: "owner_claude_profile", expectedRevision: f.snapshot.revision, idempotencyKey: "logout-before-remove" });
  const removal = { type: "remove_account" as const, accountId: "owner_claude_profile", expectedRevision: loggedOut.snapshot.revision, idempotencyKey: "remove-after-logout", confirmation: "remove_account" as const, dependencyGuard: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 } };
  await mkdir(dirname(f.store.secretsPath), { recursive: true });
  await writeFile(f.store.secretsPath, JSON.stringify({ version: 1, accounts: { owner_claude_profile: "synthetic-native-private-value", owner_anthropic: "synthetic-independent-value" } }), { mode: 0o600 });
  await f.store.mutate(removal);
  const secrets = JSON.parse(await readFile(f.store.secretsPath, "utf8"));
  expect(secrets.accounts.owner_claude_profile).toBeUndefined();
  expect(secrets.accounts.owner_anthropic).toBe("synthetic-independent-value");
  const config = JSON.parse(await readFile(f.store.configurationPath, "utf8"));
  expect(config.accountProfiles.some((row: { id: string }) => row.id === "owner_claude_profile")).toBe(false);
  f.failStatus(); // Completed receipts remain replayable without a current identity.
  const replay = await f.store.mutate(removal);
  const descriptor = replay.snapshot.accounts.find(row => row.id === "owner_claude_profile");
  expect(descriptor?.authState).not.toBe("authenticated");
  expect(descriptor?.connectionDetails?.email).toBeUndefined();
  expect(replay.snapshot.accessSources.find(row => row.id === "owner_claude_profile")?.usage.kind).toBe("unavailable");
  expect(JSON.stringify(replay)).not.toContain("synthetic@example.invalid");
  expect(f.runLogout).toHaveBeenCalledOnce();
  expect((await readOwnerAnthropicKey(f.homePath)).key).toBe("synthetic-private-key");
});


it.each(["login", "unavailable"] as const)("refuses signed-out removal when %s appears under the admitted lease", async mode => {
  const f = await fixture(true); f.signOut();
  const original = f.guard.run.bind(f.guard);
  f.guard.run = async (profile, admission, operation) => {
    if (mode === "login") f.signIn(); else f.failStatus();
    return original(profile, admission, operation);
  };
  await expect(f.store.mutate({ type: "remove_account", accountId: "owner_claude_profile", expectedRevision: f.snapshot.revision, idempotencyKey: `signed-out-${mode}`, confirmation: "remove_account", dependencyGuard: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 } })).rejects.toMatchObject({ code: "lifecycle_unavailable" });
  expect(f.runLogout).not.toHaveBeenCalled();
  const config = JSON.parse(await readFile(f.store.configurationPath, "utf8"));
  expect(config.revision).toBe(f.snapshot.revision);
  expect(config.accountProfiles.some((row: { id: string }) => row.id === "owner_claude_profile")).toBe(true);
  await expect(readFile(join(f.homePath, "system/ai-providers/lifecycle-receipts.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(createNativeProviderWriterLease(f.homePath).assertAvailable("claude")).resolves.toBeUndefined();
});

it("does not substitute null metadata for proven signed-out removal", async () => {
  const f = await fixture(); f.failStatus();
  await expect(f.store.mutate({ type: "remove_account", accountId: "owner_claude_profile", expectedRevision: f.snapshot.revision, idempotencyKey: "unknown-remove", confirmation: "remove_account", dependencyGuard: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 } })).rejects.toMatchObject({ code: "lifecycle_unavailable" });
  expect(f.runLogout).not.toHaveBeenCalled();
});

it("omits old identity and allowance from the immediate response even if post-logout status fails", async () => {
  const f = await fixture();
  const previous = await f.readMetadata(true);
  expect(previous?.connectionDetails?.email).toBe("synthetic@example.invalid");
  expect(previous?.usage?.usedBasisPoints).toBe(4200);
  f.runLogout.mockImplementation(async () => { f.signOut(); f.failStatus(); return { stdout: "", stderr: "" }; });
  const response = await f.store.mutate({ type: "logout_account", accountId: "owner_claude_profile", expectedRevision: f.snapshot.revision, idempotencyKey: "post-logout-unavailable" });
  const account = response.snapshot.accounts.find(row => row.id === "owner_claude_profile")!;
  expect(account.authState).not.toBe("authenticated");
  expect(account.connectionDetails?.email).toBeUndefined();
  expect(JSON.stringify(response)).not.toContain("synthetic@example.invalid");
  expect(response.snapshot.accessSources.find(row => row.id === "owner_claude_profile")?.usage.kind).toBe("unavailable");
});


it("advertises removal but not logout for a freshly proven signed-out native profile", async () => {
  const f = await fixture(); f.signOut();
  const snapshot = await f.store.getSnapshot({ includeNativeAccountMetadata: true, includeNativeAccountUsage: false });
  expect(snapshot.supportedActions).toContain("remove_account");
  expect(snapshot.supportedActions).not.toContain("logout_account");
  expect(snapshot.accounts.find(row => row.id === "owner_claude_profile")?.authState).not.toBe("authenticated");
});

it("checks signed-out status with the default CLI reader under the actual durable lease", async () => {
  const f = await fixture(); f.signOut();
  const bin = join(f.homePath, "synthetic-bin"); await mkdir(bin);
  const cli = join(bin, "claude");
  const lease = join(dirname(f.homePath), ".matrix-private", basename(f.homePath), "native-writers/claude.json");
  await writeFile(cli, `#!/bin/sh
[ "$1 $2 $3" = "auth status --json" ] || exit 2
[ "$HOME" = '${f.homePath}' ] || exit 3
[ -f '${lease}' ] || exit 4
printf '%s' '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty","configDirectory":"${join(f.homePath, ".claude")}"}'
exit 1
`);
  await chmod(cli, 0o700); vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  const lifecycle = createDefaultProviderCliAccountLifecycleCoordinator({ homePath: f.homePath, enabledHarnesses: ["claude"], profileGuard: f.guard, run: f.runLogout });
  const store = new ProviderSettingsStore({ homePath: f.homePath, providerSnapshotReader: f.service, claudeNativeAccountMetadataReader: f.readMetadata, accountLifecycle: lifecycle, dependencyCoordinator: { getAccountDependencies: async () => ({ activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 }), reassignDependencies: async () => {} } });
  await store.mutate({ type: "remove_account", accountId: "owner_claude_profile", expectedRevision: f.snapshot.revision, idempotencyKey: "default-reader-signed-out-remove", confirmation: "remove_account", dependencyGuard: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 0 } });
  expect(f.runLogout).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(store.configurationPath, "utf8")).accountProfiles.some((row: { id: string }) => row.id === "owner_claude_profile")).toBe(false);
  await expect(createNativeProviderWriterLease(f.homePath).assertAvailable("claude")).resolves.toBeUndefined();
});


it.each(["busy", "unknown", "dependency", "revision"] as const)("preserves the %s fence for signed-out removal", async mode => {
  const f = await fixture(false, mode === "dependency"); f.signOut();
  const release = mode === "busy" ? await createNativeProviderWriterLease(f.homePath).acquire("claude") : async () => {};
  if (mode === "unknown") f.unknownWriter();
  if (mode === "dependency") f.legacyInUse();
  if (mode === "revision") {
    const config = JSON.parse(await readFile(f.store.configurationPath, "utf8")); config.revision++;
    await writeFile(f.store.configurationPath, JSON.stringify(config));
  }
  try {
    await expect(f.store.mutate({ type: "remove_account", accountId: "owner_claude_profile", expectedRevision: f.snapshot.revision, idempotencyKey: `signed-out-${mode}-fence`, confirmation: "remove_account", dependencyGuard: { activeChatCount: mode === "dependency" ? 1 : 0, resumableChatCount: 0, harnessInstanceCount: 0 } })).rejects.toMatchObject({ code: mode === "dependency" ? "account_in_use" : mode === "revision" ? "revision_conflict" : "lifecycle_unavailable" });
    expect(f.runLogout).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(f.store.configurationPath, "utf8")).accountProfiles.some((row: { id: string }) => row.id === "owner_claude_profile")).toBe(true);
  } finally { await release(); }
});


it("rejects another HOME's bound signed-out proof at the actual lifecycle coordinator", async () => {
  const first = await fixture(), other = await fixture(); first.signOut(); other.signOut();
  const proof = await other.readMetadata.readSignedOut!();
  await expect(first.lifecycle.remove({ account: { id: "owner_claude_profile", providerId: "anthropic", driverId: "claude_code", harness: "claude", authMethod: "terminal", accessSourceId: "owner_claude_profile", installState: "installed", driverAccountCount: 1, authenticated: false, nativeClaudeSignedOut: proof! }, idempotencyKey: "foreign-home-absence" })).rejects.toMatchObject({ code: "lifecycle_unavailable" });
  expect(first.runLogout).not.toHaveBeenCalled();
});

it("keeps optional signed-out reader failure unavailable without failing the snapshot", async () => {
  const f = await fixture(); f.signOut();
  f.readMetadata.readSignedOut = async () => { throw new Error("synthetic-reader-unavailable"); };
  const snapshot = await f.store.getSnapshot({ includeNativeAccountMetadata: true, includeNativeAccountUsage: false });
  expect(snapshot.accounts.find(row => row.id === "owner_claude_profile")?.authState).not.toBe("authenticated");
  expect(snapshot.supportedActions).not.toContain("logout_account");
  expect(snapshot.supportedActions).not.toContain("remove_account");
  expect(JSON.stringify(snapshot)).not.toContain("synthetic-reader-unavailable");
});
