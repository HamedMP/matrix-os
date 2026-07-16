import { describe, expect, it } from "vitest";
import {
  configuredWorkspaceProviderAgents,
} from "../../packages/gateway/src/coding-agents/workspace-provider-config.js";

describe("coding-agent workspace provider configuration", () => {
  it("keeps the legacy workspace flag as a Codex-only configuration", () => {
    expect(configuredWorkspaceProviderAgents({
      MATRIX_CODING_AGENTS_WORKSPACE_PROVIDER: "1",
    })).toEqual(["codex"]);
  });

  it("uses an explicit bounded provider list when configured", () => {
    expect(configuredWorkspaceProviderAgents({
      MATRIX_CODING_AGENTS_WORKSPACE_PROVIDER: "1",
      MATRIX_CODING_AGENTS_WORKSPACE_PROVIDERS: " claude, codex ",
    })).toEqual(["claude", "codex"]);
  });

  it("returns no workspace providers when both flags are disabled", () => {
    expect(configuredWorkspaceProviderAgents({})).toEqual([]);
    expect(configuredWorkspaceProviderAgents({
      MATRIX_CODING_AGENTS_WORKSPACE_PROVIDER: "1",
      MATRIX_CODING_AGENTS_WORKSPACE_PROVIDERS: "",
    })).toEqual([]);
  });

  it.each([
    "claude,claude",
    "codex,unknown",
    "claude,,codex",
    "claude,codex,claude",
  ])("rejects unsafe workspace provider configuration without echoing it: %s", (value) => {
    expect(() => configuredWorkspaceProviderAgents({
      MATRIX_CODING_AGENTS_WORKSPACE_PROVIDERS: value,
    })).toThrowError("Invalid coding-agent workspace provider configuration");

    try {
      configuredWorkspaceProviderAgents({ MATRIX_CODING_AGENTS_WORKSPACE_PROVIDERS: value });
    } catch (err: unknown) {
      expect(err instanceof Error ? err.message : String(err)).not.toContain(value);
    }
  });

  it("rejects invalid legacy flag values", () => {
    expect(() => configuredWorkspaceProviderAgents({
      MATRIX_CODING_AGENTS_WORKSPACE_PROVIDER: "true",
    })).toThrowError("Invalid coding-agent workspace provider configuration");
  });
});
