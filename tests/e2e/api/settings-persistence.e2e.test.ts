import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestGateway, type TestGateway } from "../fixtures/gateway.js";

describe("E2E: Settings & Layout Persistence", () => {
  let gw: TestGateway;

  beforeAll(async () => {
    gw = await startTestGateway();
  });

  afterAll(async () => {
    await gw?.close();
  });

  it("GET /api/layout returns default layout from template", async () => {
    const res = await fetch(`${gw.url}/api/layout`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("windows");
    expect(body).toHaveProperty("dock");
    expect(Array.isArray(body.windows)).toBe(true);
  });

  it("PUT /api/layout saves layout", async () => {
    const layout = { windows: [{ id: "chat", x: 0, y: 0, w: 400, h: 600 }] };
    const res = await fetch(`${gw.url}/api/layout`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(layout),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("GET /api/layout returns saved layout", async () => {
    const res = await fetch(`${gw.url}/api/layout`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.windows).toBeDefined();
    expect(Array.isArray(body.windows)).toBe(true);
    expect(body.windows[0].id).toBe("chat");
  });

  it("PUT /api/layout without windows array returns 400", async () => {
    const res = await fetch(`${gw.url}/api/layout`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noWindows: true }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("windows");
  });

  it("GET /api/theme returns default theme from template", async () => {
    const res = await fetch(`${gw.url}/api/theme`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("default");
    expect(body).toHaveProperty("colors");
    expect(body).toHaveProperty("fonts");
  });

  it("GET /api/theme reflects updated theme.json", async () => {
    const theme = { name: "midnight", colors: { primary: "#0ff" } };
    writeFileSync(
      join(gw.homePath, "system", "theme.json"),
      JSON.stringify(theme, null, 2),
    );

    const res = await fetch(`${gw.url}/api/theme`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("midnight");
    expect(body.colors.primary).toBe("#0ff");
  });

  it("GET /api/apps returns app list", async () => {
    const res = await fetch(`${gw.url}/api/apps`);
    expect(res.status).toBe(200);
    const apps = await res.json();
    expect(Array.isArray(apps)).toBe(true);
    expect(apps.length).toBeGreaterThan(0);
    for (const app of apps) {
      expect(app).toHaveProperty("name");
      expect(app).toHaveProperty("file");
      expect(app).toHaveProperty("path");
    }
  });

  it("GET /api/system/info returns system info", async () => {
    const res = await fetch(`${gw.url}/api/system/info`);
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info).toHaveProperty("version");
    expect(info).toHaveProperty("uptime");
    expect(info).toHaveProperty("modules");
    expect(info).toHaveProperty("channels");
    expect(info).toHaveProperty("skills");
    expect(typeof info.uptime).toBe("number");
  });
});
