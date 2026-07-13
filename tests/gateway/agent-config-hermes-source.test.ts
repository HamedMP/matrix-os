import { describe, expect, it, vi } from "vitest";
import { AgentProviderDescriptorSchema } from "@matrix-os/contracts";
import {
  createHermesRuntimeSource,
  normalizeHermesRuntimeSnapshot,
} from "../../packages/gateway/src/agent-config/hermes-source.js";

describe("Hermes agent settings source", () => {
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
