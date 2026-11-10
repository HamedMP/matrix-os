import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { registerNativeOwnerAppRoutes } from "../../packages/gateway/src/collaboration/native-owner-app-routes.js";
import { markAuthContextReady, markVerifiedRuntimeBearer, setPlatformVerifiedPrincipal } from "../../packages/gateway/src/request-principal.js";

const appId = "team-tracker";
const scopeId = "50000000-0000-4000-8000-000000000001";
const share = {
  scopeId, organizationId: "org_matrix_team", owner: { actorId: "user_owner", displayName: "Owner" },
  build: { appId, catalogId: "60000000-0000-4000-8000-000000000001", registrationIncarnation: "a".repeat(64),
    manifestVersion: "1.0.0", buildId: "b".repeat(64), manifestDigest: "c".repeat(64), schemaDigest: "d".repeat(64),
    assetDigest: "e".repeat(64), bridgeContractVersion: "matrix-app-bridge-v1", runtimeAbi: "matrix-runtime-v1" },
  readinessId: "70000000-0000-4000-8000-000000000001", state: "active", shareRevision: "1", bindingRevision: "1",
  dataRevision: "4", createdAt: "2026-11-05T10:00:00.000Z", updatedAt: "2026-11-05T10:00:00.000Z",
};

function setup(currentShare: typeof share = share) {
  const routes = new Hono();
  routes.use("*", async (context, next) => {
    markAuthContextReady(context);
    const actor = context.req.header("x-test-owner");
    if (actor) { markVerifiedRuntimeBearer(context); setPlatformVerifiedPrincipal(context, actor); }
    await next();
  });
  const apps = {
    describe: vi.fn(async () => ({ revision: 4, readiness: "ready", collaborationMode: "scoped", collaborativeBuildId: share.build.buildId })),
    query: vi.fn(async () => ({ result: [{ id: "task-1" }], revision: 4 })),
    mutate: vi.fn(async () => ({ result: { ok: true }, revision: 5, replayed: false })),
  };
  const authority = { authorize: vi.fn(async () => ({ resourceKind: "app", organizationId: "org_matrix_team", scopeId,
    actorId: "user_owner", ownerId: "user_owner" })) };
  const onScopeCommitted = vi.fn();
  registerNativeOwnerAppRoutes(routes, { collaborativeAppReadiness: { ownerId: "user_owner", share: { get: async () => currentShare } },
    resources: { apps, catalog: { db: { selectFrom: () => ({ select: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({
      executeTakeFirst: async () => ({ scope_seq: 9 }),
    }) }) }) }) }) } } }, authority, onScopeCommitted } as never);
  return { routes, apps, authority, onScopeCommitted };
}

it("routes native owner reads and mutations through the same scoped adapter", async () => {
  const { routes, apps, authority, onScopeCommitted } = setup();
  const path = `/api/collaboration/apps/${appId}/owner-bridge`;
  const headers = { "x-test-owner": "user_owner", "content-type": "application/json" };
  const state = await routes.request(path, { headers });
  expect(state.status).toBe(200);
  expect(await state.json()).toMatchObject({ revision: "4", scopeSequence: "9", participant: { scopeId, actorId: "user_owner" } });
  const read = await routes.request(path, { method: "POST", headers,
    body: JSON.stringify({ action: { action: "find", table: "tasks", app: appId } }) });
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual({ result: [{ id: "task-1" }], revision: "4" });
  const write = await routes.request(path, { method: "POST", headers,
    body: JSON.stringify({ clientRequestId: "80000000-0000-4000-8000-000000000001", expectedRevision: "4",
      action: { action: "insert", table: "tasks", data: { title: "New" }, app: appId } }) });
  expect(write.status).toBe(200);
  expect(await write.json()).toEqual({ result: { ok: true }, revision: 5, replayed: false });
  expect(apps.query).toHaveBeenCalledWith(expect.objectContaining({ scopeId }), appId, expect.objectContaining({ action: "find" }));
  expect(apps.mutate).toHaveBeenCalledWith(expect.objectContaining({ scopeId }), appId,
    expect.objectContaining({ expectedRevision: 4, clientRequestId: "80000000-0000-4000-8000-000000000001" }));
  expect(authority.authorize).toHaveBeenCalledWith({ scopeId, actorId: "user_owner", action: "mutate_resource" });
  expect(onScopeCommitted).toHaveBeenCalledWith(scopeId);
});

it("does not expose owner scoped data without a verified bearer", async () => {
  const { routes, apps } = setup();
  const response = await routes.request(`/api/collaboration/apps/${appId}/owner-bridge`);
  expect(response.status).toBe(401);
  expect(apps.describe).not.toHaveBeenCalled();
});

it("rejects an owner read when the active binding no longer names the exact shared build", async () => {
  const { routes, apps } = setup();
  apps.describe.mockResolvedValueOnce({ revision: 4, readiness: "ready", collaborationMode: "scoped", collaborativeBuildId: "f".repeat(64) });
  const response = await routes.request(`/api/collaboration/apps/${appId}/owner-bridge`, {
    headers: { "x-test-owner": "user_owner" },
  });
  expect(response.status).toBe(503);
  expect(apps.query).not.toHaveBeenCalled();
});

it("rejects unchecked sharing instead of advertising an unshared legacy app", async () => {
  const { routes, apps } = setup({ ...share, state: "needs_recheck" });
  const path = `/api/collaboration/apps/${appId}/owner-bridge`;
  const headers = { "x-test-owner": "user_owner", "content-type": "application/json" };
  const state = await routes.request(path, { headers });
  expect(state.status).toBe(503);
  const write = await routes.request(path, { method: "POST", headers,
    body: JSON.stringify({ clientRequestId: "80000000-0000-4000-8000-000000000001", expectedRevision: "4",
      action: { action: "insert", table: "tasks", data: { title: "New" }, app: appId } }) });
  expect(write.status).toBe(503);
  expect(apps.query).not.toHaveBeenCalled();
  expect(apps.mutate).not.toHaveBeenCalled();
});

it("verifies the real owner bearer before entering the native owner route", async () => {
  vi.stubEnv("MATRIX_USER_ID", "user_owner");
  try {
    const mocked = setup();
    const routes = new Hono();
    routes.use("*", authMiddleware("owner-gateway-token"));
    // Reuse the handler with the same scoped dependencies while exercising the actual middleware.
    registerNativeOwnerAppRoutes(routes, { collaborativeAppReadiness: { ownerId: "user_owner", share: { get: async () => share } },
      resources: { apps: mocked.apps, catalog: { db: { selectFrom: () => ({ select: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ executeTakeFirst: async () => ({ scope_seq: 9 }) }) }) }) }) }) } } },
      authority: mocked.authority } as never);
    const path = `/api/collaboration/apps/${appId}/owner-bridge`;
    expect((await routes.request(path)).status).toBe(401);
    expect((await routes.request(path, { headers: { authorization: "Bearer incorrect-token" } })).status).toBe(401);
    expect((await routes.request(path, { headers: { authorization: "Bearer owner-gateway-token" } })).status).toBe(200);
  } finally { vi.unstubAllEnvs(); }
});
