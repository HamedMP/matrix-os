import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AiProviderSnapshotV3Schema } from "@matrix-os/contracts";
import { ProviderSettingsStore, type ProviderAccountLifecycleCoordinator, type ProviderSettingsRuntimeCoordinator } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { providerSettingsCanonicalFixture, PROVIDER_SETTINGS_NOW } from "./provider-settings-test-support.js";

  it("never pairs a pre-logout account with the revision of an already-running logout", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "provider-read-epoch-"));
    const privateRootPath = join(homePath, "..", `${homePath.split("/").at(-1)}-private`);
    let canonical = providerSettingsCanonicalFixture();
    const runtime: ProviderSettingsRuntimeCoordinator = {
      supportedActions: [], isRecoveryReady: () => true, reconcilePending: async () => {},
      applyConfiguration: async () => {}, rollbackConfiguration: async () => {},
    };
    const lifecycle: ProviderAccountLifecycleCoordinator = {
      supportedActions: () => ["logout_account"], remove: async () => {},
      logout: async ({ account }) => {
        canonical = AiProviderSnapshotV3Schema.parse({ ...canonical, revision: canonical.revision + 1,
          accounts: canonical.accounts.map(item => item.id === account.id ? { ...item, authMethod: null, state: "setup_required", checkedAt: null, staleAfter: null, action: "connect" } : item),
          accessSources: canonical.accessSources.map(source => source.id === "owner_anthropic_profile" ? { ...source, state: "setup_required", checkedAt: null, staleAfter: null, action: "connect" } : source),
        });
      },
    };
    const store = new ProviderSettingsStore({ homePath, privateRootPath,
      providerSnapshotReader: { getSnapshot: async () => structuredClone(canonical) },
      accountLifecycle: lifecycle, runtimeCoordinator: runtime, now: () => PROVIDER_SETTINGS_NOW,
    });
    try {
    const initial = await store.getSnapshot();
    let finishRecovery!: () => void;
    let enteredRecovery!: () => void;
    const recoveryEntered = new Promise<void>(resolve => { enteredRecovery = resolve; });
    const recoveryGate = new Promise<void>(resolve => { finishRecovery = resolve; });
    let recovered = false;
    runtime.isRecoveryReady = () => recovered;
    runtime.reconcilePending = async () => { enteredRecovery(); await recoveryGate; recovered = true; };
    let finishLogout!: () => void;
    let enteredLogout!: () => void;
    const logoutEntered = new Promise<void>(resolve => { enteredLogout = resolve; });
    const logoutGate = new Promise<void>(resolve => { finishLogout = resolve; });
    const originalLogout = lifecycle.logout;
    lifecycle.logout = async input => { enteredLogout(); await logoutGate; await originalLogout(input); };
    const read = store.getSnapshot({ refresh: true });
    await recoveryEntered;
    const logout = store.mutate({ type: "logout_account", accountId: "owner_anthropic", expectedRevision: initial.revision, idempotencyKey: "raced_logout" });
    finishRecovery();
    try {
      await logoutEntered;
      // Drain the pre-logout read without finishing the native writer. The read
      // must start its coherent generation only after that admission completes.
      await new Promise<void>(resolve => setImmediate(resolve));
    } finally { finishLogout(); }
    const written = await logout;
    const observed = await read;
    expect(observed.revision).toBe(written.snapshot.revision);
    expect(observed.accounts.find(account => account.id === "owner_anthropic")?.authState).toBe("unauthenticated");
    } finally { await rm(homePath, { recursive: true, force: true }); await rm(privateRootPath, { recursive: true, force: true }); }
  });
