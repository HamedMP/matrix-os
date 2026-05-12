import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "../../tests/e2e/fixtures/gateway.js";

describe("Browser app E2E smoke", () => {
  let gw: TestGateway;

  beforeAll(async () => {
    gw = await startTestGateway();
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  it("opens Browser from Canvas and shares the session with standalone routing", async () => {
    const created = await fetch(`${gw.url}/api/browser/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profileName: "default",
        targetUrl: "https://example.com/",
        surface: "canvas",
        deviceId: "browser-canvas",
      }),
    });
    expect(created.status).toBe(200);
    const body = await created.json() as {
      session: { id: string; state: string; takeoverRequired: boolean };
      streamToken: string;
      wsUrl: string;
    };
    expect(body.session).toMatchObject({ state: "active", takeoverRequired: false });
    expect(body.wsUrl).toBe(`/api/browser/sessions/${body.session.id}/ws`);
    expect(body.streamToken.length).toBeGreaterThan(20);

    const standalone = await fetch(`${gw.url}/api/browser/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profileName: "default",
        targetUrl: "https://example.com/docs",
        surface: "standalone",
        deviceId: "browser-canvas",
      }),
    });
    await expect(standalone.json()).resolves.toMatchObject({
      session: { id: body.session.id, state: "active", takeoverRequired: false },
    });
  });
});
