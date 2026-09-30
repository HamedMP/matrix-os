import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClerkRequest } from "@clerk/backend/internal";
import { NextRequest, NextResponse } from "next/server";
import { getRelativeURL } from "next/dist/shared/lib/router/utils/relativize-url";

const require = createRequire(import.meta.url);
const clerkServer = require.resolve("@clerk/nextjs/server", { paths: [resolve("shell")] });
const { decorateRequest } = require(resolve(dirname(clerkServer), "utils.js"));

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

async function config(platform: boolean) {
  vi.stubEnv("MATRIX_PLATFORM_AUTH_SHELL", platform ? "1" : "");
  vi.stubEnv("POSTHOG_API_KEY", "");
  vi.stubEnv("POSTHOG_PROJECT_ID", "");
  vi.resetModules();
  return (await import("../../shell/next.config")).default;
}

describe("Clerk rewrites on the loopback platform shell", () => {
  it("keeps the real Clerk rewrite internal to Next's original network URL", async () => {
    const nextConfig = await config(true);
    // This flag is compiled by Next from skipProxyUrlNormalize.
    vi.stubEnv("__NEXT_NO_MIDDLEWARE_URL_NORMALIZE", nextConfig.skipProxyUrlNormalize ? "1" : "");
    const networkUrl = "http://127.0.0.1:3200/shared?filter=invited";
    const request = new NextRequest(networkUrl, { headers: {
      host: "127.0.0.1:3200", "x-forwarded-host": "preview.matrix-os.com", "x-forwarded-proto": "https",
    } });
    const clerkRequest = createClerkRequest(request);
    expect(clerkRequest.clerkUrl.href).toBe("https://preview.matrix-os.com/shared?filter=invited");
    const response = NextResponse.next();
    // Exercise the installed SDK's own decorator, which converts next() to a rewrite.
    decorateRequest(clerkRequest, response, { reason: "", message: "", status: "signed-in", token: "" });
    expect(getRelativeURL(response.headers.get("x-middleware-rewrite")!, networkUrl))
      .toBe("/shared?filter=invited");
  });

  it("keeps the customer shell's URL normalization default", async () => {
    expect((await config(false)).skipProxyUrlNormalize).toBeFalsy();
  });
});
