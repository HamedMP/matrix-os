import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { createBoardMembershipRoutes } from "../../packages/gateway/src/boards/routes.js";
import { createTicketRoutes } from "../../packages/gateway/src/tickets/routes.js";
import { createMatrixSymphonyOrchestrator } from "../../packages/gateway/src/symphony/orchestrator.js";

describe("shared board authorization", () => {
  it("keeps unavailable shared-board fallback aligned with authenticated route failure semantics", async () => {
    const server = await readFile("packages/gateway/src/server.ts", "utf-8");
    expect(server).toContain("unavailableBoardMembers.get(\"/:projectSlug/board/members\", (c) => c.json({ error: { code: \"boards_unavailable\"");
    expect(server).not.toContain("unavailableBoardMembers.get(\"/:projectSlug/board/members\", (c) => c.json({ members: [] }))");
  });

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

  it("rejects ticket owner scopes that board membership cannot represent", async () => {
    const listTickets = vi.fn(async () => ({ tickets: [], nextCursor: null }));
    const authorizeProjectAccess = vi.fn(async () => true);
    const app = new Hono();
    app.route("/api/projects", createTicketRoutes({
      repository: { listTickets } as any,
      getPrincipal: () => ({ userId: "user_2", source: "dev-default" }),
      authorizeProjectAccess,
    }));

    const res = await app.request("/api/projects/repo/tickets?ownerId=owner=1");

    expect(res.status).toBe(400);
    expect(authorizeProjectAccess).not.toHaveBeenCalled();
    expect(listTickets).not.toHaveBeenCalled();
  });

  it("lets teammates read but not manage board members in the requested owner scope", async () => {
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
    expect(add.status).toBe(401);
    expect(service.addMember).not.toHaveBeenCalled();

    const remove = await app.request("/api/projects/repo/board/members/user_3?ownerId=owner_1", { method: "DELETE" });
    expect(remove.status).toBe(401);
    expect(service.removeMember).not.toHaveBeenCalled();
  });

  it("lets board owners manage members in their own owner scope", async () => {
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
      getPrincipal: () => ({ userId: "owner_1", source: "dev-default" }),
    }));

    const add = await app.request("/api/projects/repo/board/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user_3", role: "viewer" }),
    });
    expect(add.status).toBe(201);
    expect(service.addMember).toHaveBeenCalledWith("owner_1", "repo", { userId: "user_3", role: "viewer" });

    const remove = await app.request("/api/projects/repo/board/members/user_3", { method: "DELETE" });
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
    const authorizeTicketClaim = vi.fn(async () => false);
    const orchestrator = createMatrixSymphonyOrchestrator({
      homePath: "/tmp/matrix",
      repository: {
        getSnapshot: vi.fn(async () => ({
          installation: {
            id: "sym_owner_1",
            ownerId: "owner_1",
            projectSlug: "repo",
            pollIntervalMs: 30_000,
            maxConcurrentAgents: 3,
            defaultAgent: "codex",
            authorizedOperators: [],
            enabled: true,
            credentialConfigured: false,
            createdAt: "2026-05-14T18:00:00.000Z",
            updatedAt: "2026-05-14T18:00:00.000Z",
          },
          rule: null,
          runs: [],
          events: [],
          lastPollAt: null,
        })),
      } as any,
      credentialStore: {} as any,
      linearSource: {} as any,
      worktreeManager: {} as any,
      agentSessionManager: {} as any,
      authorizeTicketClaim,
    });

    await expect(orchestrator.assignTicket("owner_1", {
      sourceKind: "matrix",
      externalId: "ticket_1",
      identifier: "MAT-1",
      title: "Shared ticket",
      stateName: "Todo",
      labels: [],
    }, "user_2")).resolves.toBeNull();
    expect(authorizeTicketClaim).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: "owner_1",
      actorId: "user_2",
      ticket: expect.objectContaining({ projectSlug: "repo" }),
    }));
  });

  it("publishes shared ticket events under the board owner scope", async () => {
    const app = new Hono();
    const ticket = {
      id: "ticket_1",
      projectSlug: "repo",
      sourceKind: "matrix",
      sourceId: "ticket_1",
      identifier: "MAT-1",
      title: "Shared ticket",
      description: "",
      status: "Todo",
      priority: "medium",
      assigneeIds: [],
      labelIds: [],
      dependencyIds: [],
      artifactIds: [],
      syncStatus: "local",
      revision: 1,
      createdAt: "2026-05-14T18:00:00.000Z",
      updatedAt: "2026-05-14T18:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
    };
    app.route("/api/projects", createTicketRoutes({
      repository: {
        createInternalTicket: vi.fn(async () => ticket),
        updateTicket: vi.fn(async () => ({ ...ticket, revision: 2, status: "In Progress" })),
      } as any,
      getPrincipal: () => ({ userId: "user_2", source: "dev-default" }),
      authorizeProjectAccess: async () => true,
    }));

    const create = await app.request("/api/projects/repo/tickets?ownerId=owner_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Shared ticket" }),
    });
    expect(create.status).toBe(201);

    const patch = await app.request("/api/projects/repo/tickets/ticket_1?ownerId=owner_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: 1, patch: { status: "In Progress" } }),
    });
    expect(patch.status).toBe(200);

    const events = await app.request("/api/projects/repo/tickets/events?ownerId=owner_1");
    await expect(events.json()).resolves.toMatchObject({
      events: [
        expect.objectContaining({ ownerId: "owner_1", type: "ticket.created" }),
        expect.objectContaining({ ownerId: "owner_1", type: "ticket.updated" }),
      ],
    });
  });
});
