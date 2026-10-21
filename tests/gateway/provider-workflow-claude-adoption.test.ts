import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createNativeProviderWorkflowAdapters } from "../../packages/gateway/src/ai-providers/provider-workflow-native.js";
import type { ProviderSettingsStoreWriter } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import type { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import { createProviderWorkflowService, ProviderWorkflowNotStartedError } from "../../packages/gateway/src/ai-providers/provider-workflows.js";

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
  return { store, terminal, browserLogin, snapshot, row };
}

async function adapterFor(f: ReturnType<typeof fixture>) {
  const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: f.terminal,
    claudeBrowserLogin: f.browserLogin, runtimePrefix: "/synthetic/native-adoption-runtime",
    hostControl: { available: false, run: vi.fn() } });
  return adapter!;
}
function start(adapter: Awaited<ReturnType<typeof adapterFor>>, method: "browser" | "terminal" = "browser") {
  return adapter.start({ request: { harnessInstanceId: "harness_claude_code", kind: "login", method,
    idempotencyKey: "explicit-owner-connect" }, registerCleanup: vi.fn(), publish: vi.fn() });
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

it("signed-out browser admission retains conflict and can retry after the existing writer drains", async () => {
  const f = fixture("owner_anthropic_profile");
  f.snapshot.accounts[0]!.authState = "unknown";
  f.browserLogin.mockRejectedValueOnce(new ProviderWorkflowNotStartedError("conflict"));
  const workflows = createProviderWorkflowService({ ownerId: "owner", adapters: [await adapterFor(f)] });
  const request = { harnessInstanceId: f.row.id, optionId: "anthropic_browser", idempotencyKey: "writer-busy" };
  try {
    await expect(workflows.startV2("owner", request)).rejects.toMatchObject({ code: "conflict" });
    f.snapshot.accounts[0]!.authState = "authenticated";
    expect((await workflows.startV2("owner", { ...request, idempotencyKey: "writer-drained" })).state).toBe("succeeded");
    expect(f.browserLogin).toHaveBeenCalledOnce();
    expect(f.store.completeClaudeNativeLogin).toHaveBeenCalledOnce();
  } finally { await workflows.close(); }
});

it("preflight observation failure does not strand a protected workflow or start OAuth", async () => {
  const f = fixture("owner_anthropic_profile");
  const adapter = await adapterFor(f);
  vi.mocked(f.store.getSnapshot).mockRejectedValueOnce(new Error("synthetic unavailable observation"));
  const workflows = createProviderWorkflowService({ ownerId: "owner", adapters: [adapter] });
  const request = { harnessInstanceId: f.row.id, optionId: "anthropic_browser", idempotencyKey: "unavailable-observation" };
  try {
    expect((await workflows.startV2("owner", request)).state).toBe("failed");
    expect(f.browserLogin).not.toHaveBeenCalled();
    expect((await workflows.startV2("owner", { ...request, idempotencyKey: "observation-retry" })).state).toBe("succeeded");
    expect(f.store.completeClaudeNativeLogin).toHaveBeenCalledOnce();
  } finally { await workflows.close(); }
});

it("foreground Terminal Connect also adopts the exact native account without another process", async () => {
  const f = fixture("owner_anthropic_profile");
  const running = await start(await adapterFor(f), "terminal");
  try {
    expect(f.store.completeClaudeNativeLogin).toHaveBeenCalledOnce();
    expect(f.store.mutate).not.toHaveBeenCalled();
    expect(f.terminal.attach).not.toHaveBeenCalled();
    expect(f.browserLogin).not.toHaveBeenCalled();
  } finally { await running.cancel(); }
});

it.each(["unknown", "failed", "missing"])("unverified native account %s retains normal login", async state => {
  const f = fixture("owner_anthropic_profile");
  if (state === "missing") f.snapshot.accounts = [];
  else f.snapshot.accounts[0]!.authState = state;
  const running = await start(await adapterFor(f));
  try {
    expect(f.browserLogin).toHaveBeenCalledOnce();
    expect(f.store.completeClaudeNativeLogin).not.toHaveBeenCalled();
    expect(f.store.mutate).not.toHaveBeenCalled();
  } finally { await running.cancel(); }
});

it.each(["revision_conflict", "principal_changed", "proof_expired", "writer_busy", "driver_removed"])(
  "private completion rejection %s stops without fallback or generic mutation", async reason => {
    const f = fixture("owner_anthropic_profile");
    vi.mocked(f.store.completeClaudeNativeLogin!).mockRejectedValueOnce(new Error(reason));
    await expect(start(await adapterFor(f))).rejects.toThrow(reason);
    expect(f.browserLogin).not.toHaveBeenCalled();
    expect(f.terminal.createTab).not.toHaveBeenCalled();
    expect(f.terminal.attach).not.toHaveBeenCalled();
    expect(f.store.mutate).not.toHaveBeenCalled();
  },
);

it.each(["read-only", "missing-driver", "wrong-provider", "wrong-model", "replaced-harness"])(
  "foreground adoption rejects changed exact route %s before completion", async change => {
    const f = fixture("owner_anthropic_profile");
    const adapter = await adapterFor(f);
    if (change === "read-only") f.snapshot.access.mode = "read_only";
    if (change === "missing-driver") f.row.installState = "missing";
    if (change === "wrong-provider") f.row.route.providerId = "openai";
    if (change === "wrong-model") f.row.route.modelId = "unrelated-model";
    if (change === "replaced-harness") f.row.id = "replacement";
    await expect(start(adapter)).rejects.toThrow("unavailable");
    expect(f.store.completeClaudeNativeLogin).not.toHaveBeenCalled();
    expect(f.store.mutate).not.toHaveBeenCalled();
    expect(f.browserLogin).not.toHaveBeenCalled();
  },
);
