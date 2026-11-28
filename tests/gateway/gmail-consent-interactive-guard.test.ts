import { mkdtemp, rm } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { registerDeferredRuntimeRoutes } from "../../packages/gateway/src/server/deferred-runtime-routes.js";
import { issueHermesIntegrationCapability } from "../../packages/gateway/src/chat/hermes-integration-capability.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";

const secret = "synthetic-consent-guard-owner-token";
const jwtSecret = "synthetic-consent-guard-jwt-secret-32-characters";
const owner = "user_fixture";
const handle = "fixture-computer";
const connection = "9f05824c-8d0a-4d83-9cb4-b312d43ff112";
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function compose(branch: "local" | "proxy") {
  for (const [key, value] of Object.entries({ MATRIX_CLERK_USER_ID: owner, MATRIX_USER_ID: owner, MATRIX_RUNTIME_SLOT: "primary",
    MATRIX_HANDLE: handle, MATRIX_AUTH_TOKEN: secret, PLATFORM_JWT_SECRET: jwtSecret, NODE_ENV: "production" })) vi.stubEnv(key, value);
  for (const key of ["PLATFORM_JWT_PUBLIC_KEY", "UPGRADE_TOKEN", "MATRIX_PLATFORM_URL", "MATRIX_BROWSER_LAB"]) vi.stubEnv(key, undefined);
  const homePath = await mkdtemp(join(tmpdir(), "gmail-consent-guard-"));
  cleanups.push(() => rm(homePath, { recursive: true, force: true }));
  const reached = vi.fn();
  const routes = new Hono();
  routes.get("/gmail/processing-profiles", c => { reached("GET"); return c.json({ profiles: [] }); });
  routes.post("/gmail/processing-consents", c => { reached("POST"); return c.json({ consentRevision: 1, consentActive: true }); });
  routes.delete("/gmail/processing-consents/:id", c => { reached("DELETE"); return c.json({ revoked: true }); });
  const proxy = vi.fn(async (c: { req: { method: string } }) => { reached(c.req.method); return new Response("{}", { status: 200 }); });
  const mcp = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner });
  cleanups.push(() => mcp.close());
  const app = new Hono();
  app.use("*", authMiddleware(secret, { resolveMatrixMcpRunContext: mcp.resolveRunContext }));
  const runtime = await registerDeferredRuntimeRoutes({ app, homePath, ownerDatabase: null,
    integrationRoutes: branch === "local" ? routes : null,
    internalIntegrationBaseUrl: branch === "proxy" ? "https://platform.invalid/internal/integrations" : null,
    internalPlatformToken: branch === "proxy" ? "fictional-internal-token" : undefined,
    internalPlatformUrl: branch === "proxy" ? "https://platform.invalid" : undefined,
    internalHandle: handle, proxyIntegrationRequest: proxy as never, devAppAuthBypass: false,
    posthogErrorTracker: { captureEvent: vi.fn() } as never, ownerTelemetryDistinctId: "fixture-owner" });
  cleanups.push(async () => { runtime.browserLab.close(); runtime.customMcp.stop(); await runtime.processManager.shutdownAll(); });
  const jwt = await new SignJWT({ handle, runtime_slot: "primary", gateway_url: "https://app.matrix-os.com" })
    .setSubject(owner).setIssuer("matrix-os-platform").setAudience("matrix-os-sync").setIssuedAt().setExpirationTime("5m")
    .setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(jwtSecret));
  const hermes = issueHermesIntegrationCapability(owner);
  cleanups.push(() => hermes.revoke());
  const mcpRun = mcp.issue({ owner: { type: "personal", ownerId: owner }, runId: "run_consent", scope: "chat_call" })!;
  const send = (method: string, path: string, headers: Record<string, string>) => app.request(`https://app.matrix-os.com/api/integrations${path}`, {
    method, headers: { "content-type": "application/json", ...headers },
    ...(method === "POST" ? { body: JSON.stringify({ connectionId: connection, accepted: true }) } : {}) });
  return { reached, send, credentials: {
    jwt: { authorization: `Bearer ${jwt}` },
    platformVerified: { authorization: `Bearer ${secret}`, "x-platform-user-id": owner,
      "x-platform-verified": createHmac("sha256", secret).update(owner).digest("hex") },
    ownerBearer: { authorization: `Bearer ${secret}` },
    hermes: { authorization: `Bearer ${hermes.token}` },
    mcpRun: { authorization: `Bearer ${mcpRun.token}` },
  } };
}

describe.each(["local", "proxy"] as const)("Gmail processing consent mutation via %s integration routes", branch => {
  const mutations = [["POST", "/gmail/processing-consents"], ["DELETE", `/gmail/processing-consents/${connection}`],
    ["POST", "/gmail/processing%2Dconsents"], ["POST", "/GMAIL/processing-consents"], ["POST", "//gmail/processing-consents/"]] as const;

  it("refuses run, Hermes and owner machine bearers before local execution or Platform forwarding", async () => {
    const { reached, send, credentials } = await compose(branch);
    for (const name of ["hermes", "ownerBearer", "mcpRun"] as const) {
      for (const [method, path] of mutations) {
        const response = await send(method, path, credentials[name]);
        expect([401, 403], `${name} ${method} ${path}`).toContain(response.status);
      }
    }
    expect((await send("POST", "/gmail/processing-consents", credentials.hermes)).status).toBe(403);
    expect((await send("POST", "/gmail/processing-consents", credentials.ownerBearer)).status).toBe(403);
    expect(reached).not.toHaveBeenCalled();
  });

  it("keeps interactive owner sessions able to record and revoke, and leaves reads unchanged", async () => {
    const { reached, send, credentials } = await compose(branch);
    for (const name of ["jwt", "platformVerified"] as const) {
      expect((await send("POST", "/gmail/processing-consents", credentials[name])).status, name).toBe(200);
      expect((await send("DELETE", `/gmail/processing-consents/${connection}`, credentials[name])).status, name).toBe(200);
    }
    expect((await send("GET", `/gmail/processing-profiles?connectionId=${connection}`, credentials.hermes)).status).toBe(200);
    expect(reached.mock.calls.map(call => call[0])).toEqual(["POST", "DELETE", "POST", "DELETE", "GET"]);
  });
});
