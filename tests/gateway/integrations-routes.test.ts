import { describe, expect, it } from "vitest";
import { createAgentActionAuditService } from "../../packages/gateway/src/onboarding/agent-action-audit.js";
import { createIntegrationCapabilityRoutes } from "../../packages/gateway/src/onboarding/integration-capability-routes.js";
import {
  capabilityIdsForConnectedServices,
  createIntegrationCapabilityService,
} from "../../packages/gateway/src/onboarding/integration-capabilities.js";
import { testPrincipal } from "../helpers/activation-readiness.js";

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("integration capability routes", () => {
  it("maps connected integration services to assistant capabilities", () => {
    expect(capabilityIdsForConnectedServices(["google_calendar", "gmail", "github", "linear"])).toEqual([
      "calendar.create_event",
      "email.read_email",
      "github.read_repository",
    ]);
  });

  it("lists launch capabilities without provider secrets", async () => {
    const service = createIntegrationCapabilityService();
    const app = createIntegrationCapabilityRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request("/capabilities");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "calendar.create_event", provider: "calendar", capability: "create_calendar_event" }),
      expect.objectContaining({ id: "email.read_email", provider: "email", capability: "read_email" }),
      expect.objectContaining({ id: "github.read_repository", provider: "github", capability: "read_repository" }),
    ]));
    expect(JSON.stringify(body)).not.toMatch(/secret|token|pipedream|\/home\//i);
  });

  it("approves and revokes Hermes capability use", async () => {
    const service = createIntegrationCapabilityService({
      connectedCapabilityIds: ["calendar.create_event"],
    });
    const app = createIntegrationCapabilityRoutes({ service, getPrincipal: () => testPrincipal });

    const approved = await app.request(post("/capabilities/calendar.create_event/approval", {
      agent: "hermes",
      approved: true,
    }));

    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toEqual({
      capabilityId: "calendar.create_event",
      agent: "hermes",
      status: "approved",
    });
    const body = await (await app.request("/capabilities")).json();
    expect(body.capabilities.find((capability: { id: string }) => capability.id === "calendar.create_event")).toMatchObject({
      status: "approved",
      approvedAgents: ["hermes"],
      requiresApprovalPerAction: true,
    });
  });

  it("uses owner-scoped connected integrations before approval", async () => {
    const service = createIntegrationCapabilityService({
      getConnectedCapabilityIds: async (ownerId) => ownerId === testPrincipal.userId
        ? capabilityIdsForConnectedServices(["google_calendar"])
        : [],
    });
    const app = createIntegrationCapabilityRoutes({ service, getPrincipal: () => testPrincipal });

    const listed = await app.request("/capabilities");
    const body = await listed.json();
    expect(body.capabilities.find((capability: { id: string }) => capability.id === "calendar.create_event")).toMatchObject({
      status: "connected",
      approvedAgents: [],
    });

    const approved = await app.request(post("/capabilities/calendar.create_event/approval", {
      agent: "hermes",
      approved: true,
    }));
    expect(approved.status).toBe(200);
  });

  it("requires a connected integration before approving capability use", async () => {
    const service = createIntegrationCapabilityService();
    const app = createIntegrationCapabilityRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request(post("/capabilities/calendar.create_event/approval", {
      agent: "hermes",
      approved: true,
    }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "capability_not_connected",
      message: "Connect the integration before approving agent access",
      retryable: false,
    });
  });

  it("does not overwrite stored approvals when the persisted file is unreadable", async () => {
    const home = await mkdtemp(join(tmpdir(), "matrix-capabilities-"));
    const storagePath = join(home, "system", "integration-capabilities.json");
    await mkdir(join(home, "system"), { recursive: true });
    await writeFile(storagePath, "{not-json", "utf8");
    const service = createIntegrationCapabilityService({
      connectedCapabilityIds: ["calendar.create_event"],
      storagePath,
    });

    await expect(
      service.setApproval(testPrincipal.userId, "calendar.create_event", "hermes", true),
    ).rejects.toThrow();
    await expect(readFile(storagePath, "utf8")).resolves.toBe("{not-json");
  });

  it("records and lists scrubbed agent action audit events", async () => {
    const service = createIntegrationCapabilityService({
      connectedCapabilityIds: ["calendar.create_event"],
    });
    await service.setApproval(testPrincipal.userId, "calendar.create_event", "hermes", true);
    const audit = createAgentActionAuditService({
      now: () => new Date("2026-05-24T00:00:00.000Z"),
    });
    const app = createIntegrationCapabilityRoutes({ service, audit, getPrincipal: () => testPrincipal });

    const recorded = await app.request(post("/actions", {
      agent: "hermes",
      capability: "calendar.create_event",
      status: "completed",
      summary: "Created launch event but raw provider token sk-live-secret appeared in provider logs",
      target: "Primary calendar",
    }));

    expect(recorded.status).toBe(201);
    await expect(recorded.json()).resolves.toMatchObject({
      action: {
        agent: "hermes",
        capability: "calendar.create_event",
        status: "completed",
        summary: "Agent action completed",
        target: "Primary calendar",
        createdAt: "2026-05-24T00:00:00.000Z",
        completedAt: "2026-05-24T00:00:00.000Z",
      },
    });

    const listed = await app.request("/actions");
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body.actions).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/sk-live|secret|token|\/home/i);
  });

  it("rejects audit actions when a previously approved capability disconnects", async () => {
    let connected = true;
    const service = createIntegrationCapabilityService({
      getConnectedCapabilityIds: async () => {
        return connected ? ["calendar.create_event"] : [];
      },
    });
    await service.setApproval(testPrincipal.userId, "calendar.create_event", "hermes", true);
    connected = false;
    const audit = createAgentActionAuditService();
    const app = createIntegrationCapabilityRoutes({ service, audit, getPrincipal: () => testPrincipal });

    const res = await app.request(post("/actions", {
      agent: "hermes",
      capability: "calendar.create_event",
      status: "completed",
      summary: "Created launch event",
      target: "Primary calendar",
    }));

    expect(res.status).toBe(403);
    expect(await audit.listActions(testPrincipal.userId)).toEqual([]);
  });

  it("rejects audit records when the agent is not approved for the capability", async () => {
    const service = createIntegrationCapabilityService({
      connectedCapabilityIds: ["calendar.create_event"],
    });
    const audit = createAgentActionAuditService();
    const app = createIntegrationCapabilityRoutes({ service, audit, getPrincipal: () => testPrincipal });

    const res = await app.request(post("/actions", {
      agent: "hermes",
      capability: "calendar.create_event",
      status: "completed",
      summary: "Created launch event",
      target: "Primary calendar",
    }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "capability_not_approved",
      message: "Approve the capability before recording agent actions",
      retryable: false,
    });
    expect(await audit.listActions(testPrincipal.userId)).toEqual([]);
  });

  it("keeps normal task identifiers in audit summaries", async () => {
    const audit = createAgentActionAuditService({
      now: () => new Date("2026-05-24T00:00:00.000Z"),
    });

    const action = await audit.recordAction(testPrincipal.userId, {
      agent: "hermes",
      capability: "calendar.create_event",
      status: "completed",
      summary: "Completed task_123 for launch prep",
      target: "Primary calendar",
    });

    expect(action.summary).toBe("Completed task_123 for launch prep");
  });

  it("rejects unknown capabilities with a generic error", async () => {
    const service = createIntegrationCapabilityService();
    const app = createIntegrationCapabilityRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request(post("/capabilities/not_real/approval", {
      agent: "hermes",
      approved: true,
    }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "capability_not_found",
      message: "Integration capability was not found",
      retryable: false,
    });
  });

  it("does not keep approvals in memory when persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-capabilities-readonly-"));
    const storagePath = join(root, "state.json");
    await chmod(root, 0o500);
    const service = createIntegrationCapabilityService({
      connectedCapabilityIds: ["calendar.create_event"],
      storagePath,
    });

    try {
      await expect(service.setApproval(testPrincipal.userId, "calendar.create_event", "hermes", true))
        .rejects.toThrow();
      await expect(service.getCapabilityApproval(testPrincipal.userId, "calendar.create_event"))
        .resolves.toEqual({ capabilityId: "calendar.create_event", approvedAgents: [] });
    } finally {
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps concurrent approvals for the same owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-capabilities-concurrent-"));
    const storagePath = join(root, "state.json");
    const service = createIntegrationCapabilityService({
      connectedCapabilityIds: ["calendar.create_event", "email.read_email"],
      storagePath,
    });

    try {
      await Promise.all([
        service.setApproval(testPrincipal.userId, "calendar.create_event", "hermes", true),
        service.setApproval(testPrincipal.userId, "email.read_email", "hermes", true),
      ]);

      await expect(service.getCapabilityApproval(testPrincipal.userId, "calendar.create_event"))
        .resolves.toEqual({ capabilityId: "calendar.create_event", approvedAgents: ["hermes"] });
      await expect(service.getCapabilityApproval(testPrincipal.userId, "email.read_email"))
        .resolves.toEqual({ capabilityId: "email.read_email", approvedAgents: ["hermes"] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
