import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { BotInstantiationError } from "../../../packages/gateway/src/bots/instantiation.js";
import { createBotRoutes } from "../../../packages/gateway/src/bots/routes.js";
import { MissingRequestPrincipalError } from "../../../packages/gateway/src/request-principal.js";

const RESPONSE = {
  agent: { id: "bot_0123456789abcdef01234567", name: "Writing Bot", avatarSeed: "a".repeat(32), revision: 1, status: "active" as const },
  chatId: "chat_0123456789abcdef01234567",
  operation: "created" as const,
};
const BODY = { clientRequestId: "req_route_1", recipe: { recipeId: "writing-bot", version: "2026-09-27.1" } };

function app(instantiate?: (ownerId: string, body: unknown) => Promise<typeof RESPONSE | { operation: "replayed" } & Omit<typeof RESPONSE, "operation">>, authenticated = true) {
  const server = new Hono();
  server.route("/", createBotRoutes({
    ...(instantiate ? { instantiation: { instantiate: vi.fn(instantiate) } as never } : {}),
    getPrincipal: () => {
      if (!authenticated) throw new MissingRequestPrincipalError();
      return { userId: "user_owner_1", source: "jwt" } as never;
    },
  }));
  return server;
}

const post = (server: Hono, body: string) => server.request("/api/chat-agents/instantiate", {
  method: "POST", headers: { "content-type": "application/json" }, body,
});

describe("POST /api/chat-agents/instantiate", () => {
  it("creates for the principal and replays with 200, privately", async () => {
    const instantiate = vi.fn(async () => RESPONSE);
    const created = await post(app(instantiate), JSON.stringify(BODY));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("private, no-store");
    expect(await created.json()).toEqual(RESPONSE);
    expect(instantiate).toHaveBeenCalledWith("user_owner_1", BODY);
    const replayed = await post(app(async () => ({ ...RESPONSE, operation: "replayed" as const })), JSON.stringify(BODY));
    expect(replayed.status).toBe(200);
  });

  it("requires a principal before anything else", async () => {
    const instantiate = vi.fn(async () => RESPONSE);
    const response = await post(app(instantiate, false), JSON.stringify(BODY));
    expect(response.status).toBe(401);
    expect(instantiate).not.toHaveBeenCalled();
  });

  it("bounds and parses the body", async () => {
    const instantiate = vi.fn(async () => RESPONSE);
    const large = await post(app(instantiate), JSON.stringify({ ...BODY, name: "x".repeat(70 * 1024) }));
    expect(large.status).toBe(413);
    expect((await post(app(instantiate), "{not json")).status).toBe(400);
    expect(instantiate).not.toHaveBeenCalled();
  });

  it("maps typed failures to allowlisted codes and generic messages", async () => {
    for (const [code, status] of [["invalid_request", 400], ["conflict", 409], ["rate_limited", 429], ["unavailable", 503]] as const) {
      const response = await post(app(async () => { throw new BotInstantiationError(code); }), JSON.stringify(BODY));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ code, message: expect.any(String) });
    }
    const leaked = await post(app(async () => { throw new Error("relation bot_operations at /home/matrix/home failed"); }), JSON.stringify(BODY));
    expect(leaked.status).toBe(503);
    expect(await leaked.text()).not.toMatch(/bot_operations|\/home/);
  });

  it("answers 503 when bot services are not running", async () => {
    const response = await post(app(), JSON.stringify(BODY));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "unavailable", message: expect.any(String) });
  });
});
