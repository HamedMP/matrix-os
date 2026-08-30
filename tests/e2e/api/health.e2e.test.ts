import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestGateway, type TestGateway } from "../fixtures/gateway.js";

describe("E2E: Health endpoint", () => {
  let gw: TestGateway;

  beforeAll(async () => {
    gw = await startTestGateway({ runningVersion: "v2026.08.18-997" });
  });

  afterAll(async () => {
    await gw?.close();
  });

  it("returns ok status", async () => {
    const res = await fetch(`${gw.url}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.runningVersion).toBe("v2026.08.18-997");
  });

  it("reports the same startup-captured version through authenticated system info", async () => {
    const res = await gw.request("/api/system/info");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runningVersion).toBe("v2026.08.18-997");
  });
});
