import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestGateway, type TestGateway } from "../fixtures/gateway.js";

describe("E2E: Security headers", () => {
  let gw: TestGateway;

  beforeAll(async () => {
    gw = await startTestGateway();
  });

  afterAll(async () => {
    await gw?.close();
  });

  it("includes security headers on /health", async () => {
    const res = await fetch(`${gw.url}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(res.headers.get("X-XSS-Protection")).toBe("1; mode=block");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("includes security headers on /api/tasks", async () => {
    const res = await fetch(`${gw.url}/api/tasks`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(res.headers.get("X-XSS-Protection")).toBe("1; mode=block");
  });

  it("includes security headers on /files/ but omits X-Frame-Options", async () => {
    const res = await fetch(`${gw.url}/files/system/soul.md`);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-XSS-Protection")).toBe("1; mode=block");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    // X-Frame-Options is intentionally skipped for /files/ paths (app content)
    expect(res.headers.get("X-Frame-Options")).toBeNull();
  });

  it("includes CORS headers (Access-Control-Allow-Origin)", async () => {
    const res = await fetch(`${gw.url}/health`);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("responds to CORS preflight requests", async () => {
    const res = await fetch(`${gw.url}/api/tasks`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBeTruthy();
  });

  it("includes Referrer-Policy on API routes", async () => {
    const res = await fetch(`${gw.url}/api/cron`);
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });
});
