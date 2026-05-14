import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createTicketAutomationRoutes } from "../../packages/gateway/src/tickets/automation-routes.js";

describe("Ticket automation routes", () => {
  it("validates automation rules and keeps execution scoped to cloud runtime", async () => {
    const saveRule = vi.fn(async (rule) => ({ ...rule, id: "automation_1", enabled: true }));
    const app = new Hono();
    app.route("/api/projects", createTicketAutomationRoutes({
      saveRule,
      getPrincipal: () => ({ userId: "user_123", source: "dev-default" }),
    }));

    const res = await app.request("/api/projects/repo/tickets/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ready to Symphony",
        trigger: { type: "ticket.status.changed", statuses: ["Ready"] },
        action: { type: "assign_to_symphony", runtimeMode: "cloud" },
      }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ automation: { id: "automation_1", action: { runtimeMode: "cloud" } } });
    expect(saveRule).toHaveBeenCalledWith(expect.objectContaining({ projectSlug: "repo", ownerId: "user_123" }));
  });
});
