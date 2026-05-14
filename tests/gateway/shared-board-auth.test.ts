import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createBoardMembershipRoutes } from "../../packages/gateway/src/boards/routes.js";
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

  it("reads shared board tickets from the board owner's scope", async () => {
    const listTickets = vi.fn(async () => ({ tickets: [], nextCursor: null }));
    const authorizeProjectAccess = vi.fn(async () => true);
    const app = new Hono();
    app.route("/api/projects", createTicketRoutes({
      repository: { listTickets } as any,
      getPrincipal: () => ({ userId: "user_2", source: "dev-default" }),
      authorizeProjectAccess,
    }));

    const res = await app.request("/api/projects/repo/tickets?ownerId=owner_1");

    expect(res.status).toBe(200);
    expect(authorizeProjectAccess).toHaveBeenCalledWith({
      ownerId: "owner_1",
      principalUserId: "user_2",
      projectSlug: "repo",
      action: "read",
    });
    expect(listTickets).toHaveBeenCalledWith("owner_1", "repo", expect.objectContaining({ source: "all" }));
  });

  it("manages shared board members against the requested board owner scope", async () => {
    const service = {
      canReadBoard: vi.fn(async () => true),
      canWriteBoard: vi.fn(async () => true),
      listMembers: vi.fn(async () => []),
      addMember: vi.fn(async () => ({ projectSlug: "repo", userId: "user_3", role: "viewer", addedBy: "owner_1", addedAt: "now" })),
      removeMember: vi.fn(async () => {}),
    };
    const app = new Hono();
    app.route("/api/projects", createBoardMembershipRoutes({
      service,
      getPrincipal: () => ({ userId: "user_2", source: "dev-default" }),
    }));

    const list = await app.request("/api/projects/repo/board/members?ownerId=owner_1");
    expect(list.status).toBe(200);
    expect(service.canReadBoard).toHaveBeenCalledWith("owner_1", "repo", "user_2");
    expect(service.listMembers).toHaveBeenCalledWith("owner_1", "repo");

    const add = await app.request("/api/projects/repo/board/members?ownerId=owner_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user_3", role: "viewer" }),
    });
    expect(add.status).toBe(201);
    expect(service.canWriteBoard).toHaveBeenCalledWith("owner_1", "repo", "user_2");
    expect(service.addMember).toHaveBeenCalledWith("owner_1", "repo", { userId: "user_3", role: "viewer" });

    const remove = await app.request("/api/projects/repo/board/members/user_3?ownerId=owner_1", { method: "DELETE" });
    expect(remove.status).toBe(200);
    expect(service.removeMember).toHaveBeenCalledWith("owner_1", "repo", "user_3");
  });

  it("syncs Linear tickets into the requested board owner scope", async () => {
    const linearSyncSource = vi.fn(async () => ({ tickets: [], truncated: false }));
    const app = new Hono();
    app.route("/api/projects", createTicketRoutes({
      repository: {} as any,
      getPrincipal: () => ({ userId: "user_2", source: "dev-default" }),
      authorizeProjectAccess: async () => true,
      linearSyncSource,
    }));

    const res = await app.request("/api/projects/repo/tickets/sync/linear?ownerId=owner_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: "lin", mode: "preview" }),
    });

    expect(res.status).toBe(200);
    expect(linearSyncSource).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "owner_1", projectSlug: "repo" }));
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
