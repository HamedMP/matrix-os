import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createDefaultProviderCliAccountLifecycleCoordinator } from "../../packages/gateway/src/ai-providers/provider-cli-account-lifecycle.js";
import { createNativeProviderProfileGuard } from "../../packages/gateway/src/ai-providers/native-provider-profile-guard.js";
import { normalizeCodexNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/codex-native-account-metadata.js";
import { bindNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";
import { readProviderSettingsConfiguration, writeProviderJsonAtomic } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
vi.mock("../../packages/gateway/src/ai-providers/codex-native-terminal-command.js", () => ({ resolveCodexNativeExecutable: () => "/fixture/bin/codex" }));

it.each(["terminal", "api_key"] as const)("keeps a verified native API-key connection manageable with retained %s profile intent", async savedMethod => {
  const root = await mkdtemp(join(tmpdir(), "codex-key-lifecycle-"));
  const homePath = join(root, "home"); await mkdir(homePath);
  const readMetadata = async () => bindNativeAccountMetadata(
    normalizeCodexNativeAccountMetadata({ account: { type: "apiKey" } }, {}, new Date())!,
    async () => true, "synthetic-key-principal", { credentialIdentityBound: true },
  );
  const guard = createNativeProviderProfileGuard({ homePath, registry: { listProfileSessions: async () => [], get: async () => { throw new Error("no session"); }, observeAgentLiveness: async () => "stopped" } });
  const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
  const lifecycle = createDefaultProviderCliAccountLifecycleCoordinator({ homePath, enabledHarnesses: ["codex"], profileGuard: guard, run, readCodexAccountUnderLease: readMetadata });
  const service = new AiProviderService({ homePath, env: {}, driverInventory: async () => [{ id: "codex", displayName: "Codex", kind: "cli", installState: "installed", health: "ready", setupActions: [], capabilities: ["tools"] }], codexNativeKeyReadiness: async () => ({ state: "ready", checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 30000).toISOString(), action: "none", safeReason: null }) });
  try {
    const store = new ProviderSettingsStore({ homePath, privateRootPath: join(root, "private"), providerSnapshotReader: service, accountLifecycle: lifecycle, codexNativeAccountMetadataReader: readMetadata });
    const config = await readProviderSettingsConfiguration(store.configurationPath, await service.getSnapshot());
    config.accountProfiles.find(account => account.id === "owner_codex")!.authMethod = savedMethod;
    await writeProviderJsonAtomic(store.configurationPath, config);
    const snapshot = await store.getSnapshot({ includeNativeAccountMetadata: true });
    const account = snapshot.accounts.find(item => item.id === "owner_codex");
    expect(account).toMatchObject({ authMethod: "api_key", authState: "authenticated" });
    expect(snapshot.supportedActions).toContain("logout_account");
    expect(run).not.toHaveBeenCalled();
  } finally { service.close(); await rm(root, { recursive: true, force: true }); }
});

it.each(["stable", "drift"] as const)("rechecks the same native key principal under the writer before %s logout", async mode => {
  const root = await mkdtemp(join(tmpdir(), "codex-key-logout-"));
  const homePath = join(root, "home"); await mkdir(homePath);
  let principal = "synthetic-key-one", loggedIn = true;
  const readMetadata = async () => {
    if (!loggedIn) return null;
    const expected = principal;
    return bindNativeAccountMetadata(normalizeCodexNativeAccountMetadata({ account: { type: "apiKey" } }, {}, new Date())!, async () => loggedIn && principal === expected, expected, { credentialIdentityBound: true });
  };
  const guard = createNativeProviderProfileGuard({ homePath, registry: { listProfileSessions: async () => [], get: async () => { throw new Error("no session"); }, observeAgentLiveness: async () => "stopped" } });
  const run = vi.fn(async (_command: string, _args: readonly string[], _options: unknown) => { loggedIn = false; return { stdout: "", stderr: "" }; });
  const lifecycle = createDefaultProviderCliAccountLifecycleCoordinator({ homePath, enabledHarnesses: ["codex"], profileGuard: guard, run, readCodexAccountUnderLease: readMetadata });
  const service = new AiProviderService({ homePath, env: {}, driverInventory: async () => [{ id: "codex", displayName: "Codex", kind: "cli", installState: "installed", health: "ready", setupActions: [], capabilities: ["tools"] }], codexNativeKeyReadiness: async () => loggedIn ? { state: "ready", checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 30000).toISOString(), action: "none", safeReason: null } : null });
  try {
    const store = new ProviderSettingsStore({ homePath, privateRootPath: join(root, "private"), providerSnapshotReader: service, accountLifecycle: lifecycle, codexNativeAccountMetadataReader: readMetadata });
    const snapshot = await store.getSnapshot({ includeNativeAccountMetadata: true });
    const original = guard.run.bind(guard);
    guard.run = (profile, admission, operation) => { if (mode === "drift") principal = "replacement-key"; return original(profile, admission, operation); };
    const mutation = { type: "logout_account" as const, accountId: "owner_codex", expectedRevision: snapshot.revision, idempotencyKey: "native-key-logout" };
    if (mode === "drift") {
      await expect(store.mutate(mutation)).rejects.toMatchObject({ code: "lifecycle_unavailable" });
      expect(run).not.toHaveBeenCalled();
    } else {
      await store.mutate(mutation);
      expect(run.mock.calls.map(([command, args]) => ({ command, args }))).toEqual([{ command: "/fixture/bin/codex", args: ["logout"] }]);
    }
  } finally { service.close(); await rm(root, { recursive: true, force: true }); }
});
