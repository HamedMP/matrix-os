import { describe, expect, it, vi } from "vitest";
import { readCollaborationNativeAccounts } from "../../packages/gateway/src/ai-providers/collaboration-native-accounts.js";
import { bindNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";
import type { ProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";

const config = { harnesses: [
  { harness: "codex", enabled: true, accessSourceId: "owner_openai_profile" },
  { harness: "claude", enabled: true, accessSourceId: "owner_claude_profile" },
] } as Pick<ProviderSettingsConfiguration, "harnesses">;

describe("shared availability native account observations", () => {
  it.each(["codex", "claude_code"] as const)("checks only %s identity without quota when both agents are enabled", async driverKind => {
    const value = bindNativeAccountMetadata({ accountLabel: "Test account", authMethod: "terminal",
      checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 30_000).toISOString() }, async () => true, "native-principal");
    const codex = vi.fn(async () => value), claude = vi.fn(async () => value);
    const observed = await readCollaborationNativeAccounts({ config, chatRoute: { driverKind, modelId: "native-model" }, codex, claude });
    if (driverKind === "codex") {
      expect(observed).toEqual({ codexMetadata: value, claudeMetadata: null });
      expect(codex).toHaveBeenCalledWith({ includeUsage: false });
      expect(claude).not.toHaveBeenCalled();
    } else {
      expect(observed).toEqual({ codexMetadata: null, claudeMetadata: value });
      expect(claude).toHaveBeenCalledWith(false);
      expect(codex).not.toHaveBeenCalled();
    }
  });

  it("rejects unverified selected account metadata without falling back", async () => {
    const value = { accountLabel: "Unbound", authMethod: "terminal" as const,
      checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 30_000).toISOString() };
    const claude = vi.fn(async () => value);
    expect(await readCollaborationNativeAccounts({ config, chatRoute: { driverKind: "codex", modelId: "native-model" },
      codex: async () => value, claude })).toEqual({ codexMetadata: null, claudeMetadata: null });
    expect(claude).not.toHaveBeenCalled();
  });
});
