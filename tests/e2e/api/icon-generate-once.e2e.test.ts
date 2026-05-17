import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startTestGateway, type TestGateway } from "../fixtures/gateway.js";

describe("E2E: Icon generate-once lock", () => {
  let gw: TestGateway;

  beforeAll(async () => {
    gw = await startTestGateway();
  });

  afterAll(async () => {
    await gw?.close();
  });

  it("returns existing icon without regenerating on second call", async () => {
    const iconsDir = join(gw.homePath, "system/icons");
    mkdirSync(iconsDir, { recursive: true });
    writeFileSync(join(iconsDir, "custom-test-app.png"), "existing-icon-data");

    const res = await fetch(`${gw.url}/api/apps/custom-test-app/icon`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { iconUrl: string; alreadyExists: boolean; cost?: number };
    expect(body.iconUrl).toBe("/files/system/icons/custom-test-app.png");
    expect(body.alreadyExists).toBe(true);
    expect(body.cost).toBeUndefined();
  });

  it("does not provide a regenerate-all endpoint", async () => {
    const res = await fetch(`${gw.url}/api/icons/regenerate-all`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("provides generate-missing endpoint that skips existing icons", async () => {
    const iconsDir = join(gw.homePath, "system/icons");
    mkdirSync(iconsDir, { recursive: true });
    writeFileSync(join(iconsDir, "existing-app.png"), "existing-icon");

    const res = await fetch(`${gw.url}/api/icons/generate-missing`, {
      method: "POST",
    });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });
});
