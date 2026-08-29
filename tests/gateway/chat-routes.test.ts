import {
  CanonicalChatRunCancellationResponseSchema,
  CanonicalChatRunAdmissionResponseSchema,
  CanonicalChatTurnAdmissionResponseSchema,
  CanonicalChatDetailResponseSchema,
  CanonicalChatListResponseSchema,
  CanonicalChatRecordSchema,
  type CanonicalChatDetailResponse,
  type CanonicalChatListResponse,
  type CanonicalChatRecord,
  type CanonicalCreateChatRequest,
  type CanonicalUpdateChatUserStateRequest,
} from "@matrix-os/contracts";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { describe, expect, it, vi } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import {
  ChatBusyError,
  ChatConflictError,
  ChatRunNotAcknowledgeableError,
} from "../../packages/gateway/src/chat/errors.js";
import {
  createCanonicalChatRoutes,
  type CanonicalChatRouteService,
} from "../../packages/gateway/src/chat/routes.js";
import type { ChatOwner } from "../../packages/gateway/src/chat/records.js";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";

const record: CanonicalChatRecord = {
  chat: {
    id: "chat_route_test",
    ownerScope: { type: "personal", ownerId: "owner_1" },
    title: "Route test",
    lifecycle: "active",
    attention: "none",
    revision: 0,
    messageCount: 0,
    createdAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
  },
};

type AcknowledgingRouteService = CanonicalChatRouteService & {
  acknowledgeCompletion(owner: ChatOwner, chatId: string, runId: string): Promise<CanonicalChatRecord>;
};

function routeService(overrides: Partial<AcknowledgingRouteService> = {}): AcknowledgingRouteService {
  return {
    create: vi.fn(async () => record),
    updateProject: vi.fn(async () => record),
    updateUserState: vi.fn(async () => record),
    acknowledgeCompletion: vi.fn(async () => record),
    delete: vi.fn(async () => ({ chatId: record.chat.id, deletedAt: record.chat.updatedAt })),
    list: vi.fn(async () => ({ items: [record] })),
    search: vi.fn(async () => ({ items: [record] })),
    getDetail: vi.fn(async () => ({
      record,
      messages: [],
      turns: [],
      runs: [],
      activities: [],
    })),
    admitTurn: vi.fn(async () => {
      throw new Error("not configured");
    }),
    cancelRun: vi.fn(async () => {
      throw new Error("not configured");
    }),
    retryTurn: vi.fn(async () => {
      throw new Error("not configured");
    }),
    ...overrides,
  } as AcknowledgingRouteService;
}

function appFor(service: CanonicalChatRouteService) {
  return new Hono().route("/", createCanonicalChatRoutes({
    service,
    getPrincipal: () => ({ userId: "owner_1", source: "jwt" }),
  }));
}

