import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiProviderSnapshotV3Schema } from "@matrix-os/contracts";
import { initialProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { coordinatorLifecycleAccounts } from "../../packages/gateway/src/ai-providers/provider-settings-capability-policy.js";
import { createDefaultProviderCliAccountLifecycleCoordinator } from "../../packages/gateway/src/ai-providers/provider-cli-account-lifecycle.js";
import { createOwnerAnthropicKeySaver, readOwnerAnthropicKey } from "../../packages/gateway/src/ai-providers/owner-anthropic-key.js";
import { providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function home() { const value = await mkdtemp(join(tmpdir(), "claude-lifecycle-competition-")); homes.push(value); return value; }
function inventory(withKey = false) {
  const base = providerSettingsCanonicalFixture();
  const source = base.accessSources.find(row => row.id === "owner_anthropic_profile")!;
  base.accessSources.push({ ...source, id: "owner_claude_profile" });
  base.accounts.push({ ...base.accounts[0]!, id: "owner_claude_profile" });
  base.instances.push({ ...base.instances[1]!, id: "claude_native", driverId: "claude_code", accountId: "owner_claude_profile", accessSourceId: "owner_claude_profile" });
  if (withKey) {
    base.accessSources.push({ ...source, id: "owner_anthropic_key", fundingKind: "owner_api_key" });
    base.accounts.push({ ...base.accounts[0]!, id: "owner_api_key", authMethod: "api_key" });
    base.instances.push({ ...base.instances[1]!, id: "kernel_key", accountId: "owner_api_key", accessSourceId: "owner_anthropic_key" });
  }
  for (const model of base.models) {
    for (const id of ["owner_claude_profile", ...(withKey ? ["owner_anthropic_key"] : [])]) {
      model.eligibleAccessSourceIds.push(id);
      model.dataPolicies.push({ accessSourceId: id, route: "owner_direct", disclosureKey: "owner-anthropic" });
    }
  }
  return AiProviderSnapshotV3Schema.parse(base);
}
function accounts(withKey = false) { const canonical = inventory(withKey); return coordinatorLifecycleAccounts({ canonical, config: initialProviderSettingsConfiguration(canonical) }); }

describe("Claude lifecycle credential competition", () => {
  it("keeps native and legacy aliases of the same singleton profile actionable", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const lifecycle = createDefaultProviderCliAccountLifecycleCoordinator({ homePath: await home(), enabledHarnesses: ["claude"], run });
    for (const account of accounts()) {
      expect(account.driverAccountCount).toBe(1);
      if (account.id === "owner_anthropic") {
        expect(lifecycle.supportedActions(account)).toEqual(["logout_account", "remove_account"]);
        await lifecycle.logout({ account, idempotencyKey: `logout_${account.id}` });
      }
    }
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith("claude", ["auth", "logout"], expect.any(Object));
  });

  it("revokes only the independent owner API key when native profile aliases coexist", async () => {
    const homePath = await home();
    await createOwnerAnthropicKeySaver({ homePath })("synthetic-key-for-lifecycle");
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const lifecycle = createDefaultProviderCliAccountLifecycleCoordinator({ homePath, enabledHarnesses: ["claude"], run });
    const key = accounts(true).find(row => row.id === "owner_api_key")!;
    expect(key.driverAccountCount).toBe(1);
    expect(lifecycle.supportedActions(key)).toEqual(["logout_account", "remove_account"]);
    await lifecycle.remove({ account: key, idempotencyKey: "remove_exact_key" });
    expect((await readOwnerAnthropicKey(homePath)).state).toBe("setup_required");
    expect(run).not.toHaveBeenCalled();
  });

  it("signs out the profile without deleting the separately stored key", async () => {
    const homePath = await home();
    await createOwnerAnthropicKeySaver({ homePath })("synthetic-key-for-lifecycle");
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const lifecycle = createDefaultProviderCliAccountLifecycleCoordinator({ homePath, enabledHarnesses: ["claude"], run });
    const profile = accounts(true).find(row => row.id === "owner_anthropic")!;
    expect(lifecycle.supportedActions(profile)).toEqual(["logout_account", "remove_account"]);
    await lifecycle.logout({ account: profile, idempotencyKey: "logout_profile_keep_key" });
    expect((await readOwnerAnthropicKey(homePath)).key).toBe("synthetic-key-for-lifecycle");
    expect(run).toHaveBeenCalledOnce();
  });

  it("retains ambiguity for genuinely distinct profile or key rows", async () => {
    for (const method of ["provider_profile", "api_key"] as const) {
      const canonical = inventory(true);
      const first = canonical.accounts.find(row => row.authMethod === method)!;
      const instance = canonical.instances.find(row => row.accountId === first.id)!;
      canonical.accounts.push({ ...first, id: "independent_account" });
      canonical.instances.push({ ...instance, id: "independent_instance", accountId: "independent_account", accessSourceId: "independent_source" });
      canonical.accessSources.push({ ...canonical.accessSources.find(row => row.id === instance.accessSourceId)!, id: "independent_source" });
      const projected = coordinatorLifecycleAccounts({ canonical, config: initialProviderSettingsConfiguration(canonical) });
      const distinct = projected.find(row => row.id === "independent_account")!;
      expect(distinct.driverAccountCount).toBeGreaterThan(1);
      const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
      const lifecycle = createDefaultProviderCliAccountLifecycleCoordinator({ homePath: await home(), enabledHarnesses: ["claude"], run });
      expect(lifecycle.supportedActions(distinct)).toEqual([]);
      await expect(lifecycle.remove({ account: distinct, idempotencyKey: `remove_${method}` })).rejects.toMatchObject({ code: "lifecycle_unavailable" });
      expect(run).not.toHaveBeenCalled();
    }
  });
});
