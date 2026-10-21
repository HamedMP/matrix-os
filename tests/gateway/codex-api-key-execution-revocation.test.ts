import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createDefaultProviderCliAccountLifecycleCoordinator } from "../../packages/gateway/src/ai-providers/provider-cli-account-lifecycle.js";
import { createNativeProviderProfileGuard } from "../../packages/gateway/src/ai-providers/native-provider-profile-guard.js";
import { bindNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";
import { createCodexExecutionAdmission } from "../../packages/gateway/src/coding-agents/codex-execution-admission.js";
vi.mock("../../packages/gateway/src/ai-providers/codex-native-terminal-command.js", () => ({ resolveCodexNativeExecutable: () => "/fixture/bin/codex" }));

async function fixture(stopSession: (id: string) => Promise<void>) {
  const homePath = await mkdtemp(join(tmpdir(), "codex-key-work-logout-"));
  let loggedIn = true;
  const readMetadata = async () => loggedIn ? bindNativeAccountMetadata({
    authMethod: "api_key", accountLabel: "API key", checkedAt: new Date(Date.now() - 1000).toISOString(), staleAfter: new Date(Date.now() + 30_000).toISOString(),
  }, async () => loggedIn, "synthetic-exact-key", { credentialIdentityBound: true }) : null;
  const guard = createNativeProviderProfileGuard({ homePath, registry: {
    listProfileSessions: async () => [], get: async () => { throw new Error("unexpected login lookup"); }, observeAgentLiveness: async () => "stopped",
  } });
  const run = vi.fn(async () => { loggedIn = false; return { stdout: "", stderr: "" }; });
  const lifecycle = createDefaultProviderCliAccountLifecycleCoordinator({ homePath, enabledHarnesses: ["codex"],
    profileGuard: guard, run, readCodexAccountUnderLease: readMetadata });
  const service = new AiProviderService({ homePath, env: {}, driverInventory: async () => [{ id: "codex", displayName: "Codex", kind: "cli", installState: "installed", health: "ready", setupActions: [], capabilities: ["tools"] }],
    codexNativeKeyReadiness: async () => loggedIn ? { state: "ready", checkedAt: new Date(Date.now() - 1000).toISOString(), staleAfter: new Date(Date.now() + 30_000).toISOString(), action: "none", safeReason: null } : null });
  let store!: ProviderSettingsStore;
  const admission = createCodexExecutionAdmission({ homePath, isOwner: id => id === "owner", stopSession,
    readNativeAccount: readMetadata, getSnapshot: () => store.getSnapshot({ includeNativeAccountMetadata: true }),
    assertProfileAvailable: () => guard.assertReadable("codex") });
  store = new ProviderSettingsStore({ homePath, providerSnapshotReader: service, accountLifecycle: lifecycle,
    codexNativeAccountMetadataReader: readMetadata, prepareNativeCodexRevocation: () => admission.prepareRevocation() });
  const independent = join(homePath, "matrix-ai-grant.json");
  await writeFile(independent, JSON.stringify({ enabled: true, grant: "synthetic-independent-connection" }));
  return { homePath, store, admission, run, independent,
    cleanup: async () => { service.close(); await rm(homePath, { recursive: true, force: true }); } };
}

it("awaits exact API-key work stop before CLI logout and successful Settings receipt", async () => {
  let stopped!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { stopped = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const stop = vi.fn(async (id: string) => { order.push(`stop:${id}`); stopped(); await gate; });
  const f = await fixture(stop);
  let mutation: Promise<unknown> | undefined;
  try {
    await expect(f.admission.start("other", "sess_foreign")).rejects.toThrow("unavailable");
    await expect(f.admission.start("owner", "sess_key_active")).resolves.toBeUndefined();
    const snapshot = await f.store.getSnapshot({ includeNativeAccountMetadata: true });
    expect(snapshot.accounts.find(row => row.id === "owner_codex")).toMatchObject({ authMethod: "api_key", authState: "authenticated" });
    const input = { type: "logout_account" as const, accountId: "owner_codex", expectedRevision: snapshot.revision, idempotencyKey: "key-active-logout" };
    mutation = f.store.mutate(input).then(result => { order.push("receipt"); return result; });
    const first = await Promise.race([entered.then(() => "stop"), mutation.then(() => "receipt")]);
    expect(first).toBe("stop");
    expect(f.run).not.toHaveBeenCalled();
    expect(order).toEqual(["stop:sess_key_active"]);
    await expect(f.admission.start("owner", "sess_key_concurrent")).rejects.toThrow("unavailable");
    release(); await mutation;
    expect(f.run).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledExactlyOnceWith("sess_key_active");
    expect(order).toEqual(["stop:sess_key_active", "receipt"]);
    const config = JSON.parse(await readFile(f.store.configurationPath, "utf8"));
    expect(config.receipts.some((row: { key: string }) => row.key === input.idempotencyKey)).toBe(true);
    await f.store.mutate(input);
    expect(stop).toHaveBeenCalledTimes(1); expect(f.run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(f.independent, "utf8"))).toEqual({ enabled: true, grant: "synthetic-independent-connection" });
  } finally { release(); if (mutation) await mutation; await f.cleanup(); }
});

it("keeps credentials and success receipt untouched when an API-key child stop is uncertain", async () => {
  const stop = vi.fn(async () => { throw new Error("synthetic uncertain child stop"); });
  const f = await fixture(stop);
  try {
    await f.admission.start("owner", "sess_key_uncertain");
    const snapshot = await f.store.getSnapshot({ includeNativeAccountMetadata: true });
    await expect(f.store.mutate({ type: "logout_account", accountId: "owner_codex", expectedRevision: snapshot.revision,
      idempotencyKey: "key-uncertain-logout" })).rejects.toThrow("unavailable");
    expect(stop).toHaveBeenCalledExactlyOnceWith("sess_key_uncertain");
    expect(f.run).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(f.homePath, "system/ai-providers/codex-execution-revocation.json"), "utf8"))).toMatchObject({ state: "draining" });
    await expect(f.admission.start("owner", "sess_after_uncertain")).rejects.toThrow("unavailable");
    const current = await f.store.getSnapshot({ includeNativeAccountMetadata: true });
    expect(current.revision).toBe(snapshot.revision);
    expect(current.accounts.find(row => row.id === "owner_codex")).toMatchObject({ authState: "authenticated" });
  } finally { await f.cleanup(); }
});
