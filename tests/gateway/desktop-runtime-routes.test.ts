import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDesktopRoutes } from "../../packages/gateway/src/desktop/routes.js";
import { markAuthContextReady } from "../../packages/gateway/src/request-principal.js";

function createApp() {
  const app = new Hono();
  app.use("*", async (ctx, next) => {
    markAuthContextReady(ctx);
    await next();
  });
  app.route(
    "/api/desktop",
    createDesktopRoutes({
      auth: {
        authEnabled: false,
        configuredUserId: undefined,
        devDefaultUserId: "local",
        isLocalDevelopment: true,
        isProduction: false,
        isTrustedSingleUserGateway: false,
      },
      instance: {
        shellUrl: "http://localhost:3000/",
        gatewayUrl: "http://localhost:4000/",
        version: "0.9.0",
      },
    }),
  );
  return app;
}

describe("desktop runtime routes", () => {
  it("returns safe cloud-only runtime capabilities", async () => {
    const res = await createApp().request("/api/desktop/runtime");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      agentExecution: { mode: "cloud", localAgentsAllowed: false },
      gatewayHealth: "healthy",
      version: 1,
    });
    expect(body.capabilities).toEqual(expect.arrayContaining(["matrixShell", "appLauncher"]));
    expect(JSON.stringify(body)).not.toContain("ANTHROPIC");
    expect(JSON.stringify(body)).not.toContain("/Users/");
  });

  it("rejects requests when no request principal can be established", async () => {
    const app = new Hono();
    app.use("*", async (ctx, next) => {
      markAuthContextReady(ctx);
      await next();
    });
    app.route(
      "/api/desktop",
      createDesktopRoutes({
        auth: {
          authEnabled: true,
          configuredUserId: undefined,
          devDefaultUserId: "local",
          isLocalDevelopment: false,
          isProduction: true,
          isTrustedSingleUserGateway: false,
        },
        instance: {
          shellUrl: "http://localhost:3000/",
          gatewayUrl: "http://localhost:4000/",
          version: "0.9.0",
        },
      }),
    );

    const res = await app.request("/api/desktop/runtime");
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });
});
