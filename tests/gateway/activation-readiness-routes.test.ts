import { describe, expect, it } from "vitest";
import { createReadinessRoutes } from "../../packages/gateway/src/onboarding/readiness-routes.js";
import { createTestReadinessService, testPrincipal } from "../helpers/activation-readiness.js";

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("activation readiness routes", () => {
  it("returns owner-scoped readiness with Hermes as the system agent", async () => {
    const { service } = createTestReadinessService();
    const app = createReadinessRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request("/readiness");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.systemAgent).toBe("hermes");
    expect(body.activeAgents).toContain("hermes");
    expect(body.gates.some((gate: { id: string }) => gate.id === "hermes.available")).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/secret|token|postgres|\/home\//i);
  });

  it("validates goal selection and returns tailored setup steps", async () => {
    const { service } = createTestReadinessService();
    const app = createReadinessRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request(jsonRequest("/goals", { goalIds: ["coding", "assistant"] }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.goalIds).toEqual(["coding", "assistant"]);
    expect(body.steps.map((step: { id: string }) => step.id)).toEqual(expect.arrayContaining([
      "github.connected",
      "project.selected",
      "issue_source.selected",
      "integrations.capabilities",
      "hermes.available",
    ]));
  });

  it("derives coding setup gates from GitHub, project, issue source, Symphony, and terminal state", async () => {
    const { service } = createTestReadinessService(undefined, {
      codingSetup: {
        githubConnected: true,
        selectedProject: { slug: "matrix-os", name: "Matrix OS" },
        issueSourceConfigured: true,
        symphonyReady: true,
        terminalReady: false,
        activeAgents: ["codex", "hermes"],
        handoffStatus: "running",
      },
    });
    const app = createReadinessRoutes({ service, getPrincipal: () => testPrincipal });

    await app.request(jsonRequest("/goals", { goalIds: ["coding"] }));
    const res = await app.request("/readiness");

    expect(res.status).toBe(200);
    const body = await res.json();
    const gatesById = new Map(body.gates.map((gate: { id: string }) => [gate.id, gate]));
    expect(gatesById.get("github.connected")).toMatchObject({
      status: "pass",
      message: "GitHub is connected for coding workflows",
      remediation: null,
    });
    expect(gatesById.get("project.selected")).toMatchObject({
      status: "pass",
      message: "Matrix OS is selected for coding work",
    });
    expect(gatesById.get("issue_source.selected")).toMatchObject({
      status: "pass",
      message: "A task source is connected for coding work",
    });
    expect(gatesById.get("symphony.ready")).toMatchObject({
      status: "pass",
      message: "Symphony is ready to dispatch coding work",
    });
    expect(gatesById.get("terminal.ready")).toMatchObject({
      status: "fail",
      remediation: "Open the Matrix terminal for the selected project",
    });
    expect(body.activeAgents).toEqual(["codex", "hermes"]);
  });

  it("leaves assistant capability approval indeterminate until an integration is connected", async () => {
    const { service } = createTestReadinessService(undefined, {
      integrationCapabilityService: {
        listCapabilities: async () => ({
          capabilities: [{
            id: "calendar.create_event",
            provider: "calendar",
            capability: "create_calendar_event",
            status: "connect_required",
            approvedAgents: [],
            requiresApprovalPerAction: true,
          }],
        }),
        getCapabilityApproval: async () => null,
        setApproval: async () => ({
          capabilityId: "calendar.create_event",
          agent: "hermes",
          status: "connect_required",
        }),
      },
    });
    const app = createReadinessRoutes({ service, getPrincipal: () => testPrincipal });

    await app.request(jsonRequest("/goals", { goalIds: ["assistant"] }));
    const res = await app.request("/readiness");

    expect(res.status).toBe(200);
    const body = await res.json();
    const gatesById = new Map(body.gates.map((gate: { id: string }) => [gate.id, gate]));
    expect(gatesById.get("integrations.capabilities")).toMatchObject({
      status: "unknown",
      message: "Assistant capabilities have not been approved",
    });
  });

  it("rejects invalid goals with a generic client-safe error", async () => {
    const { service } = createTestReadinessService();
    const app = createReadinessRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request(jsonRequest("/goals", { goalIds: ["../../secrets"] }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      error: "invalid_request",
      message: "Request is invalid",
      retryable: false,
    });
  });

  it("rejects malformed goal JSON as a non-retryable client error", async () => {
    const { service } = createTestReadinessService();
    const app = createReadinessRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request("http://localhost/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "invalid_request",
      message: "Request is invalid",
      retryable: false,
    });
  });

  it("marks retryable gates as checking", async () => {
    const { service } = createTestReadinessService();
    const app = createReadinessRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request("http://localhost/gates/terminal.ready/retry", { method: "POST" });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ gateId: "terminal.ready", status: "checking" });
  });
});
