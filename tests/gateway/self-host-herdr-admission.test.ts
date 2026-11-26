import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { CanonicalChatOrchestrationError, canonicalChatSafeError } from "../../packages/gateway/src/chat/orchestration-errors.js";
import { createCanonicalChatRoutes, type CanonicalChatRouteService } from "../../packages/gateway/src/chat/routes.js";
import { herdrControlParts } from "./fixtures/herdr-chat-control-parts.js";

afterEach(() => vi.unstubAllEnvs());

it("accepts verified self-host owner ingress and refuses ambient, foreign and unmanaged requests before Chat admission", async () => {
  const owner = "self-host-test", bearer = "synthetic-nginx-test-bearer";
  vi.stubEnv("MATRIX_USER_ID", owner);
  vi.stubEnv("MATRIX_SELF_HOSTED", "1");
  vi.stubEnv("MATRIX_AUTH_TOKEN", bearer);
  vi.stubEnv("MATRIX_TAILNET_URL", "http://private.example");
  const admitTurn = vi.fn<CanonicalChatRouteService["admitTurn"]>(async () => {
    // Stand in for the normal missing-chat response after authorization.
    throw new CanonicalChatOrchestrationError(canonicalChatSafeError("chat_not_found", "Chat not found."), 404);
  });
  const app = new Hono();
  app.use("*", authMiddleware(bearer, {
    resolveMatrixMcpRunContext: token => token === "delegated-test-token" ? { actorId: owner, runId: "run_test", scope: "chat_call" } : null,
  }));
  app.route("/", createCanonicalChatRoutes({ service: { admitTurn } as unknown as CanonicalChatRouteService, getPrincipal: requireRequestPrincipal }));
  const send = (headers: Record<string, string>, search = "", parts = herdrControlParts()) =>
    app.request("/api/chats/chat_host/turns" + search, { method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ clientRequestId: "req_admit_herdr", baseRevision: 0, parts, selection: { instanceId: "codex_default", model: "gpt-5.6-sol" }, permissionMode: "full_access", interactionMode: "default", executionRoot: { kind: "worktree", projectId: "project_matrix", worktreeId: "wt_7777777777777777" } }) });
  const authorized = { authorization: "Bearer " + bearer };
  expect((await send(authorized)).status).toBe(404);
  expect(admitTurn.mock.calls[0]?.[4]?.directOwnerTurn).toBe(true);
  expect((await send({ ...authorized, origin: "http://private.example" })).status).toBe(404);
  expect((await send({ ...authorized, "sec-fetch-site": "same-origin" })).status).toBe(404);
  admitTurn.mockClear();
  expect((await send({})).status).toBe(401);
  expect((await send(authorized, "?token=" + bearer)).status).toBe(403);
  expect((await send({ authorization: "Bearer delegated-test-token" })).status).toBe(403);
  expect((await send({}, "?token=" + bearer)).status).toBe(401);
  expect((await send({ ...authorized, "content-type": "text/plain" })).status).toBe(403);
  expect((await send({ ...authorized, "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await send({ ...authorized, origin: "https://foreign.example" })).status).toBe(403);
  vi.stubEnv("MATRIX_SELF_HOSTED", "0");
  expect((await send(authorized)).status).toBe(403);
  expect(admitTurn).not.toHaveBeenCalled();
  expect((await send(authorized, "", [{ type: "text", text: "ordinary task" }])).status).toBe(404);
  expect(admitTurn.mock.calls[0]?.[4]?.directOwnerTurn).toBeUndefined();
});
