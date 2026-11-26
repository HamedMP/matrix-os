import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { herdrTransportOptions } from "../../packages/gateway/src/herdr/register.js";
import { afterEach, expect, it, vi } from "vitest";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { hasDirectHerdrOwner } from "../../packages/gateway/src/chat/herdr-owner-ingress.js";
import { createGatewayMatrixMcpCapabilities } from "../../packages/gateway/src/startup/matrix-mcp-capabilities.js";

const handle = "pv-123-13572468";
const origin = "https://platform.example";
const owner = "user_preview";
const token = "private-preview-gateway-fixture";
const host = {
  MATRIX_PREVIEW_RUNTIME: "true", MATRIX_COLLABORATION_DISABLED: "1",
  MATRIX_HANDLE: handle, MATRIX_RUNTIME_SLOT: handle,
  MATRIX_MACHINE_ID: "59186cad-5a12-42c8-bf66-5b739c949000", MATRIX_RUNTIME_TOKEN_EPOCH: "1",
  MATRIX_USER_ID: owner, MATRIX_CLERK_USER_ID: owner, MATRIX_AUTH_TOKEN: token,
  PLATFORM_INTERNAL_URL: origin, MATRIX_UPDATE_MANIFEST_BASE_URL: origin + "/private-preview-updates/" + handle,
};
const ref = { workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId: "tt_" + "a".repeat(32) };
const input = {
  scope: "chat_herdr" as const, owner: { type: "personal", ownerId: owner }, runId: "run_preview",
  fullAccess: true, herdr: { chatId: "chat_one", worktreeId: "wt_1234567890abcdef", executionRoot: "/repo/worktree", ref, revision: "c".repeat(64) },
};
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

it("admits the Platform-verified private owner and rejects direct, delegated, foreign and shared callers", async () => {
  for (const [key, value] of Object.entries(host)) vi.stubEnv(key, value);
  const app = new Hono();
  app.use("*", authMiddleware(token, { resolveMatrixMcpRunContext: presented => presented === "fixture-delegate"
    ? { actorId: owner, runId: "run_test", scope: "chat_call" } : null }));
  app.post("/api/chats/chat_one/turns", c => c.json({ ok: hasDirectHerdrOwner(c, requireRequestPrincipal(c)) }));
  const call = async (actor?: string, bearer = token, otherHeaders: Record<string,string> = {}) => {
    const forwarded = actor ? { "x-platform-user-id": actor, "x-platform-verified": createHmac("sha256", token).update(actor).digest("hex") } : {};
    const response = await app.request("/api/chats/chat_one/turns", { method: "POST", headers: {
      authorization: "Bearer " + bearer, "content-type": "application/json", ...forwarded, ...otherHeaders,
    } });
    return response.json();
  };
  expect(await call(owner)).toEqual({ ok: true });
  expect(await call()).toEqual({ ok: false });
  expect(await call("user_other")).toEqual({ ok: false });
  expect(await call(undefined, "fixture-delegate")).toEqual({ ok: false });
  expect(await call(owner, token, { "x-platform-verified": "invalid" })).toEqual({ ok: false });
  vi.stubEnv("MATRIX_COLLABORATION_DISABLED", "");
  expect(await call(owner)).toEqual({ ok: false });
});

it("issues only a worktree/run-scoped Herdr grant on the provisioned Private Preview, denying incomplete or mismatched host bindings", () => {
  const { registry } = createGatewayMatrixMcpCapabilities(host);
  try {
    const grant = registry.issue(input);
    expect(grant).not.toBeNull();
    expect(registry.resolve(grant!.token, "POST", "/api/chat/herdr-terminal")).toBe(owner);
    expect(registry.resolve(grant!.token, "POST", "/api/mcp-servers/core/call")).toBeNull();
    expect(registry.issue({ ...input, owner: { type: "personal", ownerId: "user_other" } })).toBeNull();
    expect(registry.issue({ ...input, fullAccess: false })).toBeNull();
    grant!.revoke();
    expect(registry.resolve(grant!.token, "POST", "/api/chat/herdr-terminal")).toBeNull();
  } finally { registry.close(); }
  for (const invalid of [
    { MATRIX_COLLABORATION_DISABLED: undefined }, { MATRIX_RUNTIME_SLOT: "primary" },
    { MATRIX_CLERK_USER_ID: "user_other" }, { MATRIX_MACHINE_ID: undefined }, { MATRIX_RUNTIME_TOKEN_EPOCH: "0" },
    { MATRIX_UPDATE_MANIFEST_BASE_URL: origin + "/private-preview-updates/pv-124-13572468" },
    { MATRIX_UPDATE_MANIFEST_BASE_URL: "https://other.example/private-preview-updates/" + handle },
    { MATRIX_HANDLE: "pr-123", MATRIX_RUNTIME_SLOT: "pr-123" }, { MATRIX_PREVIEW_RUNTIME: undefined },
  ]) {
    const denied = createGatewayMatrixMcpCapabilities({ ...host, ...invalid }).registry;
    try { expect(denied.issue(input)).toBeNull(); } finally { denied.close(); }
  }
});

it("launches the pinned private Core as the owner without passing Gateway credentials into the daemon", () => {
  const configured = { ...host, MATRIX_HERDR_CORE_BIN: "/unexpected/binary", DATABASE_URL: "private-test-database-url" };
  const transport = herdrTransportOptions(configured, 1000);
  expect(transport?.bin).toBe("/opt/matrix/app/vendor/herdr/hc");
  expect(transport?.env).toMatchObject({ HOME: "/home/matrix/home", XDG_RUNTIME_DIR: "/run/user/1000" });
  expect(transport?.env).not.toHaveProperty("MATRIX_AUTH_TOKEN");
  expect(transport?.env).not.toHaveProperty("DATABASE_URL");
  expect(herdrTransportOptions(configured, 0)).toBeNull();
});


it("cannot transfer an existing grant to a replacement Gateway or use it after expiry", () => {
  vi.useFakeTimers();
  const current = createGatewayMatrixMcpCapabilities(host).registry;
  const replacement = createGatewayMatrixMcpCapabilities({
    ...host, MATRIX_MACHINE_ID: "963eb676-6f61-4bed-a7d7-91a1756df782", MATRIX_RUNTIME_TOKEN_EPOCH: "2",
  }).registry;
  try {
    const grant = current.issue(input)!;
    const route = "/api/chat/herdr-terminal";
    const context = current.resolveRunContext(grant.token, "POST", route)!;
    expect(context.herdr?.signal.aborted).toBe(false);
    expect(replacement.resolve(grant.token, "POST", route)).toBeNull();
    vi.advanceTimersByTime(36 * 60_000);
    expect(context.herdr?.signal.aborted).toBe(true);
    expect(current.resolve(grant.token, "POST", route)).toBeNull();
  } finally {
    current.close();
    replacement.close();
  }
});
