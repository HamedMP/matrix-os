import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createTicketRoutes } from "../../packages/gateway/src/tickets/routes.js";
import { createMatrixSymphonyOrchestrator } from "../../packages/gateway/src/symphony/orchestrator.js";

describe("shared board authorization", () => {
  it("denies ticket reads before repository access for unauthorized teammates", async () => {
    const listTickets = vi.fn();
    const app = new Hono();
    app.route("/api/projects", createTicketRoutes({
      repository: { listTickets } as any,
      getPrincipal: () => ({ userId: "user_2", source: "dev-default" }),
      authorizeProjectAccess: async () => false,
    }));

    const res = await app.request("/api/projects/repo/tickets");

    expect(res.status).toBe(401);
    expect(listTickets).not.toHaveBeenCalled();
  });

  it("prevents a teammate from claiming tickets outside their shared board permission", async () => {
    const orchestrator = createMatrixSymphonyOrchestrator({
      homePath: "/tmp/matrix",
      repository: { getSnapshot: vi.fn() } as any,
      credentialStore: {} as any,
      linearSource: {} as any,
      worktreeManager: {} as any,
      agentSessionManager: {} as any,
      authorizeTicketClaim: vi.fn(async () => false),
    });

    await expect(orchestrator.assignTicket("owner_1", {
      sourceKind: "matrix",
      externalId: "ticket_1",
      identifier: "MAT-1",
      title: "Shared ticket",
      stateName: "Todo",
      labels: [],
    }, "user_2")).resolves.toBeNull();
  });
});
