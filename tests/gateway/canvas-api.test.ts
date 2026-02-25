import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

describe("Canvas API", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), "canvas-test-"));
    mkdirSync(join(homePath, "system"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("GET /api/canvas returns {} when no canvas.json exists", async () => {
    const { createApp } = await import("./helpers/canvas-helpers.js");
    const app = createApp(homePath);
    const res = await app.request("/api/canvas");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({});
  });

  it("GET /api/canvas returns saved data", async () => {
    const data = { transform: { zoom: 1.5, panX: -100, panY: 50 }, groups: [] };
    writeFileSync(join(homePath, "system/canvas.json"), JSON.stringify(data));

    const { createApp } = await import("./helpers/canvas-helpers.js");
    const app = createApp(homePath);
    const res = await app.request("/api/canvas");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transform.zoom).toBe(1.5);
    expect(body.transform.panX).toBe(-100);
  });

  it("PUT /api/canvas saves valid data", async () => {
    const { createApp } = await import("./helpers/canvas-helpers.js");
    const app = createApp(homePath);
    const data = { transform: { zoom: 2, panX: 0, panY: 0 }, groups: [] };
    const res = await app.request("/api/canvas", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const saved = JSON.parse(readFileSync(join(homePath, "system/canvas.json"), "utf-8"));
    expect(saved.transform.zoom).toBe(2);
  });

  it("PUT /api/canvas rejects missing transform", async () => {
    const { createApp } = await import("./helpers/canvas-helpers.js");
    const app = createApp(homePath);
    const res = await app.request("/api/canvas", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groups: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT /api/canvas rejects empty body", async () => {
    const { createApp } = await import("./helpers/canvas-helpers.js");
    const app = createApp(homePath);
    const res = await app.request("/api/canvas", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
