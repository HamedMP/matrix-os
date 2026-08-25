import type {
  CanonicalChatDetailResponse,
  CanonicalChatListResponse,
  CanonicalChatRecord,
  CanonicalCreateChatRequest,
} from "@matrix-os/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  createCanonicalChatRoutes,
  type CanonicalChatRouteService,
} from "../../packages/gateway/src/chat/routes.js";
import type { ChatOwner } from "../../packages/gateway/src/chat/records.js";

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

function routeService(overrides: Partial<CanonicalChatRouteService> = {}): CanonicalChatRouteService {
  return {
    create: vi.fn(async () => record),
    list: vi.fn(async () => ({ items: [record] })),
    getDetail: vi.fn(async () => ({
      record,
      messages: [],
      turns: [],
      runs: [],
      activities: [],
    })),
    ...overrides,
  };
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
});
