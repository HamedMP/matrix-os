import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { markAuthContextReady } from "../../packages/gateway/src/request-principal";
import { createChatSharingRoutes, shareHtml } from "../../packages/gateway/src/chat/sharing-routes";

it("renders shared text as inert content and sets restrictive headers", async () => {
  const snapshot = { title: "<script>alert(1)</script>", messages: [{ role: "user" as const, text: "<img src=x onerror=alert(1)>" }] };
  expect(shareHtml(snapshot)).not.toContain("<script>");
  expect(shareHtml(snapshot)).toContain("&lt;img");
  const app = createChatSharingRoutes({ read: async () => snapshot } as never);
  const response = await app.request(`/api/share/chats/${"a".repeat(64)}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("rejects malformed capability paths without querying storage", async () => {
  const app = createChatSharingRoutes({ read: async () => { throw new Error("Must not read"); } } as never);
  expect((await app.request("/api/share/chats/not-a-token")).status).toBe(404);
});

it("does not allow unauthenticated share management or oversized mutations", async () => {
  vi.stubEnv("MATRIX_AUTH_TOKEN", "test-token");
  vi.stubEnv("MATRIX_USER_ID", "");
  const app = new Hono();
  app.use("*", async (c, next) => { markAuthContextReady(c); await next(); });
  app.route("/", createChatSharingRoutes(null));
  expect((await app.request("/api/chats/chat_example/shares")).status).toBe(401);
  expect((await app.request("/api/chats/chat_example/shares", { method: "POST", headers: { "content-length": "5000" }, body: "a".repeat(5000) })).status).toBe(413);
});

afterEach(() => vi.unstubAllEnvs());

it("exempts only exact GET capabilities from gateway authentication", async () => {
  const { authMiddleware } = await import("../../packages/gateway/src/auth");
  const app = new Hono();
  app.use("*", authMiddleware("test-secret"));
  app.all("*", (c) => c.text("public"));
  const path = "/api/share/chats/" + "a".repeat(64);
  expect((await app.request(path)).status).toBe(200);
  expect((await app.request(path, { method: "POST" })).status).toBe(401);
  expect((await app.request(path + "/files")).status).toBe(401);
  expect((await app.request("/api/chats/chat_share/shares")).status).toBe(401);
});
