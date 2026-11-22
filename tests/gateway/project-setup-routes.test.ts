import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createProjectSetupRoutes } from "../../packages/gateway/src/chat/project-setup-routes.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";

const principal = { userId: "user_a", source: "configured-container" as const };
const service = () => ({ getProject: vi.fn(async () => ({ draft: null })), start: vi.fn(async () => ({ draft: null })), getChat: vi.fn(async () => ({ draft: null })), update: vi.fn(async () => ({ draft: null })) });
describe("private project setup routes", () => {
  it("keeps initial read nonmutating and binds authenticated owner", async () => {
    const calls = service(); const app = new Hono().route("/", createProjectSetupRoutes({ service: calls, getPrincipal: () => principal }));
    const response = await app.request("/api/projects/project_a/setup");
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(calls.getProject).toHaveBeenCalledWith({ type: "personal", ownerId: "user_a" }, "project_a");
    expect(calls.start).not.toHaveBeenCalled();
  });
  it("denies anonymous requests and missing dependencies", async () => {
    const anonymous = new Hono().route("/", createProjectSetupRoutes({ service: service(), getPrincipal: () => { throw new MissingRequestPrincipalError(); } }));
    expect((await anonymous.request("/api/projects/project_a/setup")).status).toBe(401);
    const unavailable = new Hono().route("/", createProjectSetupRoutes({ service: null, getPrincipal: () => principal }));
    expect((await unavailable.request("/api/projects/project_a/setup")).status).toBe(503);
  });
  it("rejects client authority fields, unsafe paths and unbounded requests", async () => {
    const calls = service(); const app = new Hono().route("/", createProjectSetupRoutes({ service: calls, getPrincipal: () => principal }));
    const mutate = (body: unknown) => app.request("/api/chats/chat_setup/project-setup", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await mutate({ baseRevision: 0, clientRequestId: "req_test", action: { type: "save", ownerId: "user_b" } })).status).toBe(400);
    expect((await mutate({ baseRevision: 0, clientRequestId: "req_test", action: { type: "review_file", path: "../AGENTS.md", content: "escape" } })).status).toBe(400);
    expect((await mutate({ text: "x".repeat(300_000) })).status).toBe(413);
    expect(calls.update).not.toHaveBeenCalled();
  });
});
