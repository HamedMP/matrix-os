import { describe, expect, it, vi } from "vitest";
import { createHermesRoutes } from "../../packages/gateway/src/hermes/routes.js";
import { InMemoryHermesRepository } from "../../packages/gateway/src/hermes/repository.js";
import { createHermesEventHub } from "../../packages/gateway/src/hermes/event-hub.js";
import type { HermesBridge } from "../../packages/gateway/src/hermes/bridge.js";
import type { HermesCredentialStore } from "../../packages/gateway/src/hermes/credential-store.js";
import { MAX_HERMES_APPROVALS, MAX_HERMES_MODEL_PROVIDERS, redactLabel } from "../../packages/gateway/src/hermes/contracts.js";

function jsonRequest(path: string, method: "POST", body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deps(userId = "user_123") {
  const repository = new InMemoryHermesRepository();
  const eventHub = createHermesEventHub();
  const credentialStore: HermesCredentialStore = {
    hasModelCredential: vi.fn(async () => false),
    readModelCredential: vi.fn(async () => null),
    writeModelCredential: vi.fn(async () => undefined),
    deleteModelCredential: vi.fn(async () => undefined),
    publicMetadata: vi.fn(async (_ownerId, providerId) => ({ configured: false, providerId })),
  };
  const bridge: HermesBridge = {
    getStatus: vi.fn(async () => ({ readiness: "installed", version: "test", lastCheckedAt: "2026-05-15T00:00:00.000Z" })),
    saveConfig: vi.fn(async ({ config }) => ({
      patch: { hermesPathLabel: config.homeMode === "default" ? null : config.homeMode === "custom" ? redactLabel(config.hermesPath) : undefined, lastCheckedAt: "2026-05-15T00:00:00.000Z" },
      activate: vi.fn(),
    })),
    saveModelCredential: vi.fn(async ({ credential }) => ({ id: credential.providerId, configured: true, status: "healthy", availableModels: [], lastCheckedAt: "2026-05-15T00:00:00.000Z" })),
    listChannels: vi.fn(async () => []),
    runChannelAction: vi.fn(async ({ channelId, action }) => ({
      channel: { id: channelId, platform: channelId, enabled: true, configured: true, status: action.type === "start_pairing" ? "pairing" : "connected", allowedSenderPolicy: "Configured", lastCheckedAt: "2026-05-15T00:00:00.000Z", updatedAt: "2026-05-15T00:00:00.000Z" },
      pairing: action.type === "start_pairing" ? { kind: "code", displayValue: "PAIR-HERMES", expiresAt: "2026-05-15T00:05:00.000Z" } : undefined,
    })),
    listCapabilities: vi.fn(async () => []),
    runGatewayAction: vi.fn(async () => ({ id: "op_1", status: "complete", message: "Gateway action accepted", patch: { gatewayStatus: "healthy" } })),
    createSession: vi.fn(async ({ ownerId, operatorId, installation, payload }) => ({ id: "ses_1", hermesSessionId: "hermes_1", installationId: installation?.id ?? "hermes_user_123", ownerId, operatorId, profileId: payload.profileId, modelId: payload.modelId, status: "streaming", eventCount: 1, createdAt: "2026-05-15T00:00:00.000Z", updatedAt: "2026-05-15T00:00:00.000Z", lastActiveAt: "2026-05-15T00:00:00.000Z" })),
    sendPrompt: vi.fn(async ({ session }) => ({ ...session, eventCount: session.eventCount + 1 })),
    decideApproval: vi.fn(async ({ approval, operatorId, payload }) => ({ ...approval, status: payload.decision, decisionBy: operatorId, decisionAt: "2026-05-15T00:00:00.000Z" })),
    recover: vi.fn(async () => ({ status: "complete", message: "Recovery completed" })),
  };
  return {
    app: createHermesRoutes({
      repository,
      credentialStore,
      bridge,
      eventHub,
      getPrincipal: () => ({ userId, source: "dev-default" }),
    }),
    repository,
    credentialStore,
    bridge,
    eventHub,
  };
}

describe("Hermes routes", () => {
  it("saves config and returns redacted status", async () => {
    const { app, repository } = deps();

    const res = await app.request(jsonRequest("/config", "POST", {
      homeMode: "custom",
      hermesPath: "/home/deploy/hermes-agent",
      defaultProfileId: "default",
      defaultModelId: "claude-opus",
      authorizedOperators: ["user_456"],
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installation).toMatchObject({ readiness: "installed", defaultProfileId: "default" });
    expect(JSON.stringify(body)).not.toContain("/home/deploy");
    const snapshot = await repository.getSnapshot("user_123");
    expect(snapshot.events.filter((event) => event.message === "Hermes configuration updated")).toHaveLength(1);
  });

  it("rejects a Hermes path unless custom home mode is explicit", async () => {
    const { app, bridge } = deps();

    const defaultMode = await app.request(jsonRequest("/config", "POST", {
      homeMode: "default",
      hermesPath: "/home/deploy/hermes-agent",
      defaultProfileId: "default",
      authorizedOperators: [],
    }));
    const omittedMode = await app.request(jsonRequest("/config", "POST", {
      hermesPath: "/home/deploy/hermes-agent",
      defaultProfileId: "default",
      authorizedOperators: [],
    }));

    expect(defaultMode.status).toBe(400);
    expect(omittedMode.status).toBe(400);
    await expect(defaultMode.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
    await expect(omittedMode.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
    expect(bridge.saveConfig).not.toHaveBeenCalled();
  });

  it("activates bridge config only after the repository save succeeds", async () => {
    const { app, bridge, repository } = deps();
    const order: string[] = [];
    const activate = vi.fn(() => order.push("activate"));
    const saveConfig = repository.saveConfig.bind(repository);
    vi.mocked(bridge.saveConfig).mockResolvedValueOnce({
      patch: { hermesPathLabel: "custom" },
      activate,
    });
    vi.spyOn(repository, "saveConfig").mockImplementationOnce(async (...args) => {
      order.push("repository");
      return await saveConfig(...args);
    });

    const res = await app.request(jsonRequest("/config", "POST", {
      homeMode: "default",
      defaultProfileId: "default",
      authorizedOperators: [],
    }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ installation: { hermesPathLabel: "custom" } });
    expect(order).toEqual(["repository", "activate"]);
  });

  it("preserves homeMode, defaultProfileId, and defaultModelId when partial config updates omit them", async () => {
    const { app, repository } = deps();
    await app.request(jsonRequest("/config", "POST", {
      homeMode: "custom",
      hermesPath: "/home/deploy/hermes-agent",
      defaultProfileId: "ops",
      defaultModelId: "claude-opus",
      authorizedOperators: ["user_456"],
    }));

    const res = await app.request(jsonRequest("/config", "POST", {
      authorizedOperators: ["user_789"],
    }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      installation: {
        authorizedOperators: ["user_789"],
        defaultModelId: "claude-opus",
        defaultProfileId: "ops",
        homeMode: "custom",
      },
    });
    await expect(repository.getSnapshot("user_123")).resolves.toMatchObject({
      installation: { authorizedOperators: ["user_789"], defaultModelId: "claude-opus", defaultProfileId: "ops", homeMode: "custom" },
    });
  });

  it("allows owners to explicitly clear authorized operators", async () => {
    const { app } = deps();
    await app.request(jsonRequest("/config", "POST", {
      homeMode: "default",
      defaultProfileId: "default",
      authorizedOperators: ["user_456"],
    }));

    const res = await app.request(jsonRequest("/config", "POST", {
      homeMode: "default",
      defaultProfileId: "default",
      authorizedOperators: [],
    }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ installation: { authorizedOperators: [] } });
  });

  it("clears the custom Hermes path label when switching back to default mode", async () => {
    const { app } = deps();
    await app.request(jsonRequest("/config", "POST", {
      homeMode: "custom",
      hermesPath: "/home/deploy/hermes-agent",
      defaultProfileId: "default",
      authorizedOperators: [],
    }));

    const res = await app.request(jsonRequest("/config", "POST", {
      homeMode: "default",
    }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ installation: { homeMode: "default", hermesPathLabel: null } });
  });

  it("does not activate bridge config when the repository save fails", async () => {
    const { app, bridge, repository } = deps();
    const activate = vi.fn();
    vi.mocked(bridge.saveConfig).mockResolvedValueOnce({
      patch: { hermesPathLabel: "custom" },
      activate,
    });
    vi.spyOn(repository, "saveConfig").mockRejectedValueOnce(new Error("database unavailable"));

    const res = await app.request(jsonRequest("/config", "POST", {
      homeMode: "default",
      defaultProfileId: "default",
      authorizedOperators: [],
    }));

    expect(res.status).toBe(500);
    expect(activate).not.toHaveBeenCalled();
  });

  it("truncates custom Hermes path labels consistently", async () => {
    const { app } = deps();
    const longName = "x".repeat(120);

    const res = await app.request(jsonRequest("/config", "POST", {
      homeMode: "custom",
      hermesPath: `/home/deploy/${longName}`,
      defaultProfileId: "default",
      authorizedOperators: [],
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installation.hermesPathLabel).toBe("x".repeat(80));
  });

  it("does not overwrite a gateway action health result with an unqueried status patch", async () => {
    const { app, bridge } = deps();
    await app.request(jsonRequest("/config", "POST", { homeMode: "default", defaultProfileId: "default", authorizedOperators: [] }));
    vi.mocked(bridge.runGatewayAction).mockResolvedValueOnce({
      id: "op_1",
      status: "complete",
      message: "Gateway action accepted",
      patch: { gatewayStatus: "healthy", readiness: "ready" },
    });
    vi.mocked(bridge.getStatus).mockResolvedValueOnce({
      readiness: "installed",
      lastCheckedAt: "2026-05-15T00:02:00.000Z",
    });

    const action = await app.request(jsonRequest("/gateway/action", "POST", { type: "health_check" }));
    const status = await app.request("/status");

    expect(action.status).toBe(200);
    expect(await status.json()).toMatchObject({ readiness: "ready", gatewayStatus: "healthy", lastCheckedAt: "2026-05-15T00:02:00.000Z" });
  });

  it("does not persist status polls when only lastCheckedAt changes", async () => {
    const { app, bridge, repository } = deps();
    await app.request(jsonRequest("/config", "POST", { homeMode: "default", defaultProfileId: "default", authorizedOperators: [] }));
    const applyInstallationPatch = vi.spyOn(repository, "applyInstallationPatch");
    vi.mocked(bridge.getStatus).mockResolvedValueOnce({ lastCheckedAt: "2026-05-15T00:02:00.000Z" });

    const res = await app.request("/status");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lastCheckedAt: "2026-05-15T00:02:00.000Z" });
    expect(applyInstallationPatch).not.toHaveBeenCalled();
  });

  it("does not clear a stored version when a status poll cannot read the CLI version", async () => {
    const { app, bridge, repository } = deps();
    await app.request(jsonRequest("/config", "POST", { homeMode: "default", defaultProfileId: "default", authorizedOperators: [] }));
    await repository.applyInstallationPatch("user_123", { version: "1.2.3" });
    const applyInstallationPatch = vi.spyOn(repository, "applyInstallationPatch");
    vi.mocked(bridge.getStatus).mockResolvedValueOnce({ version: null, lastCheckedAt: "2026-05-15T00:02:00.000Z" });

    const res = await app.request("/status");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: null, lastCheckedAt: "2026-05-15T00:02:00.000Z" });
    expect(applyInstallationPatch).not.toHaveBeenCalled();
    await expect(repository.getSnapshot("user_123")).resolves.toMatchObject({
      installation: { version: "1.2.3" },
    });
  });

  it("persists a newly discovered non-null version from status polls", async () => {
    const { app, bridge, repository } = deps();
    await app.request(jsonRequest("/config", "POST", { homeMode: "default", defaultProfileId: "default", authorizedOperators: [] }));
    vi.mocked(bridge.getStatus).mockResolvedValueOnce({ version: "1.2.4", lastCheckedAt: "2026-05-15T00:02:00.000Z" });

    const res = await app.request("/status");

    expect(res.status).toBe(200);
    await expect(repository.getSnapshot("user_123")).resolves.toMatchObject({
      installation: { version: "1.2.4" },
    });
  });

  it("stores model credentials server-side and returns only presence", async () => {
    const { app, credentialStore, repository } = deps();

    const res = await app.request(jsonRequest("/credentials/model", "POST", { providerId: "anthropic", secret: "model_secret" }));

    expect(res.status).toBe(200);
    expect(credentialStore.writeModelCredential).toHaveBeenCalledWith("user_123", "anthropic", "model_secret");
    expect(await res.json()).toEqual({ configured: true, providerId: "anthropic", status: "healthy" });
    const snapshot = await repository.getSnapshot("user_123");
    expect(snapshot.events.filter((event) => event.message === "Model credential updated")).toHaveLength(1);
  });

  it("rejects concurrent model credential writes for the same provider", async () => {
    const { app, bridge } = deps();
    let releaseCredential: (() => void) | null = null;
    vi.mocked(bridge.saveModelCredential).mockImplementationOnce(async ({ credential }) => {
      await new Promise<void>((resolve) => {
        releaseCredential = resolve;
      });
      return { id: credential.providerId, configured: true, status: "healthy", availableModels: [], lastCheckedAt: "2026-05-15T00:00:00.000Z" };
    });

    const first = app.request(jsonRequest("/credentials/model", "POST", { providerId: "anthropic", secret: "model_secret_1" }));
    await vi.waitFor(() => expect(bridge.saveModelCredential).toHaveBeenCalledOnce());
    const second = await app.request(jsonRequest("/credentials/model", "POST", { providerId: "anthropic", secret: "model_secret_2" }));
    releaseCredential?.();
    const firstResponse = await first;

    expect(second.status).toBe(409);
    expect(firstResponse.status).toBe(200);
  });

  it("persists bridge-validated model provider metadata", async () => {
    const { app, bridge, repository } = deps();
    vi.mocked(bridge.saveModelCredential).mockResolvedValueOnce({
      id: "anthropic",
      configured: true,
      status: "validating",
      defaultModelId: "claude-opus",
      availableModels: [{ id: "claude-opus", label: "Claude Opus" }],
      lastCheckedAt: "2026-05-15T00:01:00.000Z",
    });

    const res = await app.request(jsonRequest("/credentials/model", "POST", { providerId: "anthropic", secret: "model_secret" }));

    expect(await res.json()).toEqual({ configured: true, providerId: "anthropic", status: "validating" });
    const snapshot = await repository.getSnapshot("user_123");
    expect(snapshot.modelProviders[0]).toMatchObject({
      id: "anthropic",
      status: "validating",
      defaultModelId: "claude-opus",
      availableModels: [{ id: "claude-opus", label: "Claude Opus" }],
    });
  });

  it("does not persist model credential files when bridge validation fails", async () => {
    const { app, bridge, credentialStore, repository } = deps();
    vi.mocked(bridge.saveModelCredential).mockRejectedValueOnce(new Error("bridge unavailable"));

    const res = await app.request(jsonRequest("/credentials/model", "POST", { providerId: "anthropic", secret: "model_secret" }));

    expect(res.status).toBe(500);
    expect(credentialStore.writeModelCredential).not.toHaveBeenCalled();
    await expect(repository.getSnapshot("user_123")).resolves.toMatchObject({ modelProviders: [] });
  });

  it("caps retained model provider metadata", async () => {
    const { app, repository } = deps();

    for (let index = 0; index < MAX_HERMES_MODEL_PROVIDERS + 5; index += 1) {
      const res = await app.request(jsonRequest("/credentials/model", "POST", { providerId: `provider${index}`, secret: "model_secret" }));
      expect(res.status).toBe(200);
    }

    const snapshot = await repository.getSnapshot("user_123");
    expect(snapshot.modelProviders).toHaveLength(MAX_HERMES_MODEL_PROVIDERS);
    expect(snapshot.modelProviders.map((provider) => provider.id)).not.toContain("provider0");
  });

  it("caps retained approval prompts independently from sessions", async () => {
    const { repository } = deps();

    for (let index = 0; index < MAX_HERMES_APPROVALS + 5; index += 1) {
      await repository.upsertApproval("user_123", {
        id: `approval${index}`,
        hermesApprovalId: `hermesApproval${index}`,
        sessionId: "session_1",
        status: "pending",
        description: "Approve tool",
        decisionBy: null,
        decisionAt: null,
        createdAt: "2026-05-15T00:00:00.000Z",
      });
    }

    const snapshot = await repository.getSnapshot("user_123");
    expect(snapshot.approvals).toHaveLength(MAX_HERMES_APPROVALS);
    expect(snapshot.approvals.map((approval) => approval.id)).not.toContain("approval0");
  });

  it("returns bridge-discovered capabilities on GET without persisting a read snapshot", async () => {
    const { app, bridge, repository } = deps();
    vi.mocked(bridge.listCapabilities).mockResolvedValueOnce([
      {
        id: "gateway",
        kind: "gateway",
        name: "Messaging gateway",
        enabled: true,
        status: "available",
        description: "Hermes messaging gateway",
        updatedAt: "2026-05-15T00:00:00.000Z",
      },
    ]);

    const res = await app.request("/capabilities");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ capabilities: [{ id: "gateway" }] });
    await expect(repository.getSnapshot("user_123")).resolves.toMatchObject({ capabilities: [] });
  });

  it("merges live capabilities with stored capabilities on GET", async () => {
    const { app, bridge, repository } = deps();
    const snapshot = await repository.getSnapshot("user_123");
    await repository.replaceSnapshot("user_123", {
      ...snapshot,
      capabilities: [
        {
          id: "memory",
          kind: "tool",
          name: "Memory",
          enabled: true,
          status: "available",
          updatedAt: "2026-05-15T00:00:00.000Z",
        },
      ],
    });
    vi.mocked(bridge.listCapabilities).mockResolvedValueOnce([
      {
        id: "gateway",
        kind: "gateway",
        name: "Messaging gateway",
        enabled: true,
        status: "available",
        updatedAt: "2026-05-15T00:01:00.000Z",
      },
    ]);

    const res = await app.request("/capabilities");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ capabilities: [{ id: "gateway" }, { id: "memory" }] });
  });

  it("returns bridge-discovered channels on GET without persisting a read snapshot", async () => {
    const { app, bridge, repository } = deps();
    vi.mocked(bridge.listChannels).mockResolvedValueOnce([
      {
        id: "telegram",
        platform: "telegram",
        enabled: true,
        configured: true,
        status: "connected",
        allowedSenderPolicy: "Configured",
        lastCheckedAt: "2026-05-15T00:00:00.000Z",
        updatedAt: "2026-05-15T00:00:00.000Z",
      },
    ]);

    const res = await app.request("/channels");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ channels: [{ id: "telegram", status: "connected" }] });
    await expect(repository.getSnapshot("user_123")).resolves.toMatchObject({ channels: [] });
  });

  it("does not let channel reads revert stored channel action state", async () => {
    const { app, bridge, repository } = deps();
    await repository.upsertChannel("user_123", {
      id: "telegram",
      platform: "telegram",
      enabled: true,
      configured: true,
      status: "connected",
      allowedSenderPolicy: "Configured",
      lastCheckedAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:00.000Z",
    });
    vi.mocked(bridge.listChannels).mockResolvedValueOnce([
      {
        id: "telegram",
        platform: "telegram",
        enabled: false,
        configured: false,
        status: "disconnected",
        allowedSenderPolicy: "Not configured",
        lastCheckedAt: "2026-05-15T00:01:00.000Z",
        updatedAt: "2026-05-15T00:01:00.000Z",
      },
    ]);

    const res = await app.request("/channels");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ channels: [{ id: "telegram", status: "connected", enabled: true, configured: true }] });
    await expect(repository.getSnapshot("user_123")).resolves.toMatchObject({ channels: [{ id: "telegram", status: "connected", enabled: true, configured: true }] });
  });

  it("passes a freshly loaded installation to channel actions", async () => {
    const { app, repository, bridge } = deps();
    await app.request(jsonRequest("/config", "POST", { homeMode: "default", defaultProfileId: "default", defaultModelId: "before", authorizedOperators: [] }));
    const getSnapshot = repository.getSnapshot.bind(repository);
    vi.spyOn(repository, "getSnapshot").mockImplementationOnce(async (...args) => {
      const snapshot = await getSnapshot(...args);
      if (snapshot.installation) {
        await repository.saveConfig("user_123", { homeMode: "default", defaultProfileId: "default", defaultModelId: "after", authorizedOperators: [] }, "user_123");
      }
      return snapshot;
    });

    const res = await app.request(jsonRequest("/channels/telegram/action", "POST", { type: "connect", payload: { token: "bot_secret" } }));

    expect(res.status).toBe(200);
    expect(bridge.runChannelAction).toHaveBeenCalledWith(expect.objectContaining({
      installation: expect.objectContaining({ defaultModelId: "after" }),
    }));
  });

  it("performs Telegram and WhatsApp channel actions without leaking payload secrets", async () => {
    const { app } = deps();
    await app.request(jsonRequest("/config", "POST", { homeMode: "default", defaultProfileId: "default", authorizedOperators: [] }));

    const res = await app.request(jsonRequest("/channels/telegram/action", "POST", { type: "connect", payload: { token: "bot_secret" } }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.channel).toMatchObject({ id: "telegram", status: "connected" });
    expect(JSON.stringify(body)).not.toContain("bot_secret");
  });

  it("returns WhatsApp pairing data from the bridge operation result", async () => {
    const { app, eventHub } = deps();
    await app.request(jsonRequest("/config", "POST", { homeMode: "default", defaultProfileId: "default", authorizedOperators: [] }));

    const res = await app.request(jsonRequest("/channels/whatsapp/action", "POST", { type: "start_pairing", payload: {} }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      channel: { id: "whatsapp", status: "pairing" },
      operation: { status: "complete", message: "Channel updated", pairing: { kind: "code", displayValue: "PAIR-HERMES" } },
    });
    expect(eventHub.retained("user_123")).toContainEqual(expect.objectContaining({
      type: "channel.updated",
      payload: expect.objectContaining({ id: "whatsapp", platform: "whatsapp", pairing: { kind: "code", displayValue: "PAIR-HERMES", expiresAt: "2026-05-15T00:05:00.000Z" } }),
    }));
  });

  it("preserves completed setup steps across later config saves", async () => {
    const { app, repository } = deps();
    await app.request(jsonRequest("/config", "POST", { homeMode: "default", defaultProfileId: "default", authorizedOperators: [] }));
    await app.request(jsonRequest("/credentials/model", "POST", { providerId: "anthropic", secret: "model_secret" }));
    await app.request(jsonRequest("/channels/telegram/action", "POST", { type: "connect", payload: { token: "bot_secret" } }));

    const res = await app.request(jsonRequest("/config", "POST", {
      homeMode: "default",
      defaultProfileId: "default",
      defaultModelId: "claude-opus",
      authorizedOperators: ["user_456"],
    }));

    expect(res.status).toBe(200);
    const steps = (await repository.getSnapshot("user_123")).setupSteps;
    expect(steps.find((step) => step.id === "model")).toMatchObject({ status: "complete" });
    expect(steps.find((step) => step.id === "channel")).toMatchObject({ status: "complete" });
  });

  it("creates sessions and accepts follow-up prompts", async () => {
    const { app } = deps();
    await app.request(jsonRequest("/config", "POST", { homeMode: "default", defaultProfileId: "default", authorizedOperators: [] }));

    const created = await app.request(jsonRequest("/sessions", "POST", { profileId: "default", prompt: "hello", clientRequestId: "create_1" }));
    const sessionBody = await created.json();
    const prompted = await app.request(jsonRequest(`/sessions/${sessionBody.session.id}/prompt`, "POST", { prompt: "continue", clientRequestId: "req_1" }));

    expect(created.status).toBe(200);
    expect(prompted.status).toBe(200);
    expect(await prompted.json()).toMatchObject({ session: { id: "ses_1", eventCount: 2 } });
  });

  it("uses the latest installation snapshot when sending a follow-up prompt", async () => {
    const { app, bridge, repository } = deps();
    await app.request(jsonRequest("/config", "POST", { homeMode: "default", defaultProfileId: "default", defaultModelId: "old-model", authorizedOperators: [] }));
    const created = await app.request(jsonRequest("/sessions", "POST", { profileId: "default", prompt: "hello", clientRequestId: "create_1" }));
    const sessionBody = await created.json();
    const getSession = repository.getSession.bind(repository);
    vi.spyOn(repository, "getSession").mockImplementationOnce(async (...args) => {
      const session = await getSession(...args);
      await repository.saveConfig("user_123", { homeMode: "default", defaultProfileId: "default", defaultModelId: "fresh-model", authorizedOperators: [] }, "user_123", { readiness: "ready" });
      return session;
    });
    vi.mocked(bridge.sendPrompt).mockImplementationOnce(async ({ installation, session }) => {
      expect(installation?.defaultModelId).toBe("fresh-model");
      return { ...session, eventCount: session.eventCount + 1 };
    });

    const prompted = await app.request(jsonRequest(`/sessions/${sessionBody.session.id}/prompt`, "POST", { prompt: "continue", clientRequestId: "req_fresh" }));

    expect(prompted.status).toBe(200);
  });

  it("paginates sessions with cursor instead of dropping it", async () => {
    const { app, repository } = deps();
    for (const id of ["ses_1", "ses_2", "ses_3"]) {
      await repository.upsertSession("user_123", {
        id,
        hermesSessionId: `hermes_${id}`,
        installationId: "hermes_user_123",
        ownerId: "user_123",
        operatorId: "user_123",
        profileId: "default",
        status: "idle",
        eventCount: 0,
        createdAt: "2026-05-15T00:00:00.000Z",
        updatedAt: "2026-05-15T00:00:00.000Z",
        lastActiveAt: "2026-05-15T00:00:00.000Z",
      });
    }

    const first = await app.request("/sessions?limit=2");
    const firstBody = await first.json();
    const second = await app.request(`/sessions?limit=2&cursor=${firstBody.nextCursor}`);

    expect(firstBody).toMatchObject({ sessions: [{ id: "ses_1" }, { id: "ses_2" }], nextCursor: "ses_2" });
    await expect(second.json()).resolves.toMatchObject({ sessions: [{ id: "ses_3" }], nextCursor: null });
  });

  it("rejects filtered-out session cursors instead of silently restarting pagination", async () => {
    const { app, repository } = deps();
    for (const [id, status] of [["ses_1", "streaming"], ["ses_2", "streaming"]] as const) {
      await repository.upsertSession("user_123", {
        id,
        hermesSessionId: `hermes_${id}`,
        installationId: "hermes_user_123",
        ownerId: "user_123",
        operatorId: "user_123",
        profileId: "default",
        status,
        eventCount: 0,
        createdAt: "2026-05-15T00:00:00.000Z",
        updatedAt: "2026-05-15T00:00:00.000Z",
        lastActiveAt: "2026-05-15T00:00:00.000Z",
      });
    }
    const first = await app.request("/sessions?status=streaming&limit=1");
    const firstBody = await first.json();
    const existing = await repository.getSession("user_123", "ses_1");
    if (!existing) throw new Error("missing test session");
    await repository.upsertSession("user_123", { ...existing, status: "stopped" });

    const second = await app.request(`/sessions?status=streaming&limit=1&cursor=${firstBody.nextCursor}`);

    expect(second.status).toBe(400);
    await expect(second.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
  });

  it("rejects concurrent recovery actions for the same owner", async () => {
    const { app, bridge } = deps();
    let releaseRecovery: (() => void) | null = null;
    vi.mocked(bridge.recover).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      return { status: "complete", message: "Recovery completed" };
    });

    const first = app.request(jsonRequest("/recover", "POST", {}));
    await vi.waitFor(() => expect(bridge.recover).toHaveBeenCalledOnce());
    const second = await app.request(jsonRequest("/recover", "POST", {}));
    releaseRecovery?.();
    const firstResponse = await first;

    expect(second.status).toBe(409);
    expect(firstResponse.status).toBe(200);
  });

  it("passes a freshly loaded installation to recovery actions", async () => {
    const { app, repository, bridge } = deps();
    await app.request(jsonRequest("/config", "POST", { homeMode: "default", defaultProfileId: "default", defaultModelId: "before", authorizedOperators: [] }));
    const getSnapshot = repository.getSnapshot.bind(repository);
    vi.spyOn(repository, "getSnapshot").mockImplementationOnce(async (...args) => {
      const snapshot = await getSnapshot(...args);
      if (snapshot.installation) {
        await repository.saveConfig("user_123", { homeMode: "default", defaultProfileId: "default", defaultModelId: "after", authorizedOperators: [] }, "user_123");
      }
      return snapshot;
    });

    const res = await app.request(jsonRequest("/recover", "POST", {}));

    expect(res.status).toBe(200);
    expect(bridge.recover).toHaveBeenCalledWith(expect.objectContaining({
      installation: expect.objectContaining({ defaultModelId: "after" }),
    }));
  });

  it("rejects recovery requests from delegated operators", async () => {
    const owner = deps("user_123");
    await owner.app.request(jsonRequest("/config", "POST", { homeMode: "default", defaultProfileId: "default", authorizedOperators: ["user_456"] }));
    const operator = createHermesRoutes({
      repository: owner.repository,
      credentialStore: owner.credentialStore,
      bridge: owner.bridge,
      eventHub: createHermesEventHub(),
      getPrincipal: () => ({ userId: "user_456", source: "dev-default" }),
    });

    const res = await operator.request(jsonRequest("/recover?ownerId=user_123", "POST", {}));

    expect(res.status).toBe(401);
    expect(owner.bridge.recover).not.toHaveBeenCalled();
  });

  it("rejects concurrent gateway actions for the same owner", async () => {
    const { app, bridge } = deps();
    let releaseGatewayAction: (() => void) | null = null;
    vi.mocked(bridge.runGatewayAction).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseGatewayAction = resolve;
      });
      return { id: "op_1", status: "complete", message: "Gateway action accepted", patch: { gatewayStatus: "healthy" } };
    });

    const first = app.request(jsonRequest("/gateway/action", "POST", { type: "restart" }));
    await vi.waitFor(() => expect(bridge.runGatewayAction).toHaveBeenCalledOnce());
    const second = await app.request(jsonRequest("/gateway/action", "POST", { type: "health_check" }));
    releaseGatewayAction?.();
    const firstResponse = await first;

    expect(second.status).toBe(409);
    expect(firstResponse.status).toBe(200);
  });

  it("expires stale action locks after the operation deadline", async () => {
    const { app, bridge } = deps();
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    let releaseFirst: (() => void) | null = null;
    vi.mocked(bridge.runGatewayAction)
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return { id: "op_1", status: "complete", message: "Gateway action accepted", patch: { gatewayStatus: "healthy" } };
      });

    try {
      const first = app.request(jsonRequest("/gateway/action", "POST", { type: "restart" }));
      await vi.waitFor(() => expect(bridge.runGatewayAction).toHaveBeenCalledOnce());
      now.mockReturnValue(60_001);
      const second = await app.request(jsonRequest("/gateway/action", "POST", { type: "restart" }));

      expect(second.status).toBe(200);
      expect(bridge.runGatewayAction).toHaveBeenCalledTimes(2);
      releaseFirst?.();
      expect((await first).status).toBe(200);
    } finally {
      now.mockRestore();
      releaseFirst?.();
    }
  });

  it("keeps channel persistence inside the duplicate action lock", async () => {
    const { app, repository } = deps();
    const upsertChannel = repository.upsertChannel.bind(repository);
    let releaseUpsert: (() => void) | null = null;
    vi.spyOn(repository, "upsertChannel").mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        releaseUpsert = resolve;
      });
      return await upsertChannel(...args);
    });

    const first = app.request(jsonRequest("/channels/telegram/action", "POST", { type: "connect", payload: { token: "bot_secret" } }));
    await vi.waitFor(() => expect(repository.upsertChannel).toHaveBeenCalledOnce());
    const second = await app.request(jsonRequest("/channels/telegram/action", "POST", { type: "verify" }));
    releaseUpsert?.();
    const firstResponse = await first;

    expect(second.status).toBe(409);
    expect(firstResponse.status).toBe(200);
  });

  it("keeps approval status guard and persistence inside the approval lock", async () => {
    const { app, repository, bridge } = deps();
    await repository.upsertApproval("user_123", {
      id: "approval_1",
      hermesApprovalId: "hermes_approval_1",
      sessionId: "session_1",
      status: "pending",
      description: "Approve tool",
      decisionBy: null,
      decisionAt: null,
      createdAt: "2026-05-15T00:00:00.000Z",
    });
    const upsertApproval = repository.upsertApproval.bind(repository);
    let releaseUpsert: (() => void) | null = null;
    vi.spyOn(repository, "upsertApproval").mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        releaseUpsert = resolve;
      });
      return await upsertApproval(...args);
    });

    const first = app.request(jsonRequest("/approvals/approval_1/decision", "POST", { decision: "approved" }));
    await vi.waitFor(() => expect(bridge.decideApproval).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(repository.upsertApproval).toHaveBeenCalledOnce());
    const second = await app.request(jsonRequest("/approvals/approval_1/decision", "POST", { decision: "denied" }));
    releaseUpsert?.();
    const firstResponse = await first;

    expect(second.status).toBe(409);
    expect(firstResponse.status).toBe(200);
  });

  it("rejects unauthorized delegated owner reads without details", async () => {
    const owner = deps("user_123");
    await owner.app.request(jsonRequest("/config", "POST", { homeMode: "default", defaultProfileId: "default", authorizedOperators: [] }));
    const attacker = createHermesRoutes({
      repository: owner.repository,
      credentialStore: owner.credentialStore,
      bridge: owner.bridge,
      eventHub: createHermesEventHub(),
      getPrincipal: () => ({ userId: "user_999", source: "dev-default" }),
    });

    const res = await attacker.request("/config?ownerId=user_123");

    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("defaultProfileId");
  });

  it("resolves shared operators deterministically to the most recently updated owner", async () => {
    const repository = new InMemoryHermesRepository();
    await repository.saveConfig("owner_old", { homeMode: "default", defaultProfileId: "default", authorizedOperators: ["operator_1"] }, "owner_old");
    await repository.saveConfig("owner_new", { homeMode: "default", defaultProfileId: "default", authorizedOperators: ["operator_1"] }, "owner_new");
    const oldSnapshot = await repository.getSnapshot("owner_old");
    const newSnapshot = await repository.getSnapshot("owner_new");
    await repository.replaceSnapshot("owner_old", {
      ...oldSnapshot,
      installation: oldSnapshot.installation ? { ...oldSnapshot.installation, updatedAt: "2026-05-15T00:00:00.000Z" } : null,
    });
    await repository.replaceSnapshot("owner_new", {
      ...newSnapshot,
      installation: newSnapshot.installation ? { ...newSnapshot.installation, updatedAt: "2026-05-15T00:01:00.000Z" } : null,
    });

    await expect(repository.resolveOwnerIdForOperator("operator_1")).resolves.toBe("owner_new");
  });
});
