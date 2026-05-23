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
      "integrations.capabilities",
      "hermes.available",
    ]));
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

  it("marks retryable gates as checking", async () => {
    const { service } = createTestReadinessService();
    const app = createReadinessRoutes({ service, getPrincipal: () => testPrincipal });

    const res = await app.request("http://localhost/gates/terminal.ready/retry", { method: "POST" });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ gateId: "terminal.ready", status: "checking" });
  });
});

