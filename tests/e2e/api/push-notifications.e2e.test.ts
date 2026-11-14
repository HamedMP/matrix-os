import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestGateway, type TestGateway } from "../fixtures/gateway.js";

// The test gateway runs without an owner database (no DATABASE_URL). Push tokens
// live in owner Postgres (spec 652, A2), so valid requests fail closed with a
// generic 503 instead of pretending the device was stored. tests/gateway/push-*.test.ts
// cover storage against Postgres.
describe("E2E: Push notification registration", () => {
  let gw: TestGateway;

  beforeAll(async () => {
    gw = await startTestGateway();
  });

  afterAll(async () => {
    await gw?.close();
  });

  async function pushRegister(method: "POST" | "DELETE", body: unknown) {
    const res = await fetch(`${gw.url}/api/push/register`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it("refuses to register a token without an owner database", async () => {
    for (const platform of ["ios", "android"]) {
      expect(await pushRegister("POST", { token: "abc123", platform })).toEqual({
        status: 503,
        body: { error: "Push registration unavailable" },
      });
    }
  });

  it("rejects registration without token", async () => {
    const res = await pushRegister("POST", { platform: "ios" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("rejects registration without platform", async () => {
    const res = await pushRegister("POST", { token: "abc123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("refuses to remove a token without an owner database", async () => {
    expect(await pushRegister("DELETE", { token: "remove-me" })).toEqual({
      status: 503,
      body: { error: "Push registration unavailable" },
    });
  });

  it("rejects removal without token", async () => {
    const res = await pushRegister("DELETE", {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });
});
