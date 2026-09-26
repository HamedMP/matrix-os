import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { jevReadySettingsSnapshot } from "../fixtures/jev-inbox.js";
import { createJevHermesCredentialResolver } from "../../packages/gateway/src/chat/jev-hermes-credentials.js";
const time = Date.UTC(2026, 8, 26);
const snapshot = () => jevReadySettingsSnapshot(time);

const selection = { instanceId: "hermes_default", model: "anthropic:claude-sonnet-5" };
describe("recipe-only exact server-selected Hermes API-key credential", () => {
  it("reads only fixed bounded server config and returns only exact in-memory inference key", async () => {
    const home = await mkdtemp(join(tmpdir(), "jev-key-")); await mkdir(join(home, "system"));
    await writeFile(join(home, "system/config.json"), JSON.stringify({ kernel: { anthropicApiKey: "sk-ant-api03-synthetic-only" }, secret: "must-not-copy" }));
    const getSnapshot = vi.fn(async () => snapshot());
    const resolve = createJevHermesCredentialResolver({ homePath: home, ownerId: "owner_fixture", settings: { getSnapshot }, now: () => time });
    try {
      expect(await resolve("owner_fixture", selection)).toEqual({ provider: "anthropic", model: "claude-sonnet-5", apiMode: "anthropic_messages",
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-synthetic-only" }, baseUrl: "https://api.anthropic.com" });
      expect(getSnapshot).toHaveBeenCalledWith({ refresh: true, suppressFundedProbes: true, ownerKeyPreflight: { modelId: "claude-sonnet-5", credentialFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }, signal: expect.any(AbortSignal) });
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it.each(["owner", "model", "harness", "oauth", "source", "account", "multiple", "stale", "disabled", "offline", "empty", "symlink", "oversized"])("fails closed for %s without ambient/provider fallback", async (mode) => {
    const home = await mkdtemp(join(tmpdir(), "jev-key-denied-")); await mkdir(join(home, "system"));
    const path = join(home, "system/config.json");
    await writeFile(path, JSON.stringify({ kernel: { anthropicApiKey: mode === "empty" ? "" : "sk-ant-api03-synthetic-only" }, padding: mode === "oversized" ? "x".repeat(65536) : "" }));
    if (mode === "symlink") { await rm(path); await writeFile(join(home, "fixture.json"), '{"kernel":{"anthropicApiKey":"synthetic"}}'); await symlink(join(home, "fixture.json"), path); }
    const value = snapshot();
    if (mode === "oauth") value.accounts[0]!.authMethod = "oauth";
    if (mode === "source") value.harnesses[0]!.accessSourceId = "owner_anthropic_profile";
    if (mode === "account") value.harnesses[0]!.selectedAccountId = "different_account";
    if (mode === "multiple") value.harnesses.push({ ...value.harnesses[0]!, id: "second_hermes" });
    if (mode === "stale") value.accessSources[0]!.readiness.staleAfter = new Date(time - 1).toISOString();
    if (mode === "disabled") value.harnesses[0]!.enabled = false;
    if (mode === "offline") value.harnesses[0]!.connectivity = "offline";
    const resolve = createJevHermesCredentialResolver({ homePath: home, ownerId: "owner_fixture", settings: { getSnapshot: async () => value }, now: () => time });
    try { await expect(resolve(mode === "owner" ? "foreign_owner" : "owner_fixture", { ...selection,
      ...(mode === "model" ? { model: "anthropic:unselected" } : {}), ...(mode === "harness" ? { instanceId: "pi_default" } : {}) })).rejects.toThrow(); }
    finally { await rm(home, { recursive: true, force: true }); }
  });
});
