import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { createApp } from "../../packages/platform/src/main.js";
import { cleanupProxyRoutingTest, setupProxyRoutingTest, stubOrchestrator } from "./proxy-routing-test-utils.js";

describe("platform auth fallback indexing", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    db = await setupProxyRoutingTest();
    vi.stubEnv("MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED", "false");
    vi.stubEnv("AUTH_SHELL_HOST", "auth-shell.test");
    vi.stubEnv("AUTH_SHELL_PORT", "3200");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_matrix");
  });

  afterEach(async () => {
    await cleanupProxyRoutingTest(db);
    vi.unstubAllEnvs();
  });

  for (const route of ["sign-in", "sign-up"]) {
    for (const query of ["", "?redirect_url=%2Frecipes%2Fevent-request-desk&promo=launch"]) {
      it(`${route}${query ? " query URL" : " base URL"} stays excluded when the auth shell fails`, async () => {
        const upstream = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("test auth shell unavailable"));
        const app = createApp({
          db,
          orchestrator: stubOrchestrator(),
          clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }),
          platformSecret: "platform-secret-123",
        });
        const response = await app.request(`/${route}${query}`, { headers: { host: "app.matrix-os.com" } });
        expect(upstream).toHaveBeenCalledOnce();
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
        const html = await response.text();
        expect(html).toContain('<meta name="robots" content="noindex, follow">');
        expect(html).toContain(`<link rel="canonical" href="https://app.matrix-os.com/${route}">`);
      });
    }
  }
});
