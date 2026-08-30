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
import { useShellSessions } from "../../desktop/src/renderer/src/stores/shell-sessions";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

const checkedAt = "2026-08-30T10:00:00.000Z";

function snapshot(revision = 1): ProviderSettingsSnapshot {
  return {
    contractVersion: 1,
    projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision },
    revision,
    refreshedAt: checkedAt,
    access: { mode: "writable" },
    supportedActions: ["set_harness_enabled"],
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
  it("uses the authenticated runtime-bound API with bounded, abortable JSON reads", async () => {
    const get = vi.fn().mockResolvedValue(snapshot());
    const client = api({ get });
    const transport = createDesktopProviderSettingsTransport(client);
    const abort = new AbortController();

    await expect(transport.getSnapshot(abort.signal)).resolves.toEqual(snapshot());
    expect(get).toHaveBeenCalledWith("/api/ai/provider-settings", {
      maxBytes: 1024 * 1024,
      signal: abort.signal,
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
    expect(post).toHaveBeenCalledWith("/api/ai/provider-settings/actions", mutation, expect.objectContaining({
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
    }, { maxBytes: 8 * 1024 });
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

  it("opens and requests only the exact existing canonical Terminal session without creating one", async () => {
    const get = vi.fn().mockResolvedValue({
      sessions: [{ name: "provider-login", status: "active", cwd: "projects" }],
    });
    const post = vi.fn();
    const opened = await openExistingProviderTerminalSession(api({ get, post }), "provider-login");

    expect(opened).toBe(true);
    expect(get).toHaveBeenCalledWith("/api/terminal/sessions");
    expect(post).not.toHaveBeenCalled();
    expect(useTabs.getState().tabs).toEqual([expect.objectContaining({ kind: "terminals", title: "Terminal" })]);
    expect(useTabs.getState().terminalSessionRequest?.sessionName).toBe("provider-login");
  });

  it("rejects invalid, missing, or exited sessions without opening Terminal", async () => {
    const get = vi.fn().mockResolvedValue({ sessions: [{ name: "provider-login", status: "exited" }] });
    const client = api({ get });
    await expect(openExistingProviderTerminalSession(client, "../../secret")).resolves.toBe(false);
    await expect(openExistingProviderTerminalSession(client, "provider-login")).resolves.toBe(false);
    expect(useTabs.getState().tabs).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("does not open a provider login session after the desktop identity changes", async () => {
    const get = vi.fn().mockResolvedValue({
      sessions: [{ name: "provider-login", status: "active", cwd: "projects" }],
    });
    await expect(openExistingProviderTerminalSession(
      api({ get }),
      "provider-login",
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
