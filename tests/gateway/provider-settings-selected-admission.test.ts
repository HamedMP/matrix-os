import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { initialProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";

const now = new Date("2026-08-29T21:00:00Z");
describe("read-only selected Matrix settings", () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "selected-matrix-settings-")); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); await rm(`${home}-private`, { recursive: true, force: true }); });

  it("skips unrelated native enrichment and preserves saved policy intent and bytes", async () => {
    const snapshot = makeAiProviderSnapshot();
    const getSnapshot = vi.fn(async () => snapshot);
    const held = Promise.withResolvers<{ providers: []; accessSources: []; failures: [] }>();
    const getCatalog = vi.fn(() => held.promise);
    const store = new ProviderSettingsStore({ homePath: home, privateRootPath: `${home}-private`, now: () => now,
      providerSnapshotReader: { getSnapshot }, genericModelCatalogReader: { getCatalog } });
    const config = initialProviderSettingsConfiguration(snapshot);
    config.gatewayPolicy.allowedModelIds = [];
    await mkdir(join(home, "system/ai-providers"), { recursive: true });
    const saved = JSON.stringify(config);
    await writeFile(store.configurationPath, saved);
    const request = store.getSnapshot({ admissionScope: "managed_matrix" });
    try {
      const result = await Promise.race([request, new Promise<null>(resolve => setTimeout(() => resolve(null), 100))]);
      expect(result).not.toBeNull(); expect(getCatalog).not.toHaveBeenCalled();
      expect(result!.gatewayPolicy?.allowedModelIds).toEqual([]);
      expect(getSnapshot).toHaveBeenCalledWith(expect.objectContaining({ admissionScope: "managed_matrix" }));
      expect(await readFile(store.configurationPath, "utf8")).toBe(saved);
    } finally { held.resolve({ providers: [], accessSources: [], failures: [] }); await request.catch(() => {}); }
  });

  it("does not queue a selected read behind an unrelated full Settings observer", async () => {
    const snapshot = makeAiProviderSnapshot();
    const held = Promise.withResolvers<{ providers: []; accessSources: []; failures: [] }>();
    const getCatalog = vi.fn(() => held.promise);
    const store = new ProviderSettingsStore({ homePath: home, privateRootPath: `${home}-private`, now: () => now,
      providerSnapshotReader: { getSnapshot: async () => snapshot }, genericModelCatalogReader: { getCatalog } });
    const full = store.getSnapshot();
    await vi.waitFor(() => expect(getCatalog).toHaveBeenCalledOnce());
    const selected = store.getSnapshot({ admissionScope: "managed_matrix" });
    try {
      expect(await Promise.race([selected, new Promise<null>(resolve => setTimeout(() => resolve(null), 100))])).not.toBeNull();
    } finally { held.resolve({ providers: [], accessSources: [], failures: [] }); await full; await selected; }
  });

  it("awaits an actually pending owner write and releases rejected write tails", async () => {
    const snapshot = makeAiProviderSnapshot();
    const held = Promise.withResolvers<typeof snapshot>();
    let holdWrite = true;
    const getSnapshot = vi.fn(async () => holdWrite ? held.promise : snapshot);
    const store = new ProviderSettingsStore({ homePath: home, privateRootPath: `${home}-private`, now: () => now,
      providerSnapshotReader: { getSnapshot } });
    const mutation = store.setAccountSecret("owner_anthropic", "test-pending-secret");
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    const selected = store.getSnapshot({ admissionScope: "managed_matrix" });
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      expect(getSnapshot).toHaveBeenCalledOnce();
    } finally { holdWrite = false; held.resolve(snapshot); await mutation; await selected; }
    expect(getSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ admissionScope: "managed_matrix" }));
    // Failed writes release their tail and do not poison future scoped reads.
    await expect(store.setAccountSecret("missing_account", "test-secret")).rejects.toMatchObject({ code: "not_found" });
    await expect(store.getSnapshot({ admissionScope: "managed_matrix" })).resolves.toMatchObject({ revision: 0 });
  });

  it("fails a selected observation closed when an owner mutation starts during it", async () => {
    const snapshot = makeAiProviderSnapshot();
    const held = Promise.withResolvers<typeof snapshot>();
    const getSnapshot = vi.fn(async (options?: { admissionScope?: string }) => options?.admissionScope ? held.promise : snapshot);
    const store = new ProviderSettingsStore({ homePath: home, privateRootPath: `${home}-private`, now: () => now, providerSnapshotReader: { getSnapshot } });
    const selected = store.getSnapshot({ admissionScope: "managed_matrix" });
    // Attach the expected rejection before releasing asynchronous observations.
    const outcome = selected.then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    const mutation = store.setAccountSecret("owner_anthropic", "test-only-owner-secret");
    await Promise.race([mutation, new Promise<void>(resolve => setTimeout(resolve, 100))]);
    held.resolve(snapshot);
    await mutation;
    expect(await outcome).toMatchObject({ error: { code: "projection_unavailable", status: 503 } });
  });

  it("keeps optional native identity and runtime recovery outside managed admission", async () => {
    const snapshot = makeAiProviderSnapshot();
    snapshot.drivers.push({ ...snapshot.drivers[0]!, id: "codex", kind: "cli" });
    const native = vi.fn(async () => { throw new Error("unrelated native metadata"); });
    const isRecoveryReady = vi.fn(() => false);
    const store = new ProviderSettingsStore({ homePath: home, privateRootPath: `${home}-private`, now: () => now,
      providerSnapshotReader: { getSnapshot: async () => snapshot }, codexNativeAccountMetadataReader: native,
      runtimeCoordinator: { supportedActions: [], isRecoveryReady, reconcilePending: async () => {},
        applyConfiguration: async () => {}, rollbackConfiguration: async () => {} } });
    await expect(store.getSnapshot({ admissionScope: "managed_matrix", includeNativeAccountMetadata: true })).resolves.toMatchObject({ revision: 0 });
    expect(native).not.toHaveBeenCalled(); expect(isRecoveryReady).not.toHaveBeenCalled();
    await expect(store.getSnapshot()).rejects.toMatchObject({ code: "runtime_unavailable" });
  });

  it("does not initialize a persisted document from partial native inventory", async () => {
    const snapshot = makeAiProviderSnapshot();
    const store = new ProviderSettingsStore({ homePath: home, privateRootPath: `${home}-private`, now: () => now, providerSnapshotReader: { getSnapshot: async () => snapshot } });
    const selected = await store.getSnapshot({ admissionScope: "managed_matrix" });
    expect(selected.revision).toBe(0);
    await expect(readFile(store.configurationPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const complete = await store.getSnapshot();
    expect(complete.revision).toBe(selected.revision);
    expect(await readFile(store.configurationPath, "utf8")).toBeTruthy();
  });
});
