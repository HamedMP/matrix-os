import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStatus } from "../../packages/gateway/src/agent-launcher.js";
import { resolveAgentCredentialProbe } from "../../packages/gateway/src/onboarding/agent-credential-probe.js";

function installedStatus(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: "claude",
    command: "claude",
    displayName: "Claude",
    installState: "installed",
    installed: true,
    authState: "required",
    workspaceCompatibility: "compatible",
    errorCode: "agent_auth_required",
    ...overrides,
  };
}

describe("agent credential probe", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), "agent-credential-probe-"));
    mkdirSync(join(homePath, "system"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("treats an installed Claude CLI as authenticated when the owner stored an API key", async () => {
    writeFileSync(
      join(homePath, "system/config.json"),
      JSON.stringify({ kernel: { anthropicApiKey: "sk-ant-owner-key" } }),
    );

    await expect(resolveAgentCredentialProbe(homePath, "claude", installedStatus())).resolves.toEqual({
      available: true,
      condition: "available",
    });
  });

  it("treats an installed Claude CLI as authenticated when the owner has a Claude login", async () => {
    writeFileSync(
      join(homePath, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "oauth-account" } }),
    );

    await expect(resolveAgentCredentialProbe(homePath, "claude", installedStatus())).resolves.toEqual({
      available: true,
      condition: "available",
    });
  });

  it("does not hide a missing or unsupported Claude executable behind owner credentials", async () => {
    writeFileSync(
      join(homePath, "system/config.json"),
      JSON.stringify({ kernel: { anthropicApiKey: "sk-ant-owner-key" } }),
    );

    await expect(resolveAgentCredentialProbe(homePath, "claude", installedStatus({
      installState: "missing",
      installed: false,
      authState: "unknown",
      workspaceCompatibility: "unknown",
      errorCode: "agent_missing",
    }))).resolves.toEqual({ available: false, condition: "missing" });
    await expect(resolveAgentCredentialProbe(homePath, "claude", installedStatus({
      authState: "error",
      workspaceCompatibility: "unsupported",
      errorCode: "agent_version_unsupported",
    }))).resolves.toEqual({ available: false, condition: "version_unsupported" });
  });

  it("keeps Codex and platform-only Claude results tied to the native credential probe", async () => {
    await expect(resolveAgentCredentialProbe(homePath, "claude", installedStatus())).resolves.toEqual({
      available: false,
      condition: "auth_required",
    });
    await expect(resolveAgentCredentialProbe(homePath, "codex", installedStatus({
      id: "codex",
      command: "codex",
      displayName: "Codex",
      authState: "ok",
      errorCode: null,
    }))).resolves.toEqual({ available: true, condition: "available" });
  });
});
