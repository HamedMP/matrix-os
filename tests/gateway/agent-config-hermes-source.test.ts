import { describe, expect, it, vi } from "vitest";
import { AgentProviderDescriptorSchema } from "@matrix-os/contracts";
import {
  createHermesRuntimeSource,
  normalizeHermesRuntimeSnapshot,
} from "../../packages/gateway/src/agent-config/hermes-source.js";

describe("Hermes agent settings source", () => {
  it("shares the native wire budget so a large Copilot default cannot erase Codex", () => {
    const snapshot = normalizeHermesRuntimeSnapshot({ observedAt: 1000, status: { gateway_running: true }, options: {
      provider: "copilot", model: "copilot-127", providers: [
        { slug: "copilot", authenticated: true, models: Array.from({ length: 128 }, (_, i) => `copilot-${i}`) },
        { slug: "anthropic", authenticated: true, models: Array.from({ length: 128 }, (_, i) => `claude-${i}`) },
        { slug: "openai-codex", authenticated: true, is_user_defined: false, models: Array.from({ length: 10 }, (_, i) => `codex-${i}`) },
      ],
    } });
    expect(snapshot.providers.reduce((count, provider) => count + provider.models.length, 0)).toBe(253);
    expect(snapshot.providers.find(provider => provider.id === "openai-codex")?.models).toHaveLength(10);
    expect(snapshot.messaging).toMatchObject({ provider: "copilot", model: "copilot-127", configured: true });
  });

  it.each([
    ["openai-codex", "provider_profile"],
    ["openai-api", "api_key"],
    ["openrouter", "api_key"],
  ])("observes the pinned SDK's built-in %s inventory without auth_type", (provider, credentialKind) => {
    const observedAt = Date.now();
    const snapshot = normalizeHermesRuntimeSnapshot({ observedAt,
      status: { version: "0.21.4", gateway_running: false },
      options: { provider, model: "selected-model", providers: [{ slug: provider,
        is_user_defined: false, authenticated: true, models: ["selected-model"] }] },
    });
    expect(snapshot.runtime.options[0]?.nativeRouteObservation).toMatchObject({
      providerId: provider, modelId: "selected-model", credentialKind,
      localObservation: { state: "present_unverified", checkedAt: new Date(observedAt).toISOString() },
    });
  });

  it.each([
    { slug: "unknown", is_user_defined: false },
    { slug: "openai-codex", is_user_defined: true },
    { slug: "openai-codex", auth_type: "external_process", is_user_defined: false },
    { slug: "openai-codex" },
  ])("does not infer a supported credential source from ambiguous inventory %j", (provider) => {
    const snapshot = normalizeHermesRuntimeSnapshot({ observedAt: Date.now(), status: {},
      options: { provider: provider.slug, model: "selected-model", providers: [{ ...provider,
        authenticated: true, models: ["selected-model"] }] },
    });
    expect(snapshot.runtime.options[0]?.nativeRouteObservation?.credentialKind).not.toBe("provider_profile");
    expect(snapshot.runtime.options[0]?.nativeRouteObservation?.credentialKind).not.toBe("api_key");
  });

  it("normalizes the dashboard inventory into the shared provider contract", () => {
    const snapshot = normalizeHermesRuntimeSnapshot({
      status: {
        version: "1.0.0",
        gateway_running: true,
      },
      options: {
        provider: "nous",
        model: "hermes-4-405b",
        providers: [{
          slug: "nous",
          name: "Nous Portal",
          authenticated: true,
          auth_type: "oauth",
          models: ["hermes-4-405b", "hermes-3-llama-3.1-405b"],
        }],
      },
    });

    expect(snapshot.runtime.options[0]).toMatchObject({
      id: "hermes",
      installState: "installed",
      health: "healthy",
      selectionState: "active",
      configured: true,
      version: "1.0.0",
    });
    expect(snapshot.providers).toHaveLength(1);
    expect(AgentProviderDescriptorSchema.safeParse(snapshot.providers[0]).success)
      .toBe(true);
    expect(snapshot.providers[0]).toMatchObject({
      id: "nous",
      displayName: "Nous Portal",
      runtime: "hermes",
      scopes: ["messaging"],
      authKind: "oauth_login",
      authStatus: { state: "ready", authenticated: true, action: "none" },
    });
    expect(snapshot.providers[0]?.models.map((model) => model.id)).toEqual([
      "hermes-4-405b",
      "hermes-3-llama-3.1-405b",
    ]);
    expect(snapshot.messaging).toEqual({
      runtime: "hermes",
      provider: "nous",
      model: "hermes-4-405b",
      configured: true,
    });
  });

  it("loads status and curated model options with the caller's abort signal", async () => {
    const readJson = vi.fn(async (path: string, _signal: AbortSignal) => {
      if (path === "/api/status") {
        return { gateway_running: true };
      }
      return {
        provider: "nous",
        model: "hermes-4-405b",
        providers: [{
          slug: "nous",
          authenticated: true,
          auth_type: "oauth",
          models: ["hermes-4-405b"],
        }],
      };
    });
    const source = createHermesRuntimeSource(readJson);
    const signal = new AbortController().signal;

    const snapshot = await source(signal);

    expect(snapshot.messaging.configured).toBe(true);
    expect(readJson).toHaveBeenNthCalledWith(1, "/api/status", signal);
    expect(readJson).toHaveBeenNthCalledWith(2, "/api/model/options", signal);
  });

  it("keeps dashboard reachability when provider inventory requires authentication", async () => {
    const readJson = vi.fn(async (path: string) => {
      if (path === "/api/status") {
        return { gateway_running: false, version: "0.19.1" };
      }
      throw new Error("provider inventory unauthorized");
    });
    const logWarning = vi.fn();
    const source = createHermesRuntimeSource(readJson, { logWarning });

    const snapshot = await source(new AbortController().signal);

    expect(snapshot.runtime.options[0]).toMatchObject({
      id: "hermes",
      installState: "installed",
      health: "degraded",
      configured: false,
      version: "0.19.1",
    });
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.messaging).toEqual({
      runtime: "hermes",
      provider: null,
      model: null,
      configured: false,
    });
    expect(logWarning).toHaveBeenCalledOnce();
    expect(logWarning).toHaveBeenCalledWith("Error");
  });

  it("orders selected and ready catalog entries deterministically", () => {
    const snapshot = normalizeHermesRuntimeSnapshot({
      status: { gateway_running: true },
      options: {
        provider: "nous",
        model: "selected-model",
        providers: [
          {
            slug: "zulu",
            authenticated: false,
            auth_type: "api_key",
            models: ["z-model"],
          },
          {
            slug: "nous",
            authenticated: true,
            auth_type: "oauth",
            models: ["z-model", "selected-model", "a-model"],
          },
          {
            slug: "alpha",
            authenticated: true,
            auth_type: "api_key",
            models: ["model"],
          },
        ],
      },
    });

    expect(snapshot.providers.map((provider) => provider.id)).toEqual([
      "nous",
      "alpha",
      "zulu",
    ]);
    expect(snapshot.providers[0]?.models.map((model) => model.id)).toEqual([
      "selected-model",
      "a-model",
      "z-model",
    ]);
  });

  it("omits pro models without losing a selected ordinary model", () => {
    const selectedOrdinary = normalizeHermesRuntimeSnapshot({
      status: { gateway_running: true },
      options: {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        providers: [{
          slug: "openai-codex",
          authenticated: true,
          auth_type: "oauth",
          models: [
            "gpt-5.6-terra-pro",
            "gpt-5.6-sol",
            "gpt-5.6-sol-pro",
            "gpt-5.6-luna",
          ],
        }],
      },
    });
    const staleProSelection = normalizeHermesRuntimeSnapshot({
      status: { gateway_running: true },
      options: {
        provider: "openai-codex",
        model: "gpt-5.6-sol-pro",
        providers: [{
          slug: "openai-codex",
          authenticated: true,
          auth_type: "oauth",
          models: ["gpt-5.6-sol", "gpt-5.6-sol-pro"],
        }],
      },
    });

    expect(selectedOrdinary.providers[0]?.models.map((model) => model.id))
      .toEqual(["gpt-5.6-sol", "gpt-5.6-luna"]);
    expect(selectedOrdinary.messaging).toEqual({
      runtime: "hermes",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      configured: true,
    });
    expect(staleProSelection.providers[0]?.models.map((model) => model.id))
      .toEqual(["gpt-5.6-sol"]);
    expect(staleProSelection.runtime.options[0]?.configured).toBe(false);
    expect(staleProSelection.messaging).toEqual({
      runtime: "hermes",
      provider: null,
      model: null,
      configured: false,
    });
  });

  it("coalesces concurrent reads and reuses a five-second snapshot", async () => {
    let now = 1_000;
    const readJson = vi.fn(async (path: string) => {
      await Promise.resolve();
      return path === "/api/status"
        ? { gateway_running: true }
        : { provider: "", model: "", providers: [] };
    });
    const source = createHermesRuntimeSource(readJson, {
      cacheTtlMs: 5_000,
      now: () => now,
    });
    const signal = new AbortController().signal;

    await Promise.all([source(signal), source(signal), source(signal)]);
    await source(signal);
    expect(readJson).toHaveBeenCalledTimes(2);

    now += 5_001;
    await source(signal);
    expect(readJson).toHaveBeenCalledTimes(4);
  });

  it("invalidates a cached inventory after a successful configuration mutation", async () => {
    const readJson = vi.fn(async (path: string) => path === "/api/status"
      ? { gateway_running: true }
      : { provider: "", model: "", providers: [] });
    const source = createHermesRuntimeSource(readJson, { cacheTtlMs: 5_000 });
    const signal = new AbortController().signal;

    await source(signal);
    await source(signal);
    expect(readJson).toHaveBeenCalledTimes(2);

    source.invalidate();
    await source(signal);

    expect(readJson).toHaveBeenCalledTimes(4);
  });

  it("negative-caches an unreachable runtime without logging raw errors", async () => {
    const canary = "sk-secret-upstream-canary";
    const readJson = vi.fn(async () => {
      throw new Error(canary);
    });
    const logWarning = vi.fn();
    const source = createHermesRuntimeSource(readJson, { logWarning });
    const signal = new AbortController().signal;

    const snapshots = await Promise.all([
      source(signal),
      source(signal),
      source(signal),
    ]);
    await source(signal);

    expect(snapshots.map((snapshot) => snapshot.runtime.options[0]?.health))
      .toEqual(["unreachable", "unreachable", "unreachable"]);
    expect(readJson).toHaveBeenCalledTimes(2);
    expect(logWarning).toHaveBeenCalledOnce();
    expect(logWarning).toHaveBeenCalledWith("Error");
    expect(JSON.stringify(logWarning.mock.calls)).not.toContain(canary);
  });
});
