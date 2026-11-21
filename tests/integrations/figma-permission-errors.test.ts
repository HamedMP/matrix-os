import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { getOptionalRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { createIntegrationRoutes } from "../../packages/gateway/src/integrations/routes.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

const owner = "user_figma_fixture_owner";
const other = "user_figma_fixture_other";
const hostToken = "figma-fixture-host-token";
const permissionResponse = {
  error: "Integration access was denied. Check account permissions or reconnect the integration.",
  code: "integration_permission_required",
};
const privateDetail = "missing_scope file_content:read Bearer fixture-secret /private/fixture https://api.figma.com/v1/files/private-file";

function providerError(shape: Record<string, unknown>) {
  return Object.assign(new Error(privateDetail), shape, { body: { error: privateDetail } });
}

describe("Figma permission errors through authenticated integration routes", () => {
  let db: PlatformDb;
  let app: Hono;
  let ownerId: string;
  let connectionId: string;
  const proxyGet = vi.fn();
  const listAccounts = vi.fn(async () => []);

  beforeEach(async () => {
    proxyGet.mockReset();
    listAccounts.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pglite = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: pglite.dialect });
    await db.migrate();
    for (const [clerkId, handle] of [[owner, "figmaowner"], [other, "figmaother"]]) {
      const user = await db.createUser({ clerkId, handle, displayName: "Fixture", email: `${handle}@example.invalid`,
        containerId: `container_${handle}`, pipedreamExternalId: `pd_${handle}` });
      if (clerkId === owner) ownerId = user.id;
    }
    connectionId = (await db.connectService({ userId: ownerId, service: "figma", pipedreamAccountId: "pd_figma_owner",
      accountLabel: "Design", scopes: [] })).id;
    await db.connectService({ userId: ownerId, service: "gmail", pipedreamAccountId: "pd_gmail_owner",
      accountLabel: "Mail", scopes: [] });
    app = new Hono();
    app.use("*", authMiddleware(hostToken));
    app.route("/api/integrations", createIntegrationRoutes({ db, webhookSecret: "fixture-webhook-secret",
      pipedream: { getAppInfo: vi.fn(async () => null), listAccounts, proxyGet } as unknown as PipedreamConnectClient,
      resolveUserId: async (c) => {
        const principal = getOptionalRequestPrincipal(c, { configuredUserId: undefined, isTrustedSingleUserGateway: false });
        return principal ? (await db.getUserByClerkId(principal.userId))?.id ?? null : null;
      },
    }));
  });

  afterEach(async () => { await db.destroy(); vi.restoreAllMocks(); });

  function request(route: string, options: { actor?: string; authorized?: boolean; body?: unknown } = {}) {
    const actor = options.actor ?? owner;
    return app.request(`/api/integrations/${route}`, { method: "POST", headers: {
      "content-type": "application/json",
      ...(options.authorized === false ? {} : {
        authorization: `Bearer ${hostToken}`,
        "x-platform-user-id": actor,
        "x-platform-verified": createHmac("sha256", hostToken).update(actor).digest("hex"),
      }),
    }, body: JSON.stringify(options.body ?? { service: "figma", action: "get_file", label: "Design", params: { fileKey: "fixture-file" } }) });
  }

  for (const route of ["call", "read-call"]) {
    for (const [name, shape] of [
      ["SDK statusCode", { statusCode: 403 }],
      ["SDK rawResponse", { rawResponse: new Response(privateDetail, { status: 403 }) }],
      ["legacy status", { status: 403 }],
    ] as const) {
      it(`${route}: preserves ${name} 403 with safe guidance, without asserting missing scopes`, async () => {
        proxyGet.mockRejectedValueOnce(providerError(shape));
        const response = await request(route);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual(permissionResponse);
        expect(proxyGet).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          externalUserId: "pd_figmaowner", accountId: "pd_figma_owner", url: "https://api.figma.com/v1/files/fixture-file",
        }));
        expect((await db.listConnectedServices(ownerId)).find(c => c.service === "figma")?.last_used_at).toBeNull();
      });
    }

    it(`${route}: gives the same coarse denial for missing-scope, expired-token and file-access errors`, async () => {
      for (const reason of ["missing_scope", "expired token", "file not accessible"]) {
        proxyGet.mockRejectedValueOnce(Object.assign(new Error(reason), { statusCode: 403, body: { error: reason } }));
        const response = await request(route);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual(permissionResponse);
      }
    });

    it(`${route}: keeps authentication, identity selection and parameter rejection ahead of provider calls`, async () => {
      expect((await request(route, { authorized: false })).status).toBe(401);
      expect((await request(route, { actor: other, body: {
        service: "figma", action: "get_file", label: "Design", connectionId, params: { fileKey: "fixture-file" },
      } })).status).toBe(route === "call" ? 403 : 400);
      expect((await request(route, { body: { service: "figma", action: "get_file", label: "Design", params: {} } })).status).toBe(400);
      expect(proxyGet).not.toHaveBeenCalled();
      expect(listAccounts).not.toHaveBeenCalled();
    });

    it(`${route}: does not infer a scope error from raw text, unrelated providers or non-403 status`, async () => {
      for (const error of [new Error(privateDetail), providerError({ statusCode: 401 }), providerError({ statusCode: 404 }), providerError({ statusCode: 500 })]) {
        proxyGet.mockRejectedValueOnce(error);
        const response = await request(route);
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: "Integration call failed" });
      }
      proxyGet.mockRejectedValueOnce(providerError({ statusCode: 403 }));
      const response = await request(route, { body: { service: "gmail", action: "list_labels", label: "Mail", params: {} } });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "Integration call failed" });
    });

    it(`${route}: preserves rate limits, timeouts, connection failures and successful usage`, async () => {
      proxyGet.mockRejectedValueOnce(providerError({ statusCode: 429, rawResponse: new Response(null, { status: 429, headers: { "retry-after": "17" } }) }));
      const limited = await request(route);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("17");
      expect(await limited.json()).toEqual({ error: "Rate limited by provider. Please try again later.", retry_after: 17 });
      proxyGet.mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
      expect((await request(route)).status).toBe(504);
      proxyGet.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      expect((await request(route)).status).toBe(503);
      proxyGet.mockResolvedValueOnce({ document: { id: "fixture-root" } });
      const success = await request(route);
      expect(success.status).toBe(200);
      expect(await success.json()).toEqual({ service: "figma", action: "get_file", data: { document: { id: "fixture-root" } } });
      expect((await db.listConnectedServices(ownerId)).find(c => c.service === "figma")?.last_used_at).not.toBeNull();
    });
  }
});
