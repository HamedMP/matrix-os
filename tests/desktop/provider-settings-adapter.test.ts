import { useDesktopSurfaces } from "../../desktop/src/renderer/src/stores/desktop-surfaces";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsMutation, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AppError } from "../../desktop/src/shared/app-error";
import {
  createDesktopProviderSettingsTransport,
  desktopProviderIdentityKey,
  openExistingProviderTerminalSession,
  openAiCreditCheckout,
  openProviderAuthorizationPath,
} from "../../desktop/src/renderer/src/features/settings/provider-settings-desktop-adapter";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import { createApiClient } from "../../desktop/src/renderer/src/lib/api";
import { useShellSessions } from "../../desktop/src/renderer/src/stores/shell-sessions";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { advanceRuntimeGeneration } from "../../desktop/src/renderer/src/stores/runtime-generation";

const checkedAt = "2026-08-30T10:00:00.000Z";
const providerWorkspaceId = "tws_11111111111111111111111111111111";
const providerTabId = "tt_22222222222222222222222222222222";
const providerTerminalRef = `${providerWorkspaceId}:${providerTabId}`;

function providerTerminalWorkspaces(status: "running" | "exited" = "running") {
  return {
    workspaces: [{
      id: providerWorkspaceId,
      revision: 1,
      tabs: [{
        id: providerTabId,
        revision: 1,
        name: "provider-login",
        cwd: "projects",
        status,
      }],
    }],
  };
}

function snapshot(revision = 1): ProviderSettingsSnapshot {
  return {
    contractVersion: 1,
    projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision },
    revision,
    refreshedAt: checkedAt,
    access: { mode: "writable" },
    supportedActions: ["set_harness_enabled"],
    harnessCatalog: [
      { harness: "hermes", displayName: "Hermes", installState: "installed", available: true, runnable: true, setupAction: "none", safeReason: null },
      { harness: "openclaw", displayName: "OpenClaw", installState: "missing", available: false, runnable: false, setupAction: "none", safeReason: "runtime_not_supported" },
      { harness: "pi", displayName: "Pi", installState: "missing", available: false, runnable: false, setupAction: "none", safeReason: "runtime_not_supported" },
      { harness: "opencode", displayName: "OpenCode", installState: "missing", available: false, runnable: false, setupAction: "none", safeReason: "runtime_not_supported" },
    ],
    modelProviders: [{
      id: "anthropic",
      displayName: "Anthropic",
      models: [{ id: "anthropic/claude-sonnet-5", displayName: "Claude Sonnet 5", enabled: true }],
    }],
    accessSources: [{
      id: "source_matrix",
      kind: "matrix_gateway",
      fundingKind: "matrix_included",
      providerId: "anthropic",
      accountId: null,
      displayName: "Matrix AI",
      readiness: { state: "ready", checkedAt, staleAfter: null, action: "none", safeReason: null },
      eligibleModelIds: ["anthropic/claude-sonnet-5"],
      usage: {
        kind: "unavailable",
        authority: "unavailable",
        state: "unavailable",
        scope: "owner_entitlement",
        reason: "ledger_not_available",
        asOf: checkedAt,
      },
    }],
    accounts: [],
    harnesses: [{
      id: "harness_hermes",
      harness: "hermes",
      displayName: "Hermes",
      accentColor: "teal",
      enabled: true,
      version: "1.0.0",
      installState: "installed",
      authState: "authenticated",
      loginMethods: ["terminal"],
      recommendedLoginMethod: "terminal",
      connectivity: "online",
      accountIds: [],
      selectedAccountId: null,
      accessSourceId: "source_matrix",
      route: { kind: "configurable", providerId: "anthropic", modelId: "anthropic/claude-sonnet-5" },
      activeChatCount: 0,
    }],
    gatewayPolicy: {
      accessSourceId: "source_matrix",
      monthlyBudgetMicrousd: null,
      allowedModelIds: ["anthropic/claude-sonnet-5"],
      topUpEnabled: false,
    },
  };
}

