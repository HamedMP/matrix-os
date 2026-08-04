import { describe, expect, it, vi } from "vitest";
import { createOpenClawRuntimeAdapter } from "../../packages/gateway/src/agent-config/openclaw-adapter.js";
import { AgentConfigError } from "../../packages/gateway/src/agent-config/errors.js";

function createRpc(responses: Record<string, unknown[]>) {
  return {
    call: vi.fn(async (method: string) => {
      const queue = responses[method];
      if (!queue?.length) throw new Error(`Unexpected RPC method: ${method}`);
      const response = queue.shift();
      if (response instanceof Error) throw response;
      return response;
    }),
    close: vi.fn(async () => {}),
  };
}

function config(primary: string | null, hash = "config-hash") {
  return {
    valid: true,
    hash,
    config: primary === null
      ? { agents: { defaults: { model: {} } } }
      : { agents: { defaults: { model: { primary } } } },
  };
}

const models = {
  models: [{
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    provider: "anthropic",
    available: true,
    contextWindow: 200_000,
    reasoning: true,
  }, {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    available: false,
  }, {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    available: false,
  }, {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai",
    available: true,
  }],
};

const auth = {
  ts: 1_789_000_000_000,
  providers: [{
    provider: "anthropic",
    displayName: "Anthropic",
    status: "ok",
    profiles: [{ profileId: "anthropic:default", type: "oauth", status: "ok" }],
  }, {
    provider: "openai",
    displayName: "OpenAI",
    status: "static",
    profiles: [{ profileId: "openai:default", type: "api_key", status: "static" }],
  }],
};

function lifecycle(overrides: { installed?: boolean; active?: boolean } = {}) {
  return {
    status: vi.fn(async () => ({
      installed: overrides.installed ?? true,
      active: overrides.active ?? true,
      version: "2026.7.1",
    })),
    activate: vi.fn(async () => {}),
    deactivate: vi.fn(async () => {}),
  };
}

