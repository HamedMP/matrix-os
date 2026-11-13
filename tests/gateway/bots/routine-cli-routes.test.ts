import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../../../packages/gateway/src/auth.js";
import { createRoutineCliExecutionRoutes } from "../../../packages/gateway/src/bots/routine-cli-routes.js";
import { createBotStateDatabase } from "./bot-state-support.js";
import { requestFixture } from "./routine-cli-request-support.js";
let data: Awaited<ReturnType<typeof createBotStateDatabase>>, f: Awaited<ReturnType<typeof requestFixture>>;
beforeEach(async () => { data = await createBotStateDatabase(); f = await requestFixture(data.db); });
afterEach(async () => { vi.unstubAllEnvs(); await f.close(); await data.destroy(); });
it("real global auth allows exact source capability consumption only at the raw POST route without owner principal", async () => {
  const app = new Hono(); app.use("*", authMiddleware("fixture-owner-bearer"));
  app.route("/", createRoutineCliExecutionRoutes({ requests: f.service() }));
  const operation = { operation: "list" as const }, token = await f.token(operation);
  const response = await app.request("/api/routine-cli/execute", { method: "POST", headers: { authorization: `RoutineCapability ${token}`, "content-type": "application/json" }, body: JSON.stringify({ operation }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ v: 1, ok: true, data: { kind: "list", routines: [], truncated: false } });
  expect((await f.db.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirst())!.consumed_at).not.toBeNull();
});
function app() {
  const result = new Hono(); result.use("*", authMiddleware("fixture-owner-bearer")); result.route("/", createRoutineCliExecutionRoutes({ requests: f.service() }));
  result.post("/api/routines/default", c => c.json({ ownerRoute: true })); return result;
}
const call = (application: Hono, token: string, path = "/api/routine-cli/execute", operation: unknown = { operation: "list" }, extra: Record<string, string> = {}) => application.request(path,
  { method: "POST", headers: { authorization: `RoutineCapability ${token}`, "content-type": "application/json", ...extra }, body: JSON.stringify({ operation }) });
it("checks dependencies at registration", () => { expect(() => createRoutineCliExecutionRoutes({ requests: undefined as never })).toThrow(); });
it("rejects missing/malformed/owner credentials at source route and never promotes cap to owner routes", async () => {
  const application = app(), token = await f.token({ operation: "list" });
  for (const authorization of ["", "Bearer fixture-owner-bearer", "RoutineCapability malformed"]) {
    const response = await application.request("/api/routine-cli/execute", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ operation: { operation: "list" } }) });
    expect([401, 403]).toContain(response.status);
  }
  expect((await call(application, token, "/api/routines/default")).status).toBe(401);
  expect((await application.request("/api/routine-cli/execute", { headers: { authorization: `RoutineCapability ${token}` } })).status).toBe(401);
  expect((await f.db.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirst())!.consumed_at).toBeNull();
});
it.each(["/api/routine-cli/%65xecute", "/api/routine-cli/execute?token=hint", "/api/routine-cli/execute?owner=other"])("raw-path/query alias %s cannot use capability", async path => {
  const token = await f.token({ operation: "list" }); expect((await call(app(), token, path)).status).toBe(401);
  expect((await f.db.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirst())!.consumed_at).toBeNull();
});
it.each(["x-platform-user-id", "x-platform-verified", "x-matrix-clerk-user-id", "x-matrix-user-id", "x-clerk-user-id"])("rejects caller identity header %s", async header => {
  const token = await f.token({ operation: "list" }); expect((await call(app(), token, undefined, undefined, { [header]: "forged" })).status).toBe(401);
});
it("denies replay, expiry, revoked source and wrong exact operation using real consumer", async () => {
  const application = app(), first = await f.token({ operation: "list" });
  expect((await call(application, first)).status).toBe(200); expect((await call(application, first)).status).toBe(403);
  const different = await f.token({ operation: "list" }); expect((await call(application, different, undefined, { operation: "show", routineId: "rt_" + "a".repeat(24) })).status).toBe(403);
  const expired = await f.token({ operation: "list" }); f.state.clock = "2026-09-27T12:01:01.000Z"; expect((await call(application, expired)).status).toBe(403);
  const revoked = await f.token({ operation: "list" }); await f.sources.revoke(f.source); expect((await call(application, revoked)).status).toBe(403);
});
it("bodyLimit runs before JSON parse; body identity fields never supply source authority", async () => {
  const application = app(), token = await f.token({ operation: "list" });
  const huge = await application.request("/api/routine-cli/execute", { method: "POST", headers: { authorization: `RoutineCapability ${token}`, "content-type": "application/json" }, body: " ".repeat(32769) });
  expect(huge.status).toBe(413);
  expect((await call(application, token, undefined, { operation: "list", ownerId: "forged" })).status).toBe(400);
  expect((await f.db.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirst())!.consumed_at).toBeNull();
});

it("a genuinely valid owner JWT succeeds at ordinary owner route but cannot replace source capability or produce principal at source route", async () => {
  const { SignJWT } = await import("jose"), secret = "routine-fixture-jwt-secret-at-least-32-bytes";
  vi.stubEnv("PLATFORM_JWT_PUBLIC_KEY", ""); vi.stubEnv("PLATFORM_JWT_SECRET", secret); vi.stubEnv("MATRIX_HANDLE", "fixture");
  const jwt = await new SignJWT({ handle: "fixture", gateway_url: "https://fixture.invalid" }).setProtectedHeader({ alg: "HS256" })
    .setSubject("fixture-owner").setIssuedAt().setExpirationTime("5m").setIssuer("matrix-os-platform").setAudience("matrix-os-sync").sign(new TextEncoder().encode(secret));
  const application = app();
  expect((await application.request("/api/routines/default", { method: "POST", headers: { authorization: `Bearer ${jwt}` } })).status).toBe(200);
  const response = await application.request("/api/routine-cli/execute", { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify({ operation: { operation: "list" } }) });
  expect(response.status).toBe(401); expect(await response.json()).toMatchObject({ v: 1, error: { code: "source_context_required" } });
  expect(await f.db.selectFrom("routine_cli_capabilities").selectAll().execute()).toHaveLength(0);
});
it("configured-owner principal fallback is unavailable in capability-only request context", async () => {
  const { isAuthContextReady, getOptionalRequestPrincipal } = await import("../../../packages/gateway/src/request-principal.js");
  vi.stubEnv("MATRIX_USER_ID", "fixture_owner"); vi.stubEnv("MATRIX_AUTH_TOKEN", "fixture-owner-bearer");
  const application = new Hono(); application.use("*", authMiddleware("fixture-owner-bearer"));
  let ready: boolean | undefined, principal: unknown, failure: string | undefined;
  application.use("/api/routine-cli/execute", async (c, next) => {
    ready = isAuthContextReady(c);
    try { principal = getOptionalRequestPrincipal(c); } catch (error: unknown) { failure = error instanceof Error ? error.name : "UnknownError"; }
    await next();
  });
  application.route("/", createRoutineCliExecutionRoutes({ requests: f.service() }));
  expect((await call(application, await f.token({ operation: "list" }))).status).toBe(200); expect(ready).toBe(false); expect(principal).toBeUndefined(); expect(failure).toBe("RequestPrincipalMisconfiguredError");
});
