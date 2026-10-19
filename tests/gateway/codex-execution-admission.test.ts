import { markSessionStartClean } from "../../packages/gateway/src/coding-agents/session-start-cleanup-proof.js";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { bindNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";
import { createCodexExecutionAdmission } from "../../packages/gateway/src/coding-agents/codex-execution-admission.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "codex-execution-")); homes.push(homePath);
  let revision = 1;
  let enabled = true;
  let principal = "private_owner_profile_A";
  let available = true;
  let source = "owner_openai_profile";
  let account = "native_account";
  let method: "terminal" | "api_key" = "terminal";
  const save = async () => {
    await mkdir(join(homePath, "system/ai-providers"), { recursive: true });
    await writeFile(join(homePath, "system/ai-providers/settings.json"), JSON.stringify({
      schemaVersion: 1, revision, harnesses: [{ id: "codex", driverId: "codex", harness: "codex", displayName: "Codex", accentColor: null,
        enabled, selectedAccountId: account, accessSourceId: source, nativeAccountGeneration: createHash("sha256").update("private_owner_profile_A").digest("hex"), nativeAccountConsentRevision: 1, route: { kind: "fixed", providerId: "openai", modelId: "openai/gpt-5.6" } }],
      accountProfiles: [], gatewayPolicy: null, receipts: [],
    }));
  };
  const options = {
    homePath,
    isOwner: (id: string) => id === "owner",
    getSnapshot: async () => ({ revision, access: { mode: "writable" },
      accessSources: [{ id: source, providerId: "openai", accountId: account, kind: "provider_account", fundingKind: method === "terminal" ? "owner_account" : "owner_api_key" }],
      accounts: [{ id: account, providerId: "openai", accessSourceId: source, authMethod: method, authState: "authenticated" }],
    } as unknown as ProviderSettingsSnapshot),
    readNativeAccount: async () => {
      const captured = principal;
      return bindNativeAccountMetadata({ accountLabel: "person@example.test", authMethod: method,
        checkedAt: new Date(Date.now() - 1000).toISOString(), staleAfter: new Date(Date.now() + 30000).toISOString() },
      async () => available && captured === principal, captured);
    },
  };
  await save();
  return { homePath, options, save, bumpOtherSettings: async () => { revision++; await save(); }, admission: createCodexExecutionAdmission(options), change: (value: { principal?: string; enabled?: boolean; available?: boolean; source?: string; account?: string; method?: "terminal" | "api_key" }) => {
    if (value.principal !== undefined) principal = value.principal;
    if (value.enabled !== undefined) { enabled = value.enabled; revision++; }
    if (value.available !== undefined) available = value.available;
    if (value.source !== undefined) { source = value.source; revision++; }
    if (value.account !== undefined) { account = value.account; revision++; }
    if (value.method !== undefined) method = value.method;
  } };
}