describe("OpenClaw messaging runtime adapter", () => {
  it("normalizes the bounded model and authentication catalogs", async () => {
    const rpc = createRpc({
      "models.list": [models],
      "models.authStatus": [auth],
    });
    const adapter = createOpenClawRuntimeAdapter({ rpc, lifecycle: lifecycle() });

    await expect(adapter.catalog(new AbortController().signal)).resolves.toEqual([
      expect.objectContaining({
        id: "anthropic",
        displayName: "Anthropic",
        runtime: "openclaw",
        authKind: "oauth_login",
        authStatus: { state: "ready", authenticated: true, action: "none" },
        models: [expect.objectContaining({
          id: "claude-opus-4-6",
          displayName: "Claude Opus 4.6",
          capabilities: ["tools", "reasoning", "long_context"],
          available: true,
        }), expect.objectContaining({ id: "claude-sonnet-4-5", available: false })],
      }),
      expect.objectContaining({
        id: "openai",
        authKind: "api_key",
        authStatus: { state: "ready", authenticated: true, action: "none" },
      }),
    ]);
    expect(rpc.call).toHaveBeenNthCalledWith(
      1,
      "models.list",
      { view: "configured" },
      expect.any(AbortSignal),
    );
    expect(rpc.call).toHaveBeenNthCalledWith(
      2,
      "models.authStatus",
      { refresh: false },
      expect.any(AbortSignal),
    );
  });

  it("accepts OpenClaw catalog metadata and expiring credentials", async () => {
    const rpc = createRpc({
      "models.list": [{
        models: [{
          id: "claude-opus-4-6",
          name: "Claude Opus 4.6",
          provider: "anthropic",
          available: true,
          contextTokens: 200_000,
          releaseDate: "2026-04-01",
        }],
      }],
      "models.authStatus": [{
        ts: 1_789_000_000_000,
        providers: [{
          provider: "anthropic",
          status: "expiring",
          profiles: [{ profileId: "anthropic:default", type: "oauth", status: "expiring" }],
        }],
      }],
    });
    const adapter = createOpenClawRuntimeAdapter({ rpc, lifecycle: lifecycle() });

    await expect(adapter.catalog(new AbortController().signal)).resolves.toEqual([
      expect.objectContaining({
        id: "anthropic",
        authStatus: { state: "ready", authenticated: true, action: "none" },
        models: [expect.objectContaining({
          id: "claude-opus-4-6",
          capabilities: ["tools", "long_context"],
        })],
      }),
    ]);
  });

  it("retains an available model when a provider catalog exceeds its cap", async () => {
    const providerModels = [
      ...Array.from({ length: 128 }, (_, index) => ({
        id: `unavailable-${index}`,
        name: `Unavailable ${index}`,
        provider: "anthropic",
        available: false,
      })),
      {
        id: "available-model",
        name: "Available Model",
        provider: "anthropic",
        available: true,
      },
    ];
    const rpc = createRpc({
      "models.list": [{ models: providerModels }],
      "models.authStatus": [{ ts: 1_789_000_000_000, providers: [] }],
    });
    const adapter = createOpenClawRuntimeAdapter({ rpc, lifecycle: lifecycle() });

    const catalog = await adapter.catalog(new AbortController().signal);

    expect(catalog[0]?.models).toHaveLength(128);
    expect(catalog[0]?.models.some((model) => model.id === "available-model")).toBe(true);
  });

  it("caps provider grouping during catalog ingestion", async () => {
    const providerModels = Array.from({ length: 32 }, (_, index) => ({
      id: `model-${index}`,
      name: `Model ${index}`,
      provider: `p${String(index).padStart(2, "0")}`,
      available: true,
    })).reverse();
    const rpc = createRpc({
      "models.list": [{ models: providerModels }],
      "models.authStatus": [{ ts: 1_789_000_000_000, providers: [] }],
    });
    const adapter = createOpenClawRuntimeAdapter({ rpc, lifecycle: lifecycle() });

    const catalog = await adapter.catalog(new AbortController().signal);

    expect(catalog).toHaveLength(31);
    expect(catalog.some((provider) => provider.id === "p31")).toBe(true);
    expect(catalog.some((provider) => provider.id === "p00")).toBe(false);
  });

  it("reads the selected provider/model only from the redacted config snapshot", async () => {
    const rpc = createRpc({ "config.get": [config("anthropic/claude-opus-4-6")] });
    const adapter = createOpenClawRuntimeAdapter({ rpc, lifecycle: lifecycle() });

    await expect(adapter.selection(new AbortController().signal)).resolves.toEqual({
      runtime: "openclaw",
      provider: "anthropic",
      model: "claude-opus-4-6",
      configured: true,
    });
  });

  it("accepts OpenClaw's shorthand string model configuration", async () => {
    const rpc = createRpc({
      "config.get": [{
        valid: true,
        hash: "config-hash",
        config: { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } },
      }],
    });
    const adapter = createOpenClawRuntimeAdapter({ rpc, lifecycle: lifecycle() });

    await expect(adapter.selection(new AbortController().signal)).resolves.toEqual({
      runtime: "openclaw",
      provider: "anthropic",
      model: "claude-opus-4-6",
      configured: true,
    });
  });

  it("accepts an explicit null primary as an unconfigured selection", async () => {
    const rpc = createRpc({
      "config.get": [{
        valid: true,
        hash: "config-hash",
        config: { agents: { defaults: { model: { primary: null } } } },
      }],
    });
    const adapter = createOpenClawRuntimeAdapter({ rpc, lifecycle: lifecycle() });

    await expect(adapter.selection(new AbortController().signal)).resolves.toEqual({
      runtime: "openclaw",
      provider: null,
      model: null,
      configured: false,
    });
  });

  it("patches a catalog-backed selection with OpenClaw optimistic concurrency", async () => {
    const rpc = createRpc({
      "models.list": [models],
      "models.authStatus": [auth],
      "config.get": [
        config("openai/gpt-5.4", "before-hash"),
        config("anthropic/claude-opus-4-6", "after-hash"),
      ],
      "config.patch": [{ ok: true }],
    });
    const adapter = createOpenClawRuntimeAdapter({ rpc, lifecycle: lifecycle() });

    await expect(adapter.configure({
      provider: "anthropic",
      model: "claude-opus-4-6",
    }, new AbortController().signal)).resolves.toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(rpc.call).toHaveBeenCalledWith(
      "config.patch",
      {
        raw: JSON.stringify({
          agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
        }),
        baseHash: "before-hash",
      },
      expect.any(AbortSignal),
    );
  });

  it("rejects unavailable selections and custom base URLs before mutation", async () => {
    const rpc = createRpc({
      "models.list": [models, models],
      "models.authStatus": [auth, auth],
    });
    const adapter = createOpenClawRuntimeAdapter({ rpc, lifecycle: lifecycle() });
    const signal = new AbortController().signal;

    await expect(adapter.configure({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    }, signal)).rejects.toMatchObject({ kind: "not_configured" });
    await expect(adapter.configure({
      provider: "anthropic",
      model: "claude-opus-4-6",
      baseUrl: "https://models.example.com/v1",
    }, signal)).rejects.toMatchObject({ kind: "not_configured" });
    expect(rpc.call).not.toHaveBeenCalledWith(
      "config.patch",
      expect.anything(),
      expect.anything(),
    );
  });

  it("restores the prior primary when post-patch verification mismatches", async () => {
    const rpc = createRpc({
      "models.list": [models],
      "models.authStatus": [auth],
      "config.get": [
        config("openai/gpt-5.4", "before-hash"),
        config("openai/gpt-5.4", "mutated-hash"),
        config("anthropic/claude-opus-4-6", "rollback-read-hash"),
      ],
      "config.patch": [{ ok: true }, { ok: true }],
    });
    const adapter = createOpenClawRuntimeAdapter({ rpc, lifecycle: lifecycle() });

    await expect(adapter.configure({
      provider: "anthropic",
      model: "claude-opus-4-6",
    }, new AbortController().signal)).rejects.toMatchObject({
      kind: "invalid_response",
    });
    const patchCalls = rpc.call.mock.calls.filter(([method]) => method === "config.patch");
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls[1]?.[1]).toEqual({
      raw: JSON.stringify({
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
      }),
      baseHash: "rollback-read-hash",
    });
  });

  it("restores the prior primary when the rollback snapshot is malformed", async () => {
    const rpc = createRpc({
      "models.list": [models],
      "models.authStatus": [auth],
      "config.get": [
        config("openai/gpt-5.4", "before-hash"),
        config("openai/gpt-5.4", "mutated-hash"),
        config("INVALID PRIMARY", "rollback-read-hash"),
      ],
      "config.patch": [{ ok: true }, { ok: true }],
    });
    const adapter = createOpenClawRuntimeAdapter({ rpc, lifecycle: lifecycle() });

    await expect(adapter.configure({
      provider: "anthropic",
      model: "claude-opus-4-6",
    }, new AbortController().signal)).rejects.toMatchObject({
      kind: "invalid_response",
    });

    const patchCalls = rpc.call.mock.calls.filter(([method]) => method === "config.patch");
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls[1]?.[1]).toEqual({
      raw: JSON.stringify({
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
      }),
      baseHash: "rollback-read-hash",
    });
  });

  it("restores the prior primary when the initial patch outcome is unknown", async () => {
    const rpc = createRpc({
      "models.list": [models],
      "models.authStatus": [auth],
      "config.get": [
        config("openai/gpt-5.4", "before-hash"),
        config("anthropic/claude-opus-4-6", "rollback-read-hash"),
      ],
      "config.patch": [new Error("connection closed after write"), { ok: true }],
    });
    const adapter = createOpenClawRuntimeAdapter({ rpc, lifecycle: lifecycle() });

    await expect(adapter.configure({
      provider: "anthropic",
      model: "claude-opus-4-6",
    }, new AbortController().signal)).rejects.toMatchObject({ kind: "invalid_response" });

    const patchCalls = rpc.call.mock.calls.filter(([method]) => method === "config.patch");
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls[1]?.[1]).toEqual({
      raw: JSON.stringify({
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
      }),
      baseHash: "rollback-read-hash",
    });
  });

  it("does not overwrite a concurrent selection after a rejected patch", async () => {
    const rpc = createRpc({
      "models.list": [models],
      "models.authStatus": [auth],
      "config.get": [config("openai/gpt-5.4", "before-hash")],
      "config.patch": [new AgentConfigError("agent_config_conflict")],
    });
    const adapter = createOpenClawRuntimeAdapter({ rpc, lifecycle: lifecycle() });

    await expect(adapter.configure({
      provider: "anthropic",
      model: "claude-opus-4-6",
    }, new AbortController().signal)).rejects.toMatchObject({
      kind: "agent_config_conflict",
    });

    expect(rpc.call.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(1);
    expect(rpc.call.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(1);
  });

  it("recovers from a malformed existing primary when configuring a valid model", async () => {
    const rpc = createRpc({
      "models.list": [models],
      "models.authStatus": [auth],
      "config.get": [
        config("INVALID PRIMARY", "before-hash"),
        config("anthropic/claude-opus-4-6", "after-hash"),
      ],
      "config.patch": [{ ok: true }],
    });
    const adapter = createOpenClawRuntimeAdapter({ rpc, lifecycle: lifecycle() });

    await expect(adapter.configure({
      provider: "anthropic",
      model: "claude-opus-4-6",
    }, new AbortController().signal)).resolves.toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-6",
      configured: true,
    });
  });

  it("can restore an initially unset primary after a verification mismatch", async () => {
    const rpc = createRpc({
      "models.list": [models],
      "models.authStatus": [auth],
      "config.get": [
        config(null, "before-hash"),
        config("openai/gpt-5.4", "mutated-hash"),
        config("anthropic/claude-opus-4-6", "rollback-read-hash"),
      ],
      "config.patch": [{ ok: true }, { ok: true }],
    });
    const adapter = createOpenClawRuntimeAdapter({ rpc, lifecycle: lifecycle() });

    await expect(adapter.configure({
      provider: "anthropic",
      model: "claude-opus-4-6",
    }, new AbortController().signal)).rejects.toMatchObject({ kind: "invalid_response" });

    const patchCalls = rpc.call.mock.calls.filter(([method]) => method === "config.patch");
    expect(patchCalls[1]?.[1]).toEqual({
      raw: JSON.stringify({ agents: { defaults: { model: { primary: null } } } }),
      baseHash: "rollback-read-hash",
    });
  });

  it("fails closed when OpenClaw is absent and health-checks active installs", async () => {
    const missingRpc = createRpc({});
    const missing = createOpenClawRuntimeAdapter({
      rpc: missingRpc,
      lifecycle: lifecycle({ installed: false, active: false }),
    });
    await expect(missing.probe(new AbortController().signal)).resolves.toMatchObject({
      id: "openclaw",
      installState: "missing",
      health: "stopped",
      selectionState: "unavailable",
      setupAction: "install",
    });
    expect(missingRpc.call).not.toHaveBeenCalled();

    const stoppedRpc = createRpc({});
    const stopped = createOpenClawRuntimeAdapter({
      rpc: stoppedRpc,
      lifecycle: lifecycle({ installed: true, active: false }),
    });
    await expect(stopped.probe(new AbortController().signal)).resolves.toMatchObject({
      installState: "installed",
      health: "stopped",
      selectionState: "available",
      configured: false,
    });
    expect(stoppedRpc.call).not.toHaveBeenCalled();

    const activeRpc = createRpc({
      health: [{ ok: true, ts: 1_789_000_000_000 }],
      "config.get": [config("anthropic/claude-opus-4-6")],
    });
    const active = createOpenClawRuntimeAdapter({ rpc: activeRpc, lifecycle: lifecycle() });
    await expect(active.probe(new AbortController().signal)).resolves.toMatchObject({
      installState: "installed",
      health: "healthy",
      selectionState: "active",
      configured: true,
      version: "2026.7.1",
    });

    const malformedRpc = createRpc({
      health: [{ ok: true, ts: 1_789_000_000_001 }],
      "config.get": [config("INVALID PRIMARY")],
    });
    const malformed = createOpenClawRuntimeAdapter({ rpc: malformedRpc, lifecycle: lifecycle() });
    await expect(malformed.probe(new AbortController().signal)).resolves.toMatchObject({
      installState: "installed",
      health: "healthy",
      selectionState: "active",
      configured: false,
    });

    const unhealthyRpc = createRpc({
      health: [{ ok: false, ts: 1_789_000_000_002 }],
    });
    const unhealthy = createOpenClawRuntimeAdapter({
      rpc: unhealthyRpc,
      lifecycle: lifecycle(),
    });
    await expect(unhealthy.probe(new AbortController().signal)).rejects.toBeDefined();
    expect(unhealthyRpc.call).not.toHaveBeenCalledWith(
      "config.get",
      expect.anything(),
      expect.anything(),
    );
  });
});
