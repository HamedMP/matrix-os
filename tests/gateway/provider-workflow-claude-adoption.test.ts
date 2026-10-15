import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createNativeProviderWorkflowAdapters } from "../../packages/gateway/src/ai-providers/provider-workflow-native.js";
import type { ProviderSettingsStoreWriter } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import type { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";

function fixture(previousSource: string) {
  const row = {
    id: "harness_claude_code", harness: "claude", displayName: "Claude Code",
    installState: "installed", enabled: false, configuredEnabled: false,
    authState: "unknown", loginMethods: ["terminal"],
    accessSourceId: previousSource, configuredAccessSourceId: previousSource,
    selectedAccountId: null,
    route: { kind: "fixed", providerId: "anthropic", modelId: "claude-sonnet-5" },
  };
  const snapshot = {
    revision: 7, access: { mode: "writable" }, harnesses: [row], harnessCatalog: [],
    accounts: [{ id: "owner_claude_profile", providerId: "anthropic",
      accessSourceId: "owner_claude_profile", authMethod: "terminal", authState: "authenticated" }],
    accessSources: [{ id: "owner_claude_profile", providerId: "anthropic", kind: "provider_account",
      fundingKind: "owner_account", accountId: "owner_claude_profile", eligibleModelIds: [row.route.modelId] }],
  };
  const ref = { workspaceId: "tws_11111111111111111111111111111111", tabId: "tt_11111111111111111111111111111111" };
  const store = {
    getSnapshot: vi.fn(async () => snapshot),
    completeClaudeNativeLogin: vi.fn(async () => ({ kind: "snapshot", snapshot })),
    mutate: vi.fn(async () => ({ kind: "login_attempt", attempt: { action: {
      kind: "open_terminal", terminalSessionId: `${ref.workspaceId}:${ref.tabId}`,
    } } })),
  } as unknown as ProviderSettingsStoreWriter;
  const terminal = {
    ensureWorkspace: vi.fn(async () => ({ id: ref.workspaceId })),
    createTab: vi.fn(), terminateTab: vi.fn(async () => {}),
    listWorkspaces: vi.fn(async () => [{ tabs: [{ id: ref.tabId, workspaceId: ref.workspaceId }] }]),
    attach: vi.fn(() => ({ close: vi.fn(), send: vi.fn() })),
  } as unknown as Pick<TerminalRuntimeSocketClient, "ensureWorkspace" | "createTab" | "terminateTab" | "attach" | "listWorkspaces">;
  const browserLogin = vi.fn(async () => ({ cancel: vi.fn(async () => {}), submitCode: vi.fn(async () => {}) }));
  return { store, terminal, browserLogin };
}

it.each(["owner_anthropic_profile", "owner_anthropic_key", "matrix_anthropic"])(
  "foreground Connect adopts an authenticated native Claude account instead of repeating OAuth from %s", async previousSource => {
    const f = fixture(previousSource);
    const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal,
      claudeBrowserLogin: f.browserLogin, runtimePrefix: "/synthetic/native-adoption-runtime",
      hostControl: { available: false, run: vi.fn() } });
    // Reading connection capabilities must never select an account or enable Off.
    expect(f.store.completeClaudeNativeLogin).not.toHaveBeenCalled();
    expect(f.store.mutate).not.toHaveBeenCalled();
    const publish = vi.fn();
    const key = `foreground-adopt-${previousSource}`;
    const running = await adapter!.start({
      connectionOption: { id: "anthropic_browser", providerId: "anthropic", authKind: "subscription",
        billingKind: "subscription", executionKind: "native", availability: "available", method: "browser" },
      request: { harnessInstanceId: "harness_claude_code", kind: "login", method: "browser", idempotencyKey: key },
      registerCleanup: vi.fn(), publish,
    });
    try {
      expect(f.store.completeClaudeNativeLogin).toHaveBeenCalledWith({
        harnessInstanceId: "harness_claude_code", expectedRevision: 7,
        idempotencyKey: `connect-${createHash("sha256").update(key).digest("hex")}`,
      });
      expect(publish).toHaveBeenCalledWith({ state: "succeeded", safeFailure: null });
      expect(f.browserLogin).not.toHaveBeenCalled();
      expect(f.terminal.createTab).not.toHaveBeenCalled();
      expect(f.terminal.attach).not.toHaveBeenCalled();
      expect(f.store.mutate).not.toHaveBeenCalled();
      expect(f.store.getSnapshot).toHaveBeenCalledWith({
        refresh: true, includeNativeAccountMetadata: true, includeNativeAccountUsage: false,
      });
    } finally { await running.cancel(); }
  },
);