describe("Codex exact native execution authority", () => {
  it("binds the native selected source and current private principal to one owner and runtime", async () => {
    const f = await fixture();
    const binding = await f.admission.start("owner");
    expect(binding).toEqual(expect.any(String));
    await expect(f.admission.validate("owner", binding)).resolves.toBeUndefined();
    await expect(f.admission.validate("collaborator", binding)).rejects.toThrow("unavailable");
    await expect(createCodexExecutionAdmission(f.options).validate("owner", binding)).resolves.toBeUndefined();
    f.change({ principal: "private_owner_profile_B" });
    await expect(f.admission.validate("owner", binding)).rejects.toThrow("unavailable");
  });
  it.each(["disabled", "revoked", "source", "account", "key"])("fails closed after %s without accepting a new source", async kind => {
    const f = await fixture(); const binding = await f.admission.start("owner");
    f.change(kind === "disabled" ? { enabled: false } : kind === "revoked" ? { available: false } : kind === "source" ? { source: "matrix_ai" } : kind === "account" ? { account: "other" } : { method: "api_key" });
    await f.save();
    await expect(f.admission.validate("owner", binding)).rejects.toThrow("unavailable");
  });
  it("rejects native execution without saved consent, including legacy no-settings attempts", async () => {
    const f = await fixture();
    await expect(f.admission.validate("owner")).rejects.toThrow("unavailable");
    await rm(join(f.homePath, "system/ai-providers/settings.json"));
    await expect(f.admission.start("owner")).rejects.toThrow("unavailable");
    await expect(f.admission.validate("owner")).rejects.toThrow("unavailable");
  });
  it("requires process-private verified evidence rather than a public account label", async () => {
    const f = await fixture();
    const admission = createCodexExecutionAdmission({ ...f.options, readNativeAccount: async () => ({ ...(await f.options.readNativeAccount()) }) });
    await expect(admission.start("owner")).rejects.toThrow("unavailable");
  });
  it("binds the final launch to the admitted session and rejects drift before spawn", async () => {
    const f = await fixture();
    const binding = await f.admission.start("owner", "sess_original");
    await expect(f.admission.validateLaunch("owner", "sess_original")).resolves.toMatchObject({ expectedPrincipalFingerprint: createHash("sha256").update("private_owner_profile_A").digest("hex"), expectedConsentRevision: 1 });
    await expect(f.admission.validateLaunch("owner", "sess_unknown")).rejects.toThrow("unavailable");
    const restarted = createCodexExecutionAdmission(f.options);
    await expect(restarted.validateLaunch("owner", "sess_original")).resolves.toMatchObject({ expectedPrincipalFingerprint: createHash("sha256").update("private_owner_profile_A").digest("hex"), expectedConsentRevision: 1 });
    await restarted.validate("owner", binding, "sess_original");
    await expect(restarted.validateLaunch("owner", "sess_original")).resolves.toMatchObject({ expectedPrincipalFingerprint: createHash("sha256").update("private_owner_profile_A").digest("hex"), expectedConsentRevision: 1 });
    f.change({ principal: "changed" });
    await expect(restarted.validateLaunch("owner", "sess_original")).rejects.toThrow("unavailable");
  });
  it("drains registered native sessions and fences dispatch until revocation commits", async () => {
    const f = await fixture(); const stopSession = vi.fn(async () => undefined);
    const admission = createCodexExecutionAdmission({ ...f.options, stopSession });
    const binding = await admission.start("owner", "sess_running");
    const release = await admission.prepareRevocation();
    expect(stopSession).toHaveBeenCalledWith("sess_running");
    await expect(admission.start("owner")).rejects.toThrow("unavailable");
    await expect(admission.validate("owner", binding)).rejects.toThrow("unavailable");
    await release();
    await expect(admission.start("owner")).resolves.toEqual(expect.any(String));
  });
  it("retains the durable fence across restart when process cleanup is uncertain", async () => {
    const f = await fixture();
    const admission = createCodexExecutionAdmission({ ...f.options, stopSession: async () => { throw new Error("uncertain"); } });
    const binding = await admission.start("owner", "sess_uncertain");
    await expect(admission.prepareRevocation()).rejects.toThrow();
    await expect(createCodexExecutionAdmission(f.options).validate("owner", binding)).rejects.toThrow("unavailable");
  });
  it("drains persisted native execution references after restart without opening a thread", async () => {
    const f = await fixture();
    await f.admission.start("owner", "sess_persisted");
    const stopSession = vi.fn(async () => undefined);
    const restarted = createCodexExecutionAdmission({ ...f.options, stopSession });
    const release = await restarted.prepareRevocation();
    expect(stopSession).toHaveBeenCalledWith("sess_persisted");
    await release();
  });
  it("does not adopt a changed native principal for a new thread under old consent", async () => {
    const f = await fixture(); f.change({ principal: "other_account" });
    await expect(f.admission.start("owner")).rejects.toThrow("unavailable");
  });
  it("rejects a configured unknown or funded source instead of a default launch", async () => {
    const f = await fixture(); f.change({ source: "matrix_ai" }); await f.save();
    await expect(f.admission.start("owner")).rejects.toThrow("unavailable");
  });
  it.each(["displayName", "accentColor"])("preserves continuation and launch after changing %s", async (field) => {
    const f = await fixture();
    const binding = await f.admission.start("owner", "sess_active");
    const path = join(f.homePath, "system/ai-providers/settings.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    config.harnesses[0][field] = field === "displayName" ? "Personal coding" : "purple";
    await writeFile(path, JSON.stringify(config));
    await expect(f.admission.validate("owner", binding, "sess_active")).resolves.toBeUndefined();
    const reopened = createCodexExecutionAdmission(f.options);
    await expect(reopened.validateLaunch("owner", "sess_active")).resolves.toMatchObject({ expectedAccountId: "native_account" });
  });
  it.each(["model", "consent"])("rejects continued execution after a %s change", async (field) => {
    const f = await fixture();
    const binding = await f.admission.start("owner", "sess_active");
    const path = join(f.homePath, "system/ai-providers/settings.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    if (field === "model") config.harnesses[0].route.modelId = "openai/other-model";
    else config.harnesses[0].nativeAccountConsentRevision++;
    await writeFile(path, JSON.stringify(config));
    await expect(f.admission.validate("owner", binding, "sess_active")).rejects.toThrow("unavailable");
    await expect(createCodexExecutionAdmission(f.options).validateLaunch("owner", "sess_active")).rejects.toThrow("unavailable");
  });
  it("does not revoke native execution for an unrelated settings revision", async () => {
    const f = await fixture(); const binding = await f.admission.start("owner");
    await f.bumpOtherSettings();
    await expect(f.admission.validate("owner", binding)).resolves.toBeUndefined();
  });
  it("rejects expired privately bound observation without inferring a fallback", async () => {
    const f = await fixture();
    const admission = createCodexExecutionAdmission({ ...f.options, readNativeAccount: async () => bindNativeAccountMetadata({
      accountLabel: "person@example.test", authMethod: "terminal", checkedAt: new Date(0).toISOString(), staleAfter: new Date(1000).toISOString(),
    }, async () => true, "private_owner_profile_A") });
    await expect(admission.start("owner")).rejects.toThrow("unavailable");
  });
  it("forgets only exact proven clean startup failures before later revocation", async () => {
    const f = await fixture(); const stopSession = vi.fn(async () => { throw new Error("not found"); });
    const admission = createCodexExecutionAdmission({ ...f.options, stopSession });
    const binding = await admission.start("owner", "sess_failed");
    const result = markSessionStartClean({ ok: false }, "owner", "sess_failed");
    await admission.releaseFailedStart("owner", "sess_failed", binding, result);
    const release = await admission.prepareRevocation();
    expect(stopSession).not.toHaveBeenCalled();
    await release();
  });
  it("retains possible live processes for unproven or mismatched failures", async () => {
    const f = await fixture(); const stopSession = vi.fn(async () => { throw new Error("uncertain"); });
    const admission = createCodexExecutionAdmission({ ...f.options, stopSession });
    const binding = await admission.start("owner", "sess_uncertain");
    await admission.releaseFailedStart("owner", "sess_uncertain", binding, { ok: false });
    await admission.releaseFailedStart("owner", "sess_uncertain", binding, markSessionStartClean({ ok: false }, "other", "sess_uncertain"));
    await expect(admission.prepareRevocation()).rejects.toThrow("unavailable");
    expect(stopSession).toHaveBeenCalledWith("sess_uncertain");
  });
  it("keeps API-key execution distinct from native subscription authority", async () => {
    const f = await fixture(); f.change({ method: "api_key" }); await f.save();
    await expect(f.admission.start("owner")).resolves.toBeUndefined();
  });
});

it('preserves a legacy API-key attempt only after private current authentication proof', async () => {
  const f = await fixture(); f.change({ method: 'api_key' });
  await rm(join(f.homePath, 'system/ai-providers/settings.json'));
  await expect(f.admission.start('owner')).resolves.toBeUndefined();
  f.change({ available: false });
  await expect(f.admission.start('owner')).rejects.toThrow('unavailable');
});
it('rejects legacy unknown authentication before generic launch', async () => {
  const f = await fixture(); await rm(join(f.homePath, 'system/ai-providers/settings.json'));
  const admission = createCodexExecutionAdmission({ ...f.options, readNativeAccount: async () => null });
  await expect(admission.start('owner')).rejects.toThrow('unavailable');
});

it.each(["configured", "legacy"] as const)("tracks %s API-key work for owner-scoped revocation without subscription intent", async mode => {
  const f = await fixture(); f.change({ method: "api_key" }); await f.save();
  if (mode === "legacy") await rm(join(f.homePath, "system/ai-providers/settings.json"));
  const stopSession = vi.fn(async () => undefined);
  const admission = createCodexExecutionAdmission({ ...f.options, stopSession });
  await expect(admission.start("other", "sess_foreign")).rejects.toThrow("unavailable");
  await expect(admission.start("owner", "sess_key_running")).resolves.toBeUndefined();
  await expect(admission.validateLaunch("owner", "sess_key_running")).resolves.toBeUndefined();
  const restarted = createCodexExecutionAdmission({ ...f.options, stopSession });
  const release = await restarted.prepareRevocation();
  expect(stopSession).toHaveBeenCalledExactlyOnceWith("sess_key_running");
  await expect(restarted.start("owner", "sess_key_late")).rejects.toThrow("unavailable");
  await release();
});
it("fences configured API-key starts while revocation is held", async () => {
  const f = await fixture(); f.change({ method: "api_key" }); await f.save();
  const release = await f.admission.prepareRevocation();
  try { await expect(f.admission.start("owner", "sess_racing_key")).rejects.toThrow("unavailable"); }
  finally { await release(); }
});
it("retains an API-key execution fence when its exact child stop is uncertain", async () => {
  const f = await fixture(); f.change({ method: "api_key" }); await f.save();
  const stopSession = vi.fn(async () => { throw new Error("uncertain child stop"); });
  const admission = createCodexExecutionAdmission({ ...f.options, stopSession });
  await admission.start("owner", "sess_key_uncertain");
  await expect(admission.prepareRevocation()).rejects.toThrow("unavailable");
  expect(stopSession).toHaveBeenCalledExactlyOnceWith("sess_key_uncertain");
  await expect(createCodexExecutionAdmission(f.options).start("owner", "sess_after_restart")).rejects.toThrow("unavailable");
});
it("releases only an owner-matched proved clean API-key start failure", async () => {
  const f = await fixture(); f.change({ method: "api_key" }); await f.save();
  const stopSession = vi.fn(async () => undefined);
  const admission = createCodexExecutionAdmission({ ...f.options, stopSession });
  await admission.start("owner", "sess_key_clean");
  await admission.releaseFailedStart("owner", "sess_key_clean", undefined,
    markSessionStartClean({ ok: false }, "owner", "sess_key_clean"));
  const release = await admission.prepareRevocation(); await release();
  expect(stopSession).not.toHaveBeenCalled();
});
it("never promotes a tracked API-key execution into native subscription authority", async () => {
  const f = await fixture(); f.change({ method: "api_key" }); await f.save();
  await f.admission.start("owner", "sess_key_mode");
  f.change({ method: "terminal" }); await f.save();
  await expect(f.admission.validateLaunch("owner", "sess_key_mode")).rejects.toThrow("unavailable");
});
it.each(["unproved", "foreign-owner", "wrong-session", "subscription-binding"] as const)("retains API-key work after %s cleanup", async mode => {
  const f = await fixture(); f.change({ method: "api_key" }); await f.save();
  const stopSession = vi.fn(async () => undefined);
  const admission = createCodexExecutionAdmission({ ...f.options, stopSession });
  await admission.start("owner", "sess_key_proof");
  const proof = mode === "unproved" ? {} : markSessionStartClean({ ok: false },
    mode === "foreign-owner" ? "other" : "owner", mode === "wrong-session" ? "sess_other" : "sess_key_proof");
  await admission.releaseFailedStart("owner", "sess_key_proof", mode === "subscription-binding" ? "a".repeat(64) : undefined, proof);
  const release = await admission.prepareRevocation(); await release();
  expect(stopSession).toHaveBeenCalledExactlyOnceWith("sess_key_proof");
});
it("does not let an API-key clean failure release a native subscription session", async () => {
  const f = await fixture(); const stopSession = vi.fn(async () => undefined);
  const admission = createCodexExecutionAdmission({ ...f.options, stopSession });
  await admission.start("owner", "sess_subscription_proof");
  await admission.releaseFailedStart("owner", "sess_subscription_proof", undefined,
    markSessionStartClean({ ok: false }, "owner", "sess_subscription_proof"));
  const release = await admission.prepareRevocation(); await release();
  expect(stopSession).toHaveBeenCalledExactlyOnceWith("sess_subscription_proof");
});
