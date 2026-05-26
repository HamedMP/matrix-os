import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("clears visible approval when the backing integration disconnects", async () => {
    let connected = true;
    const service = createIntegrationCapabilityService({
      getConnectedCapabilityIds: async () => connected ? capabilityIdsForConnectedServices(["google_calendar"]) : [],
    });

    await service.setApproval(testPrincipal.userId, "calendar.create_event", "hermes", true);
    connected = false;

    const body = await service.listCapabilities(testPrincipal.userId);
    expect(body.capabilities.find((capability) => capability.id === "calendar.create_event")).toMatchObject({
      status: "connect_required",
      approvedAgents: [],
    });
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

  it("does not evict approvals when read-only capability checks see unknown owners", async () => {
    const service = createIntegrationCapabilityService({
      connectedCapabilityIds: ["calendar.create_event"],
    });

    await service.setApproval("owner_0", "calendar.create_event", "hermes", true);
    for (let index = 1; index <= 512; index += 1) {
      await service.listCapabilities(`owner_${index}`);
    }

    const ownerZero = await service.listCapabilities("owner_0");
    expect(ownerZero.capabilities.find((capability) => capability.id === "calendar.create_event")).toMatchObject({
      status: "approved",
      approvedAgents: ["hermes"],
    });
  });

  it("does not evict approvals when revoke checks see unknown owners", async () => {
    const service = createIntegrationCapabilityService({
      connectedCapabilityIds: ["calendar.create_event"],
    });

    await service.setApproval("owner_0", "calendar.create_event", "hermes", true);
    for (let index = 1; index <= 512; index += 1) {
      await service.setApproval(`owner_${index}`, "calendar.create_event", "hermes", false);
    }

    const ownerZero = await service.listCapabilities("owner_0");
    expect(ownerZero.capabilities.find((capability) => capability.id === "calendar.create_event")).toMatchObject({
      status: "approved",
      approvedAgents: ["hermes"],
    });
  });

  it("persists capability approvals across service restarts", async () => {
    const home = await mkdtemp(join(tmpdir(), "matrix-capabilities-"));
    const storagePath = join(home, "system", "integration-capabilities.json");
    const first = createIntegrationCapabilityService({
      connectedCapabilityIds: ["calendar.create_event"],
      storagePath,
    });

    await first.setApproval(testPrincipal.userId, "calendar.create_event", "hermes", true);

    const restarted = createIntegrationCapabilityService({
      connectedCapabilityIds: ["calendar.create_event"],
      storagePath,
    });
    const body = await restarted.listCapabilities(testPrincipal.userId);
    expect(body.capabilities.find((capability) => capability.id === "calendar.create_event")).toMatchObject({
      status: "approved",
      approvedAgents: ["hermes"],
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

  it("rejects audit records for unknown capabilities", async () => {
    const service = createIntegrationCapabilityService();
    const audit = createAgentActionAuditService();
    const app = createIntegrationCapabilityRoutes({ service, audit, getPrincipal: () => testPrincipal });

    const res = await app.request(post("/actions", {
      agent: "hermes",
      capability: "calendar.delete_event",
      status: "completed",
      summary: "Completed task",
      target: "Primary calendar",
    }));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "capability_not_found",
      message: "Integration capability was not found",
      retryable: false,
    });
  });

  it("rejects audit summaries longer than the safe display field", async () => {
    const service = createIntegrationCapabilityService();
    const audit = createAgentActionAuditService();
    const app = createIntegrationCapabilityRoutes({ service, audit, getPrincipal: () => testPrincipal });

    const res = await app.request(post("/actions", {
      agent: "hermes",
      capability: "calendar.create_event",
      status: "completed",
      summary: "a".repeat(241),
      target: "Primary calendar",
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_request",
      message: "Request is invalid",
      retryable: false,
    });
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

  it("keeps normal database wording in audit summaries", async () => {
    const audit = createAgentActionAuditService({
      now: () => new Date("2026-05-24T00:00:00.000Z"),
    });

    const action = await audit.recordAction(testPrincipal.userId, {
      agent: "hermes",
      capability: "calendar.create_event",
      status: "completed",
      summary: "Updated task in project database",
      target: "Primary calendar",
    });

    expect(action.summary).toBe("Updated task in project database");
  });

  it("scrubs password and bearer-shaped audit displays", async () => {
    const audit = createAgentActionAuditService({
      now: () => new Date("2026-05-24T00:00:00.000Z"),
    });

    const action = await audit.recordAction(testPrincipal.userId, {
      agent: "hermes",
      capability: "calendar.create_event",
      status: "completed",
      summary: "Created event with password=hunter2",
      target: "Bearer abc.def.ghi",
    });

    expect(action.summary).toBe("Agent action completed");
    expect(action.target).toBe("Connected service");
  });

  it("does not evict audit events when read-only action checks see unknown owners", async () => {
    const audit = createAgentActionAuditService({
      now: () => new Date("2026-05-24T00:00:00.000Z"),
    });

    await audit.recordAction("owner_0", {
      agent: "hermes",
      capability: "calendar.create_event",
      status: "completed",
      summary: "Created launch event",
      target: "Primary calendar",
    });
    for (let index = 1; index <= 512; index += 1) {
      await audit.listActions(`owner_${index}`);
    }

    const ownerZero = await audit.listActions("owner_0");
    expect(ownerZero).toHaveLength(1);
    expect(ownerZero[0]).toMatchObject({
      agent: "hermes",
      capability: "calendar.create_event",
      status: "completed",
    });
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
