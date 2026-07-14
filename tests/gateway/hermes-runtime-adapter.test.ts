import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeSettingsSnapshot } from "../../packages/gateway/src/agent-config/service.js";
import { createHermesRuntimeAdapter } from "../../packages/gateway/src/agent-config/hermes-adapter.js";

function snapshot(overrides: Partial<AgentRuntimeSettingsSnapshot> = {}): AgentRuntimeSettingsSnapshot {
  return {
    runtime: {
      selected: "hermes",
      options: [
        {
          id: "hermes",
          displayName: "Hermes",
          installState: "installed",
          health: "healthy",
          selectionState: "active",
          configured: true,
          capabilities: ["provider_catalog", "model_selection", "authentication"],
        },
        {
          id: "openclaw",
          displayName: "OpenClaw",
          installState: "missing",
          health: "stopped",
          selectionState: "unavailable",
          configured: false,
          capabilities: ["install"],
          setupAction: "install",
        },
      ],
      transition: null,
    },
    providers: [{
      id: "nous",
      displayName: "Nous",
      runtime: "hermes",
      scopes: ["messaging"],
      authKind: "oauth_login",
      supportedAuthKinds: ["oauth_login"],
      models: [{
        id: "hermes-4-405b",
        displayName: "Hermes 4 405B",
        capabilities: ["tools"],
        efforts: [],
        available: true,
      }, {
        id: "hermes-4-70b",
        displayName: "Hermes 4 70B",
        capabilities: ["tools"],
        efforts: [],
        available: true,
      }],
      authStatus: { state: "ready", authenticated: true, action: "none" },
    }],
    messaging: {
      runtime: "hermes",
      provider: "nous",
      model: "hermes-4-405b",
      configured: true,
    },
    ...overrides,
  };
}

describe("Hermes messaging runtime adapter", () => {
  it("configures only a catalog-backed provider/model and invalidates inventory", async () => {
    const source = vi.fn(async () => snapshot());
    const invalidate = vi.fn();
    Object.assign(source, { invalidate });
    const requestJson = vi.fn(async () => ({ ok: true }));
    const adapter = createHermesRuntimeAdapter({ source, requestJson });

    await expect(adapter.configure({
      provider: "nous",
      model: "hermes-4-405b",
    }, new AbortController().signal)).resolves.toEqual(snapshot().messaging);

    expect(requestJson).toHaveBeenCalledWith(
      "/api/model/set",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          scope: "main",
          provider: "nous",
          model: "hermes-4-405b",
        }),
      }),
      expect.any(AbortSignal),
    );
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it("rejects unknown selections and disallows base URLs for non-custom providers", async () => {
    const source = Object.assign(vi.fn(async () => snapshot()), {
      invalidate: vi.fn(),
    });
    const requestJson = vi.fn(async () => ({ ok: true }));
    const adapter = createHermesRuntimeAdapter({ source, requestJson });
    const signal = new AbortController().signal;

    await expect(adapter.configure({
      provider: "nous",
      model: "missing",
    }, signal)).rejects.toMatchObject({ kind: "not_configured" });
    await expect(adapter.configure({
      provider: "nous",
      model: "hermes-4-405b",
      baseUrl: "https://models.example.com/v1",
    }, signal)).rejects.toMatchObject({ kind: "not_configured" });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("restores the prior selection when post-mutation verification fails", async () => {
    const source = Object.assign(vi.fn(async () => snapshot()), {
      invalidate: vi.fn(),
    });
    const requestJson = vi.fn(async () => ({ ok: true }));
    const adapter = createHermesRuntimeAdapter({ source, requestJson });

    await expect(adapter.configure({
      provider: "nous",
      model: "hermes-4-70b",
    }, new AbortController().signal)).rejects.toMatchObject({
      kind: "invalid_response",
    });

    expect(requestJson).toHaveBeenNthCalledWith(2,
      "/api/model/set",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          scope: "main",
          provider: "nous",
          model: "hermes-4-405b",
        }),
      }),
      expect.any(AbortSignal),
    );
    expect(source.invalidate).toHaveBeenCalledTimes(2);
  });

  it("blocks private custom-provider base URLs before runtime mutation", async () => {
    const current = snapshot();
    const source = Object.assign(vi.fn(async () => snapshot({
      providers: [{
        ...current.providers[0]!,
        authKind: "base_url",
        supportedAuthKinds: ["base_url"],
      }],
    })), { invalidate: vi.fn() });
    const requestJson = vi.fn(async () => ({ ok: true }));
    const adapter = createHermesRuntimeAdapter({ source, requestJson });

    await expect(adapter.configure({
      provider: "nous",
      model: "hermes-4-405b",
      baseUrl: "https://127.0.0.1:8443/v1",
    }, new AbortController().signal)).rejects.toMatchObject({
      kind: "agent_config_invalid",
    });
    expect(requestJson).not.toHaveBeenCalled();
  });
});
