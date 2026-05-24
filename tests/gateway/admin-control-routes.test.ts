import { describe, expect, it } from "vitest";
import { createAdminControlRoutes } from "../../packages/gateway/src/onboarding/admin-control-routes.js";
import { createAdminControlService } from "../../packages/gateway/src/onboarding/admin-control-service.js";
import { createAgentCredentialStatusService } from "../../packages/gateway/src/onboarding/agent-credential-status.js";
import { createIntegrationCapabilityService } from "../../packages/gateway/src/onboarding/integration-capabilities.js";
import { createTestReadinessService, testPrincipal } from "../helpers/activation-readiness.js";

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("admin control routes", () => {
  it("returns provider cards, setup state, settings, automations, activity, and readiness safely", async () => {
    const agentCredentials = createAgentCredentialStatusService();
    const integrations = createIntegrationCapabilityService({ connectedCapabilityIds: ["calendar.create_event"] });
    await integrations.setApproval(testPrincipal.userId, "calendar.create_event", "hermes", true);
    const { service: readiness } = createTestReadinessService(undefined, { agentCredentialService: agentCredentials, integrationCapabilityService: integrations });
    const service = createAdminControlService({ agentCredentials, integrations, readiness });
    const app = createAdminControlRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request("/control-surface");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sections).toEqual(["models", "agents", "integrations", "settings", "automations", "activity", "readiness"]);
    expect(body.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "hermes", label: "Hermes", status: "available", mode: "matrix_system_agent" }),
      expect.objectContaining({ id: "claude", label: "Claude", mode: "bring_your_own" }),
      expect.objectContaining({ id: "codex", label: "Codex", mode: "bring_your_own" }),
    ]));
    expect(body.integrationSummary).toMatchObject({ approved: 1 });
    expect(body.automationSummary).toEqual(expect.objectContaining({ active: 0, needsApproval: 0, lastActivityAt: null }));
    expect(JSON.stringify(body)).not.toMatch(/secret|token|postgres|\/home\//i);
  });

  it("labels non-GitHub integration providers by their actual provider", async () => {
    const agentCredentials = createAgentCredentialStatusService();
    const integrations = {
      listCapabilities: async () => ({
        capabilities: [{
          id: "messaging.post_message",
          provider: "messaging" as const,
          capability: "post_message",
          status: "connected" as const,
          approvedAgents: [],
          requiresApprovalPerAction: true,
        }],
      }),
      getCapabilityApproval: async () => ({
        capabilityId: "messaging.post_message",
        approvedAgents: [],
      }),
      setApproval: async () => ({
        capabilityId: "messaging.post_message",
        agent: "hermes" as const,
        status: "connected" as const,
      }),
    };
    const { service: readiness } = createTestReadinessService(undefined, { agentCredentialService: agentCredentials });
    const service = createAdminControlService({ agentCredentials, integrations, readiness });
    const app = createAdminControlRoutes({ service, getPrincipal: () => testPrincipal });

    const body = await (await app.request("/control-surface")).json();

    expect(body.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "messaging.post_message", label: "Messaging", mode: "integration" }),
    ]));
    expect(body.providers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "messaging.post_message", label: "GitHub" }),
    ]));
  });

  it("does not require integration approval review when no integrations are available", async () => {
    const agentCredentials = createAgentCredentialStatusService();
    const integrations = {
      listCapabilities: async () => ({ capabilities: [] }),
      getCapabilityApproval: async () => null,
      setApproval: async () => ({
        capabilityId: "calendar.create_event",
        agent: "hermes" as const,
        status: "unavailable" as const,
      }),
    };
    const { service: readiness } = createTestReadinessService(undefined, { agentCredentialService: agentCredentials });
    const service = createAdminControlService({ agentCredentials, integrations, readiness });
    const app = createAdminControlRoutes({ service, getPrincipal: () => testPrincipal });

    const body = await (await app.request("/control-surface")).json();

    expect(body.settings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "integration-approvals", status: "saved" }),
    ]));
  });

  it("keeps integration approvals in review when connected capabilities are only partially approved", async () => {
    const agentCredentials = createAgentCredentialStatusService();
    const integrations = createIntegrationCapabilityService({
      connectedCapabilityIds: ["calendar.create_event", "email.read_email"],
    });
    await integrations.setApproval(testPrincipal.userId, "calendar.create_event", "hermes", true);
    const { service: readiness } = createTestReadinessService(undefined, { agentCredentialService: agentCredentials, integrationCapabilityService: integrations });
    const service = createAdminControlService({ agentCredentials, integrations, readiness });
    const app = createAdminControlRoutes({ service, getPrincipal: () => testPrincipal });

    const body = await (await app.request("/control-surface")).json();

    expect(body.integrationSummary).toMatchObject({ connected: 2, approved: 1 });
    expect(body.settings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "integration-approvals", status: "needs_review" }),
    ]));
  });

  it("creates and resumes setup wizard sessions without duplicate destructive work", async () => {
    const agentCredentials = createAgentCredentialStatusService({ now: () => new Date("2026-05-23T00:00:00.000Z") });
    const integrations = createIntegrationCapabilityService();
    const { service: readiness } = createTestReadinessService(undefined, { agentCredentialService: agentCredentials, integrationCapabilityService: integrations });
    const service = createAdminControlService({ agentCredentials, integrations, readiness, now: () => new Date("2026-05-23T00:00:00.000Z") });
    const app = createAdminControlRoutes({ service, getPrincipal: () => testPrincipal });

    const created = await app.request(post("/control-surface/setup-session", {
      target: "agent:claude",
      intent: "connect",
    }));
    const resumed = await app.request(post("/control-surface/setup-session", {
      target: "agent:claude",
      intent: "connect",
    }));

    expect(created.status).toBe(200);
    expect(resumed.status).toBe(200);
    const first = await created.json();
    const second = await resumed.json();
    expect(second.session.id).toBe(first.session.id);
    expect(second.session.status).toBe("resumable");
  });

  it("starts a fresh setup session when the operator asks to configure", async () => {
    let current = Date.parse("2026-05-23T00:00:00.000Z");
    const agentCredentials = createAgentCredentialStatusService();
    const integrations = createIntegrationCapabilityService();
    const { service: readiness } = createTestReadinessService(undefined, { agentCredentialService: agentCredentials, integrationCapabilityService: integrations });
    const service = createAdminControlService({
      agentCredentials,
      integrations,
      readiness,
      now: () => new Date(current),
    });
    const app = createAdminControlRoutes({ service, getPrincipal: () => testPrincipal });

    await app.request(post("/control-surface/setup-session", { target: "setting:general", intent: "connect" }));
    current += 1000;
    const configured = await app.request(post("/control-surface/setup-session", { target: "setting:general", intent: "configure" }));

    expect(configured.status).toBe(200);
    await expect(configured.json()).resolves.toMatchObject({
      session: expect.objectContaining({ status: "new", updatedAt: "2026-05-23T00:00:01.000Z" }),
    });
  });

  it("accepts the documented section/resume setup session payload", async () => {
    const agentCredentials = createAgentCredentialStatusService();
    const integrations = createIntegrationCapabilityService();
    const { service: readiness } = createTestReadinessService(undefined, { agentCredentialService: agentCredentials, integrationCapabilityService: integrations });
    const service = createAdminControlService({ agentCredentials, integrations, readiness });
    const app = createAdminControlRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request(post("/control-surface/setup-session", {
      section: "models",
      resume: true,
    }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      session: expect.objectContaining({ target: "agent:claude" }),
      sessionId: expect.stringContaining("setup."),
      currentStepId: "agent:claude",
    });
  });

  it("maps integration section setup to a generic integration target", async () => {
    const agentCredentials = createAgentCredentialStatusService();
    const integrations = createIntegrationCapabilityService();
    const { service: readiness } = createTestReadinessService(undefined, { agentCredentialService: agentCredentials, integrationCapabilityService: integrations });
    const service = createAdminControlService({ agentCredentials, integrations, readiness });
    const app = createAdminControlRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request(post("/control-surface/setup-session", {
      section: "integrations",
      resume: true,
    }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      session: expect.objectContaining({ target: "integration:default" }),
      currentStepId: "integration:default",
    });
  });

  it("returns the most recently resumed setup session on the control surface", async () => {
    let current = Date.parse("2026-05-23T00:00:00.000Z");
    const agentCredentials = createAgentCredentialStatusService();
    const integrations = createIntegrationCapabilityService();
    const { service: readiness } = createTestReadinessService(undefined, { agentCredentialService: agentCredentials, integrationCapabilityService: integrations });
    const service = createAdminControlService({
      agentCredentials,
      integrations,
      readiness,
      now: () => new Date(current),
    });
    const app = createAdminControlRoutes({ service, getPrincipal: () => testPrincipal });

    await app.request(post("/control-surface/setup-session", { target: "agent:claude", intent: "connect" }));
    current += 1000;
    await app.request(post("/control-surface/setup-session", { target: "agent:codex", intent: "connect" }));

    const body = await (await app.request("/control-surface")).json();

    expect(body.setupSession).toMatchObject({ target: "agent:codex" });
  });

  it("does not leak setup sessions between owner id prefixes", async () => {
    const agentCredentials = createAgentCredentialStatusService();
    const integrations = createIntegrationCapabilityService();
    const { service: readiness } = createTestReadinessService(undefined, { agentCredentialService: agentCredentials, integrationCapabilityService: integrations });
    const service = createAdminControlService({ agentCredentials, integrations, readiness });

    await service.createOrResumeSetupSession("owner:one:extra", { target: "agent:codex", intent: "connect" });
    const surface = await service.getSurface("owner:one");

    expect(surface.setupSession).toBeNull();
  });

  it("rejects invalid setup targets with a generic client-safe error", async () => {
    const agentCredentials = createAgentCredentialStatusService();
    const integrations = createIntegrationCapabilityService();
    const { service: readiness } = createTestReadinessService(undefined, { agentCredentialService: agentCredentials, integrationCapabilityService: integrations });
    const service = createAdminControlService({ agentCredentials, integrations, readiness });
    const app = createAdminControlRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request(post("/control-surface/setup-session", {
      target: "../../secret",
      intent: "connect",
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_request",
      message: "Request is invalid",
      retryable: false,
    });
  });
});
