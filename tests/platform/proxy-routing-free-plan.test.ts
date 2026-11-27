import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { createApp } from "../../packages/platform/src/main.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { createTestPlatformDb } from "./native-platform-db-test-helper.js";
import { cleanupProxyRoutingTest, stubOrchestrator } from "./proxy-routing-test-utils.js";

describe("platform fallback sign-up page on the Free plan", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await cleanupProxyRoutingTest(db);
  });

  it("describes the Free plan on the fallback sign-up page only when a free provisioner is configured (ENG-520)", async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_matrix";
    const page = async (freeTier?: NonNullable<Parameters<typeof createApp>[0]["freeTier"]>) => {
      const app = createApp({
        db,
        orchestrator: stubOrchestrator(),
        clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }),
        platformSecret: "platform-secret-123",
        ...(freeTier ? { freeTier } : {}),
      });
      return (await app.request("/sign-up", { headers: { host: "app.matrix-os.com" } })).text();
    };

    const freeProvisioner = {} as NonNullable<NonNullable<Parameters<typeof createApp>[0]["freeTier"]>["provisioner"]>;
    const open = await page({ config: { maxRuntimes: 10, inviteRequired: false }, provisioner: freeProvisioner });
    expect(open).toContain("var freePlanAvailable = true;");
    expect(open).toContain("Start on the Free plan.");
    const closed = await page();
    expect(closed).toContain("var freePlanAvailable = false;");
    expect(closed).not.toContain("Start on the Free plan.");
  });
});
