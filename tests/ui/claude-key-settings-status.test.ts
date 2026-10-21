import { describe, expect, it } from "vitest";
import type { ProviderAccessSource, ProviderAccount, ProviderHarnessInstance } from "../../packages/contracts/src/index.js";
import { isNativeAccountSource } from "../../packages/ui/src/agents-providers/harness-connection.js";
import { resolvedWorkflowRowStatus } from "../../packages/ui/src/agents-providers/workflow-row-status.js";

const readiness = { state: "unknown", checkedAt: null, staleAfter: null, action: "retry", safeReason: "unknown" } as ProviderAccessSource["readiness"];
const keySource = { id: "owner_anthropic_key", kind: "provider_account", providerId: "anthropic", accountId: "owner_anthropic",
  fundingKind: "owner_api_key", displayName: "Anthropic API key", eligibleModelIds: ["claude-sonnet-5"], readiness } as unknown as ProviderAccessSource;
const keyAccount = { id: "owner_anthropic", providerId: "anthropic", accessSourceId: "owner_anthropic_key", authMethod: "api_key", authState: "authenticated" } as unknown as ProviderAccount;
const claude = { id: "harness_claude_code", harness: "claude", installState: "installed", authState: "authenticated", enabled: true, configuredEnabled: true,
  accessSourceId: "owner_anthropic_key", selectedAccountId: "owner_anthropic", route: { kind: "fixed", providerId: "anthropic", modelId: "claude-sonnet-5" } } as unknown as ProviderHarnessInstance;

describe("Settings status for Claude on the owner's Anthropic key", () => {
  it("treats the selected owner key as Claude's own connection and shows it as Connected", () => {
    expect(isNativeAccountSource("claude", keySource, keyAccount)).toBe(true);
    expect(resolvedWorkflowRowStatus(claude, keySource)).toBe("Connected");
  });

  it("is Not connected once the gateway no longer reports the key as signed in", () => {
    expect(resolvedWorkflowRowStatus({ ...claude, authState: "unknown" }, keySource)).toBe("Not connected");
  });

  it("never treats a Matrix AI gateway source as Claude's own connection", () => {
    const matrix = { ...keySource, id: "matrix_included", kind: "matrix_gateway", fundingKind: "matrix_included", accountId: null } as unknown as ProviderAccessSource;
    expect(isNativeAccountSource("claude", matrix, undefined)).toBe(false);
  });
});
