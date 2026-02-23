import { describe, it, expect, afterAll } from "vitest";
import { startTestGateway, type TestGateway } from "../fixtures/gateway.js";

describe("E2E: Health endpoint", () => {
  let gw: TestGateway;

  afterAll(async () => {
    await gw?.close();
  });

  it("returns ok status", async () => {
    gw = await startTestGateway();
    const res = await fetch(`${gw.url}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