function api(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    baseUrl: "https://app.matrix-os.com",
    forRuntime: vi.fn(),
    get: vi.fn(),
    getText: vi.fn(),
    getBlob: vi.fn(),
    post: vi.fn(),
    postBytes: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    putBytes: vi.fn(),
    delete: vi.fn(),
    putText: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  useShellSessions.setState({ sessions: [], loading: false, creating: false, error: null });
  useTabs.setState({
    tabs: [],
    activeTabId: null,
    terminalSessionRequest: null,
    terminalSessionRequestSequence: 0,
  });
});

describe("desktop provider settings transport", () => {
  it("extends actual snapshot dispatch while leaving auth and mutation defaults at ten seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const fetchFn = vi.fn().mockResolvedValueOnce(Response.json(snapshot()))
        .mockResolvedValueOnce(Response.json({ authenticated: true }))
        .mockResolvedValueOnce(Response.json({ kind: "snapshot", snapshot: snapshot(2) }));
      const client = createApiClient({ baseUrl: "https://runtime.example.test", getRuntimeSlot: () => "primary", fetchFn });
      const transport = createDesktopProviderSettingsTransport(client);
      await transport.getSnapshot(new AbortController().signal);
      expect(timeout).toHaveBeenLastCalledWith(15_000);
      await client.get("/api/auth/status");
      expect(timeout).toHaveBeenLastCalledWith(10_000);
      await transport.mutate({ type: "set_harness_enabled", harnessInstanceId: "harness_hermes", enabled: false,
        expectedRevision: 1, idempotencyKey: "cold_read_control" }, new AbortController().signal);
      expect(timeout).toHaveBeenLastCalledWith(10_000);
    } finally { timeout.mockRestore(); }
  });
  it("uses the authenticated runtime-bound API with bounded, abortable JSON reads", async () => {
    const get = vi.fn().mockResolvedValue(snapshot());
    const client = api({ get });
    const transport = createDesktopProviderSettingsTransport(client);
    const abort = new AbortController();

    await expect(transport.getSnapshot(abort.signal)).resolves.toEqual(snapshot());
    expect(get).toHaveBeenCalledWith("/api/ai/provider-settings?includeCapabilities=true&includeFundingState=true&includeModelCapabilities=true&includeMatrixModelInventory=true", {
      maxBytes: 1024 * 1024,
      signal: abort.signal,
      timeoutMs: 15_000,
    });
  });

  it("validates mutations and responses and preserves only controller-safe conflicts", async () => {
    const mutation: ProviderSettingsMutation = {
      type: "set_harness_enabled",
      harnessInstanceId: "harness_hermes",
      enabled: false,
      expectedRevision: 1,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    };
    const post = vi.fn().mockResolvedValue({ kind: "snapshot", snapshot: snapshot(2) });
    const transport = createDesktopProviderSettingsTransport(api({ post }));
    await expect(transport.mutate(mutation, new AbortController().signal))
      .resolves.toMatchObject({ kind: "snapshot", snapshot: { revision: 2 } });
    expect(post).toHaveBeenCalledWith("/api/ai/provider-settings/actions?includeCapabilities=true&includeFundingState=true&includeModelCapabilities=true&includeMatrixModelInventory=true", mutation, expect.objectContaining({
      maxBytes: 1024 * 1024,
      signal: expect.any(AbortSignal),
    }));

    const conflicted = createDesktopProviderSettingsTransport(api({
      post: vi.fn().mockRejectedValue(new AppError("server", { detail: "revision_conflict" })),
    }));
    await expect(conflicted.mutate(mutation, new AbortController().signal))
      .rejects.toMatchObject({ code: "revision_conflict", message: "Provider settings are unavailable." });
  });

  it("rejects invalid or secret-shaped response data before it reaches shared UI state", async () => {
    const transport = createDesktopProviderSettingsTransport(api({
      get: vi.fn().mockResolvedValue({ ...snapshot(), gatewayToken: "secret" }),
    }));
    await expect(transport.getSnapshot(new AbortController().signal))
      .rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("desktop provider connection actions", () => {
  it.each(["before request", "before navigation"])("rejects checkout when its identity leaves %s", async (boundary) => {
    let current = boundary !== "before request";
    const post = vi.fn(async () => {
      current = false;
      return { url: "https://checkout.stripe.com/c/pay/cs_previous" };
    });
    const openExternal = vi.fn();
    expect(await openAiCreditCheckout({ api: api({ post }), runtimeSlot: "primary", packageId: "usd_5",
      requestId: crypto.randomUUID(), openExternal, isIdentityCurrent: () => current })).toBe(false);
    expect(post).toHaveBeenCalledTimes(boundary === "before request" ? 0 : 1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("waits for cold readiness and payment checkout while other authenticated requests keep their default", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    try {
      const fetchFn = vi.fn().mockImplementationOnce((_url: string, init?: RequestInit) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(Response.json({ url: "https://checkout.stripe.com/c/pay/cs_cold" })), 18_000);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
      })).mockResolvedValueOnce(Response.json({ authenticated: true }));
      const client = createApiClient({ baseUrl: "https://runtime.example.test", getRuntimeSlot: () => "primary", fetchFn });
      const openExternal = vi.fn().mockResolvedValue(undefined);
      const result = openAiCreditCheckout({ api: client, runtimeSlot: "primary", packageId: "usd_5",
        requestId: "77f105df-6e24-4e13-a881-af9ce20d6a63", openExternal });
      await vi.advanceTimersByTimeAsync(18_000);
      expect(await result).toBe(true);
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(openExternal).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_cold");
      await client.get("/api/auth/status");
      expect(timeout).toHaveBeenLastCalledWith(10_000);
    } finally { vi.useRealTimers(); timeout.mockRestore(); }
  });

  it.each(["caller", "deadline"])("cancels stalled checkout at its %s boundary without opening a browser or retrying", async mode => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    try {
      const caller = new AbortController();
      let requestSignal: AbortSignal | null | undefined;
      const fetchFn = vi.fn((_url: string, init?: RequestInit) => {
        requestSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      });
      const client = createApiClient({ baseUrl: "https://runtime.example.test", getRuntimeSlot: () => "primary", fetchFn });
      const openExternal = vi.fn();
      const result = openAiCreditCheckout({ api: client, runtimeSlot: "primary", packageId: "usd_5",
        requestId: "77f105df-6e24-4e13-a881-af9ce20d6a63", signal: caller.signal, openExternal });
      if (mode === "caller") caller.abort();
      else {
        await vi.advanceTimersByTimeAsync(29_999);
        expect(requestSignal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(2);
      }
      expect(requestSignal?.aborted).toBe(true);
      expect(await result).toBe(false);
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      await vi.advanceTimersByTimeAsync(30_001);
      vi.useRealTimers(); timeout.mockRestore();
    }
  });

  it("does not open a late checkout URL after its caller cancels", async () => {
    const caller = new AbortController();
    let resolveResponse!: (response: Response) => void;
    const fetchFn = vi.fn(() => new Promise<Response>(resolve => { resolveResponse = resolve; }));
    const client = createApiClient({ baseUrl: "https://runtime.example.test", getRuntimeSlot: () => "primary", fetchFn });
    const openExternal = vi.fn();
    const result = openAiCreditCheckout({ api: client, runtimeSlot: "primary", packageId: "usd_5",
      requestId: "77f105df-6e24-4e13-a881-af9ce20d6a63", signal: caller.signal, openExternal });
    caller.abort();
    resolveResponse(Response.json({ url: "https://checkout.stripe.com/c/pay/cs_late" }));
    expect(await result).toBe(false);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens server-created AI credit checkout externally for the selected runtime", async () => {
    const post = vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_ai_25" });
    const openExternal = vi.fn().mockResolvedValue(undefined);
    await expect(openAiCreditCheckout({
      api: api({ post }),
      runtimeSlot: "studio",
      packageId: "usd_25",
      requestId: "77f105df-6e24-4e13-a881-af9ce20d6a63",
      openExternal,
    })).resolves.toBe(true);
    expect(post).toHaveBeenCalledWith("/billing/ai-credit/checkout", {
      packageId: "usd_25",
      runtimeSlot: "studio",
      requestId: "77f105df-6e24-4e13-a881-af9ce20d6a63",
    }, { maxBytes: 8 * 1024, timeoutMs: 30_000, signal: expect.any(AbortSignal) });
    expect(openExternal).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_ai_25");
  });

  it("rejects invalid AI checkout redirects without opening the browser", async () => {
    const openExternal = vi.fn();
    await expect(openAiCreditCheckout({
      api: api({ post: vi.fn().mockResolvedValue({ url: "https://evil.example/steal" }) }),
      runtimeSlot: "primary",
      packageId: "usd_5",
      requestId: crypto.randomUUID(),
      openExternal,
    })).resolves.toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("scopes provider state to owner, runtime slot, host, and credential generation", () => {
    expect(desktopProviderIdentityKey({
      status: "signed-in",
      handle: "alice",
      platformHost: "https://app.matrix-os.com",
      runtimeSlot: "vm-2",
      authGeneration: 7,
    })).toBe("signed-in|alice|https://app.matrix-os.com|vm-2|7");
  });

  it("opens and requests only the exact existing canonical Terminal tab without creating one", async () => {
    const get = vi.fn().mockResolvedValue(providerTerminalWorkspaces());
    const post = vi.fn();
    const root = useTabs.getState().openTab({ kind: "terminals", title: "Terminal" });
    useDesktopSurfaces.getState().reconcileTabs([root], { width: 1280, height: 800 });
    useDesktopSurfaces.getState().activateSurface(root);
    useDesktopSurfaces.getState().closeSurface(root);
    const opened = await openExistingProviderTerminalSession(api({ get, post }), providerTerminalRef);
    expect(useDesktopSurfaces.getState().surfaces[root]?.mode).toBe("window");

    expect(opened).toBe(true);
    expect(get).toHaveBeenCalledWith("/api/terminal/workspaces");
    expect(post).not.toHaveBeenCalled();
    expect(useTabs.getState().tabs).toEqual([expect.objectContaining({ kind: "terminals", title: "Terminal" })]);
    expect(useTabs.getState().terminalSessionRequest?.sessionName).toBe(providerTerminalRef);
  });

  it("rejects invalid, missing, or exited terminal refs without opening Terminal", async () => {
    const get = vi.fn().mockResolvedValue(providerTerminalWorkspaces("exited"));
    const client = api({ get });
    await expect(openExistingProviderTerminalSession(client, "../../secret")).resolves.toBe(false);
    await expect(openExistingProviderTerminalSession(client, providerTerminalRef)).resolves.toBe(false);
    expect(useTabs.getState().tabs).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("continues an existing login while an ordinary Terminal poll is still pending", async () => {
    let resolveHandoff!: (value: ReturnType<typeof providerTerminalWorkspaces>) => void;
    let resolvePoll!: (value: ReturnType<typeof providerTerminalWorkspaces>) => void;
    const get = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveHandoff = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolvePoll = resolve; }));
    const client = api({ get });
    const opening = openExistingProviderTerminalSession(client, providerTerminalRef);
    const polling = useShellSessions.getState().load(client);
    resolveHandoff(providerTerminalWorkspaces());

    expect(await opening).toBe(true);
    expect(useTabs.getState().terminalSessionRequest?.sessionName).toBe(providerTerminalRef);
    expect(useShellSessions.getState().sessions).toEqual([expect.objectContaining({ name: providerTerminalRef, status: "active" })]);
    expect(useShellSessions.getState().loading).toBe(true);
    resolvePoll(providerTerminalWorkspaces());
    expect(await polling).toEqual([expect.objectContaining({ name: providerTerminalRef, status: "active" })]);
    expect(useShellSessions.getState().loading).toBe(false);
  });

  it("uses a newer completed active snapshot instead of an older handoff snapshot", async () => {
    let resolveHandoff!: (value: ReturnType<typeof providerTerminalWorkspaces>) => void;
    const get = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveHandoff = resolve; }))
      .mockResolvedValueOnce(providerTerminalWorkspaces());
    const client = api({ get });
    const opening = openExistingProviderTerminalSession(client, providerTerminalRef);
    await useShellSessions.getState().load(client);
    resolveHandoff(providerTerminalWorkspaces("exited"));
    expect(await opening).toBe(true);
    expect(useShellSessions.getState().sessions[0]?.status).toBe("active");
  });

  it.each(["missing", "exited"] as const)("does not let a poll started before the handoff override its fresh %s result", async state => {
    let resolvePoll!: (value: ReturnType<typeof providerTerminalWorkspaces>) => void;
    let resolveHandoff!: (value: ReturnType<typeof providerTerminalWorkspaces>) => void;
    const get = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolvePoll = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveHandoff = resolve; }));
    const client = api({ get });
    const polling = useShellSessions.getState().load(client);
    const opening = openExistingProviderTerminalSession(client, providerTerminalRef);
    resolvePoll(providerTerminalWorkspaces());
    await polling;
    resolveHandoff(state === "missing" ? { workspaces: [] } : providerTerminalWorkspaces("exited"));

    expect(await opening).toBe(false);
    expect(useTabs.getState().tabs).toEqual([]);
    expect(useTabs.getState().terminalSessionRequest).toBeNull();
    expect(useShellSessions.getState().loading).toBe(false);
  });

  it.each(["missing", "exited"] as const)("does not let an older simultaneous handoff override a newer %s result", async state => {
    let resolveOlder!: (value: ReturnType<typeof providerTerminalWorkspaces>) => void;
    let resolveNewer!: (value: ReturnType<typeof providerTerminalWorkspaces>) => void;
    const get = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNewer = resolve; }));
    const client = api({ get });
    const older = openExistingProviderTerminalSession(client, providerTerminalRef);
    const newer = openExistingProviderTerminalSession(client, providerTerminalRef);
    resolveOlder(providerTerminalWorkspaces());
    expect(await older).toBe(false);
    expect(useShellSessions.getState().loading).toBe(true);
    expect(useTabs.getState().tabs).toEqual([]);
    resolveNewer(state === "missing" ? { workspaces: [] } : providerTerminalWorkspaces("exited"));
    expect(await newer).toBe(false);
    expect(useShellSessions.getState().loading).toBe(false);
    expect(useTabs.getState().terminalSessionRequest).toBeNull();
  });

  it("does not fall back to remembered sessions when the independent read fails", async () => {
    await useShellSessions.getState().load(api({ get: vi.fn().mockResolvedValue(providerTerminalWorkspaces()) }));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await openExistingProviderTerminalSession(api({ get: vi.fn().mockRejectedValue(new AppError("offline")) }), providerTerminalRef)).toBe(false);
      expect(useTabs.getState().tabs).toEqual([]);
      expect(useShellSessions.getState().loading).toBe(false);
    } finally { warning.mockRestore(); }
  });

  it("clears its loading state on failure after invalidating an older pending poll", async () => {
    let resolvePoll!: (value: ReturnType<typeof providerTerminalWorkspaces>) => void;
    const get = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolvePoll = resolve; }))
      .mockRejectedValueOnce(new AppError("offline"));
    const client = api({ get });
    const polling = useShellSessions.getState().load(client);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await openExistingProviderTerminalSession(client, providerTerminalRef)).toBe(false);
      expect(useShellSessions.getState().loading).toBe(false);
      resolvePoll(providerTerminalWorkspaces());
      expect(await polling).toBeNull();
      expect(useShellSessions.getState().loading).toBe(false);
      expect(useTabs.getState().tabs).toEqual([]);
    } finally { warning.mockRestore(); }
  });

  it("does not clear or invalidate a newer poll when its independent read fails", async () => {
    let rejectHandoff!: (error: Error) => void;
    let resolvePoll!: (value: ReturnType<typeof providerTerminalWorkspaces>) => void;
    const get = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectHandoff = reject; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolvePoll = resolve; }));
    const client = api({ get });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const opening = openExistingProviderTerminalSession(client, providerTerminalRef);
      const polling = useShellSessions.getState().load(client);
      rejectHandoff(new AppError("offline"));
      expect(await opening).toBe(false);
      expect(useShellSessions.getState().loading).toBe(true);
      resolvePoll(providerTerminalWorkspaces());
      expect(await polling).toEqual([expect.objectContaining({ name: providerTerminalRef, status: "active" })]);
      expect(useShellSessions.getState().loading).toBe(false);
      expect(useTabs.getState().tabs).toEqual([]);
    } finally { warning.mockRestore(); }
  });

  it.each(["missing", "exited", "deleted"] as const)("does not reopen a login after newer authoritative evidence says %s", async state => {
    let resolveHandoff!: (value: ReturnType<typeof providerTerminalWorkspaces>) => void;
    const get = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveHandoff = resolve; }))
      .mockResolvedValueOnce(state === "missing" ? { workspaces: [] } : providerTerminalWorkspaces(state === "exited" ? "exited" : "running"));
    const client = api({ get, delete: vi.fn().mockResolvedValue(undefined) });
    const opening = openExistingProviderTerminalSession(client, providerTerminalRef);
    await useShellSessions.getState().load(client);
    if (state === "deleted") await useShellSessions.getState().deleteSession(client, providerTerminalRef);
    resolveHandoff(providerTerminalWorkspaces());

    expect(await opening).toBe(false);
    expect(useTabs.getState().tabs).toEqual([]);
    expect(useTabs.getState().terminalSessionRequest).toBeNull();
  });

  it("rejects a late independent handoff read after the runtime generation changes", async () => {
    let resolveHandoff!: (value: ReturnType<typeof providerTerminalWorkspaces>) => void;
    const get = vi.fn(() => new Promise(resolve => { resolveHandoff = resolve; }));
    const opening = openExistingProviderTerminalSession(api({ get }), providerTerminalRef);
    advanceRuntimeGeneration();
    resolveHandoff(providerTerminalWorkspaces());
    expect(await opening).toBe(false);
    expect(useTabs.getState().tabs).toEqual([]);
  });

  it("rejects a late independent handoff read after its identity changes", async () => {
    let current = true;
    let resolveHandoff!: (value: ReturnType<typeof providerTerminalWorkspaces>) => void;
    const opening = openExistingProviderTerminalSession(api({ get: vi.fn(() => new Promise(resolve => { resolveHandoff = resolve; })) }),
      providerTerminalRef, () => current);
    current = false;
    resolveHandoff(providerTerminalWorkspaces());
    expect(await opening).toBe(false);
    expect(useTabs.getState().terminalSessionRequest).toBeNull();
    expect(useShellSessions.getState().loading).toBe(false);
  });

  it("does not open a provider login tab after the desktop identity changes", async () => {
    const get = vi.fn().mockResolvedValue(providerTerminalWorkspaces());
    await expect(openExistingProviderTerminalSession(
      api({ get }),
      providerTerminalRef,
      () => false,
    )).resolves.toBe(false);
    expect(useTabs.getState().tabs).toEqual([]);
    expect(useTabs.getState().terminalSessionRequest).toBeNull();
  });

  it("opens only the schema-approved owner-relative authorization path through HTTPS IPC", async () => {
    const openExternal = vi.fn().mockResolvedValue({ ok: true });
    await expect(openProviderAuthorizationPath({
      authorizationPath: "/api/ai/providers/login-attempts/attempt_browser/authorize",
      platformHost: "https://app.matrix-os.com",
      runtimeSlot: "vm-2",
      openExternal,
    })).resolves.toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://app.matrix-os.com/api/ai/providers/login-attempts/attempt_browser/authorize?runtime=vm-2");

    await expect(openProviderAuthorizationPath({
      authorizationPath: "https://evil.example/authorize",
      platformHost: "https://app.matrix-os.com",
      runtimeSlot: "primary",
      openExternal,
    })).resolves.toBe(false);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});
