import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClerkRequest } from "@clerk/backend/internal";
import { NextRequest, NextResponse } from "next/server";
import { withClerkPublicOrigin } from "../../shell/src/lib/clerk-proxy-origin";

const require = createRequire(import.meta.url);
const clerkServer = require.resolve("@clerk/nextjs/server", { paths: [resolve("shell")] });
const { decorateRequest } = require(resolve(dirname(clerkServer), "utils.js"));

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

function incoming(headers: Record<string, string> = {}) {
  vi.stubEnv("MATRIX_APP_ORIGIN", "https://preview.example.test");
  vi.stubEnv("__NEXT_NO_MIDDLEWARE_URL_NORMALIZE", "");
  return new NextRequest("http://127.0.0.1:3200/shared?filter=invited", { headers: {
    host: "127.0.0.1:3200", "x-forwarded-host": "preview.example.test", "x-forwarded-proto": "http", ...headers,
  } });
}

async function decorated(request: NextRequest) {
  return withClerkPublicOrigin(request, () => {
    const clerkRequest = createClerkRequest(request);
    expect(clerkRequest.clerkUrl.href).toBe("https://preview.example.test/shared?filter=invited");
    const response = NextResponse.next();
    // The real SDK replaces next() with a same-URL rewrite and signed auth overrides.
    decorateRequest(clerkRequest, response, { reason: "", message: "", status: "signed-in", token: "" });
    return response;
  });
}

describe("Clerk rewrites on the loopback platform shell", () => {
  it("resumes the current route while retaining the real Clerk auth overrides", async () => {
    const response = await decorated(incoming());
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("x-middleware-request-x-clerk-auth-status")).toBe("signed-in");
  });

  it("retains React navigation headers with the real Clerk decorator", async () => {
    const response = await decorated(incoming({ rsc: "1", "next-router-state-tree": "fixture-router-state" }));
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(response.headers.get("x-middleware-request-rsc")).toBe("1");
    expect(response.headers.get("x-middleware-request-next-router-state-tree")).toBe("fixture-router-state");
  });

  it("retains an intentional gateway rewrite", async () => {
    const request = incoming();
    const response = await withClerkPublicOrigin(request, () => NextResponse.rewrite("http://localhost:4000/api/example"));
    expect(response.headers.get("x-middleware-rewrite")).toBe("http://localhost:4000/api/example");
    expect(response.headers.get("x-middleware-next")).toBeNull();
  });
});