describe("canonical Chat routes", () => {
  it("derives personal ownership and creates a Chat through the shared service", async () => {
    const create = vi.fn(async (_owner: ChatOwner, _input: CanonicalCreateChatRequest) => record);
    const service = routeService({ create });

    const response = await appFor(service).request("/api/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientRequestId: "req_route_test",
        title: "Route test",
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(record);
    expect(create).toHaveBeenCalledWith(
      { type: "personal", ownerId: "owner_1" },
      { clientRequestId: "req_route_test", title: "Route test" },
    );
  });

  it("rejects client-controlled ownership and oversized create bodies", async () => {
    const app = appFor(routeService());
    const invalid = await app.request("/api/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientRequestId: "req_route_test",
        title: "Route test",
        ownerScope: { type: "personal", ownerId: "other_owner" },
      }),
    });
    expect(invalid.status).toBe(400);

    const oversized = await app.request("/api/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientRequestId: "req_route_test",
        title: "x".repeat(97 * 1024),
      }),
    });
    expect(oversized.status).toBe(413);
  });

  it("moves a Chat with owner-derived identity and a strict revision-guarded body", async () => {
    const moved = { ...record, projectId: "project_1" };
    const updateProject = vi.fn(async () => moved);
    const app = appFor(routeService({ updateProject }));

    const response = await app.request("/api/chats/chat_route_test/project", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 0, projectId: "project_1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(moved);
    expect(updateProject).toHaveBeenCalledWith(
      { type: "personal", ownerId: "owner_1" },
      "chat_route_test",
      { baseRevision: 0, projectId: "project_1" },
    );

    const invalid = await app.request("/api/chats/chat_route_test/project", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 0, projectId: null, ownerId: "other" }),
    });
    expect(invalid.status).toBe(400);
  });

  it("updates only the authenticated principal's bounded Chat user state", async () => {
    const pinned = {
      ...record,
      chat: {
        ...record.chat,
        userState: { readThroughSeq: 0, pinned: true, muted: false },
      },
    };
    const updateUserState = vi.fn(async (
      _owner: ChatOwner,
      _chatId: string,
      _input: CanonicalUpdateChatUserStateRequest,
    ) => pinned);
    const app = appFor(routeService({ updateUserState }));

    const response = await app.request("/api/chats/chat_route_test/user-state", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(pinned);
    expect(updateUserState).toHaveBeenCalledWith(
      { type: "personal", ownerId: "owner_1" },
      "chat_route_test",
      { pinned: true },
    );

    const invalid = await app.request("/api/chats/chat_route_test/user-state", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true, ownerId: "other_owner" }),
    });
    expect(invalid.status).toBe(400);

    const oversized = await app.request("/api/chats/chat_route_test/user-state", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true, padding: "x".repeat(5 * 1024) }),
    });
    expect(oversized.status).toBe(413);
  });

  it("acknowledges the authenticated principal's exact completed Run through a strict empty body", async () => {
    const acknowledged = {
      ...record,
      latestSuccessfulCompletion: {
        runId: "run_route_completed",
        completedAt: "2026-08-25T12:02:00.000Z",
        unacknowledged: false,
      },
    };
    const acknowledgeCompletion = vi.fn(async () => acknowledged);
    const response = await appFor(routeService({ acknowledgeCompletion })).request(
      "/api/chats/chat_route_test/runs/run_route_completed/acknowledge",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(acknowledged);
    expect(acknowledgeCompletion).toHaveBeenCalledWith(
      { type: "personal", ownerId: "owner_1" },
      "chat_route_test",
      "run_route_completed",
    );
  });

  it("rejects malformed acknowledgement paths, non-empty bodies, and oversized bodies", async () => {
    const app = appFor(routeService());
    const request = (path: string, body: unknown) => app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect((await request(
      "/api/chats/not-a-chat/runs/run_route_completed/acknowledge",
      {},
    )).status).toBe(400);
    expect((await request(
      "/api/chats/chat_route_test/runs/not-a-run/acknowledge",
      {},
    )).status).toBe(400);
    expect((await request(
      "/api/chats/chat_route_test/runs/run_route_completed/acknowledge",
      { completedAt: "2026-08-25T12:02:00.000Z" },
    )).status).toBe(400);
    expect((await request(
      "/api/chats/chat_route_test/runs/run_route_completed/acknowledge",
      { padding: "x".repeat(5 * 1024) },
    )).status).toBe(413);
  });

  it("returns a safe acknowledgement error without exposing repository details", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await appFor(routeService({
        acknowledgeCompletion: vi.fn(async () => {
          throw new Error("postgres://secret-host/private-owner");
        }),
      })).request("/api/chats/chat_route_test/runs/run_route_completed/acknowledge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: {
          code: "service_unavailable",
          safeMessage: "Chat is temporarily unavailable.",
          retryable: true,
          recoveryActions: ["retry"],
        },
      });

      const rejected = await appFor(routeService({
        acknowledgeCompletion: vi.fn(async () => {
          throw new ChatRunNotAcknowledgeableError("chat_route_test", "run_route_completed");
        }),
      })).request("/api/chats/chat_route_test/runs/run_route_completed/acknowledge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toEqual({
        error: {
          code: "run_unavailable",
          safeMessage: "Only a successful completed Run can be acknowledged.",
          retryable: false,
        },
      });
    } finally {
      errorLog.mockRestore();
    }
  });

  it("deletes an owned Chat with an idempotency key", async () => {
    const remove = vi.fn(async () => ({
      chatId: record.chat.id,
      deletedAt: "2026-08-26T12:00:00.000Z",
    }));
    const response = await appFor(routeService({ delete: remove })).request(
      "/api/chats/chat_route_test?clientRequestId=req_route_delete",
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(remove).toHaveBeenCalledWith(
      { type: "personal", ownerId: "owner_1" },
      "chat_route_test",
      "req_route_delete",
    );
  });

  it("returns safe conflict semantics for stale revisions and active Runs", async () => {
    const stale = appFor(routeService({
      updateProject: vi.fn(async () => {
        throw new ChatConflictError("chat_route_test", 2);
      }),
    }));
    const staleResponse = await stale.request("/api/chats/chat_route_test/project", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 1, projectId: "project_1" }),
    });
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toEqual({
      error: {
        code: "chat_conflict",
        safeMessage: "Chat changed. Refresh and try again.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    });

    const busy = appFor(routeService({
      updateProject: vi.fn(async () => {
        throw new ChatBusyError("chat_route_test");
      }),
    }));
    const busyResponse = await busy.request("/api/chats/chat_route_test/project", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 1, projectId: null }),
    });
    expect(busyResponse.status).toBe(409);
    expect(await busyResponse.json()).toEqual({
      error: {
        code: "chat_busy",
        safeMessage: "This Chat already has an active Run.",
        retryable: false,
      },
    });
  });

  it("passes bounded filters to list and returns an opaque cursor page", async () => {
    const page: CanonicalChatListResponse = { items: [record], nextCursor: "chatcur_next" };
    const list = vi.fn(async () => page);
    const response = await appFor(routeService({ list })).request(
      "/api/chats?limit=25&lifecycle=active&projectId=project_1&cursor=chatcur_prev",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(list).toHaveBeenCalledWith(
      { type: "personal", ownerId: "owner_1" },
      { limit: 25, lifecycle: "active", projectId: "project_1", cursor: "chatcur_prev" },
    );
  });

  it("projects only root Chats for the Global route", async () => {
    const list = vi.fn(async () => ({ items: [record] }));
    const response = await appFor(routeService({ list })).request(
      "/api/chats?scope=global",
    );

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(
      { type: "personal", ownerId: "owner_1" },
      { limit: 50, projectId: null },
    );
  });

  it("searches canonical Chats within the selected route scope", async () => {
    const search = vi.fn(async () => ({ items: [record] }));
    const app = appFor(routeService({ search }));

    const response = await app.request(
      "/api/chats/search?query=release%20plan&limit=10&projectId=project_1",
    );

    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledWith(
      { type: "personal", ownerId: "owner_1" },
      { query: "release plan", limit: 10, projectId: "project_1" },
    );
  });

  it("returns bounded detail and hides other-owner Chats as not found", async () => {
    const detail: CanonicalChatDetailResponse = {
      record,
      messages: [],
      turns: [],
      runs: [],
      activities: [],
    };
    const getDetail = vi.fn(async () => detail);
    const response = await appFor(routeService({ getDetail })).request(
      "/api/chats/chat_route_test?limit=100",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(detail);
    expect(getDetail).toHaveBeenCalledWith(
      { type: "personal", ownerId: "owner_1" },
      "chat_route_test",
      { limit: 100 },
    );

    const missing = await appFor(routeService({ getDetail: vi.fn(async () => null) }))
      .request("/api/chats/chat_route_test");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: {
        code: "chat_not_found",
        safeMessage: "Chat not found.",
        retryable: false,
      },
    });
  });

  it("runs create, list, and detail through the real repository while isolating owners", async () => {
    const pglite = await KyselyPGlite.create();
    const repository = new ChatRepository(pglite.dialect);
    await repository.bootstrap();

    const service = createCanonicalChatService(repository);
    const ownerApp = new Hono().route("/", createCanonicalChatRoutes({
      service,
      getPrincipal: () => ({ userId: "owner_integration", source: "jwt" }),
    }));
    const otherOwnerApp = new Hono().route("/", createCanonicalChatRoutes({
      service,
      getPrincipal: () => ({ userId: "other_owner", source: "jwt" }),
    }));

    try {
      const createdResponse = await ownerApp.request("/api/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientRequestId: "req_gateway_integration",
          title: "Gateway integration",
        }),
      });
      expect(createdResponse.status).toBe(201);
      const created = CanonicalChatRecordSchema.parse(await createdResponse.json());
      expect(created.chat.id).toMatch(/^chat_[a-f0-9]{32}$/);
      expect(created.chat.ownerScope).toEqual({ type: "personal", ownerId: "owner_integration" });

      const listResponse = await ownerApp.request("/api/chats");
      expect(listResponse.status).toBe(200);
      expect(CanonicalChatListResponseSchema.parse(await listResponse.json()).items).toEqual([created]);

      const detailResponse = await ownerApp.request(`/api/chats/${created.chat.id}`);
      expect(detailResponse.status).toBe(200);
      expect(CanonicalChatDetailResponseSchema.parse(await detailResponse.json()).record).toEqual(created);

      expect((await otherOwnerApp.request(`/api/chats/${created.chat.id}`)).status).toBe(404);
    } finally {
      await repository.kysely.destroy();
    }
  });

  it("admits and cancels a Run through strict owner-derived routes", async () => {
    const admission = CanonicalChatTurnAdmissionResponseSchema.parse({
      record: {
        ...record,
        chat: {
          ...record.chat,
          revision: 1,
          messageCount: 1,
          currentSelection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
        },
        providerBinding: {
          driverKind: "codex",
          instanceId: "codex_default",
          lockedAtTurnId: "cturn_route",
        },
        activeRun: { runId: "run_route", turnId: "cturn_route", status: "accepted" },
      },
      message: {
        id: "msg_route",
        chatId: record.chat.id,
        seq: 1,
        role: "user",
        state: "committed",
        turnId: "cturn_route",
        parts: [{ type: "text", text: "ship it" }],
        createdAt: "2026-08-26T00:00:00.000Z",
      },
      turn: {
        id: "cturn_route",
        chatId: record.chat.id,
        clientRequestId: "req_route_turn",
        baseMessageSeq: 0,
        inputMessageId: "msg_route",
        status: "accepted",
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
      },
      run: {
        id: "run_route",
        chatId: record.chat.id,
        turnId: "cturn_route",
        attempt: 1,
        driverKind: "codex",
        instanceId: "codex_default",
        selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
        interactionMode: "default",
        permissionMode: "supervised",
        status: "accepted",
        historyBoundarySeq: 0,
        capabilitySnapshot: {
          revision: "catalog_route",
          rootChat: true,
          attachments: ["file"],
          resources: ["file", "folder", "project"],
          tools: [],
          approvals: true,
          userInput: true,
          resume: true,
          cancellation: true,
          worktrees: "optional",
          interactionModes: ["default"],
          permissionModes: ["supervised"],
        },
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
      },
      admission: "accepted",
    });
    const cancellation = CanonicalChatRunCancellationResponseSchema.parse({
      run: {
        ...admission.run,
        status: "aborted",
        outcome: "aborted",
        startedAt: "2026-08-26T00:00:00.000Z",
        completedAt: "2026-08-26T00:01:00.000Z",
        updatedAt: "2026-08-26T00:01:00.000Z",
      },
      cancellation: "aborted",
    });
    const admitTurn = vi.fn(async () => admission);
    const cancelRun = vi.fn(async () => cancellation);
    const retryAdmission = CanonicalChatRunAdmissionResponseSchema.parse({
      record: admission.record,
      turn: admission.turn,
      run: { ...admission.run, id: "run_route_retry", attempt: 2 },
      admission: "accepted",
    });
    const retryTurn = vi.fn(async () => retryAdmission);
    const app = appFor(routeService({ admitTurn, cancelRun, retryTurn }));

    const accepted = await app.request("/api/chats/chat_route_test/turns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientRequestId: "req_route_turn",
        baseRevision: 0,
        parts: [{ type: "text", text: "ship it" }],
        selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
        interactionMode: "default",
        permissionMode: "supervised",
      }),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual(admission);
    expect(admitTurn).toHaveBeenCalledWith(
      { userId: "owner_1", source: "jwt" },
      { type: "personal", ownerId: "owner_1" },
      "chat_route_test",
      expect.objectContaining({ clientRequestId: "req_route_turn" }),
    );

    const cancelled = await app.request("/api/chats/chat_route_test/runs/run_route/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientRequestId: "req_route_cancel" }),
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual(cancellation);
    expect(cancelRun).toHaveBeenCalledWith(
      { type: "personal", ownerId: "owner_1" },
      "chat_route_test",
      "run_route",
      { clientRequestId: "req_route_cancel" },
    );

    const retried = await app.request("/api/chats/chat_route_test/turns/cturn_route/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientRequestId: "req_route_retry", baseRevision: 2 }),
    });
    expect(retried.status).toBe(202);
    expect(await retried.json()).toEqual(retryAdmission);
    expect(retryTurn).toHaveBeenCalledWith(
      { userId: "owner_1", source: "jwt" },
      { type: "personal", ownerId: "owner_1" },
      "chat_route_test",
      "cturn_route",
      { clientRequestId: "req_route_retry", baseRevision: 2 },
    );
  });
});
