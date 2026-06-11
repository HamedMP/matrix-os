import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { registerIconRoutes } from "../../packages/gateway/src/icon-routes.js";

describe("GET /icons/:file", () => {
  let homePath: string;
  let app: Hono;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "icon-routes-")));
    mkdirSync(join(homePath, "system/icons"), { recursive: true });
    app = new Hono();
    registerIconRoutes(app, homePath);
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("serves icon bytes directly with immutable cache headers instead of redirecting", async () => {
    writeFileSync(join(homePath, "system/icons/workspace.png"), "png-bytes");

    const res = await app.request("/icons/workspace.png?v=abc123");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("png-bytes");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
    expect(res.headers.get("cdn-cache-control")).toBe("public, max-age=86400");
    expect(res.headers.get("etag")).toMatch(/^".+"$/);
  });

  it("returns 304 when if-none-match matches the etag", async () => {
    writeFileSync(join(homePath, "system/icons/workspace.png"), "png-bytes");

    const first = await app.request("/icons/workspace.png");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await app.request("/icons/workspace.png", {
      headers: { "if-none-match": etag as string },
    });
    expect(second.status).toBe(304);
    expect(second.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
  });

  it("supports HEAD requests without a body", async () => {
    writeFileSync(join(homePath, "system/icons/notes.png"), "png-bytes");

    const res = await app.request("/icons/notes.png", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toMatch(/^".+"$/);
  });

  it("falls back to the shipped svg when the png is missing", async () => {
    writeFileSync(join(homePath, "system/icons/terminal.svg"), "<svg/>");

    const res = await app.request("/icons/terminal.png");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<svg/>");
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
  });

  it("falls back to the shared game-center icon when no app icon exists", async () => {
    writeFileSync(join(homePath, "system/icons/game-center.png"), "game-png");

    const res = await app.request("/icons/missing-game.png");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("game-png");
  });

  it("returns 404 when no candidate icon exists", async () => {
    const res = await app.request("/icons/missing.png");
    expect(res.status).toBe(404);
  });

  it("rejects path traversal in the icon name", async () => {
    const res = await app.request("/icons/..%2F..%2Fsecrets.png");
    expect(res.status).toBe(404);
  });
});

describe("GET /system-icons/:file", () => {
  let homePath: string;
  let app: Hono;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "icon-routes-sys-")));
    mkdirSync(join(homePath, "system/icons"), { recursive: true });
    app = new Hono();
    registerIconRoutes(app, homePath);
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("serves bundled icons without the game-center fallback", async () => {
    writeFileSync(join(homePath, "system/icons/game-center.png"), "game-png");

    const res = await app.request("/system-icons/missing-app.png");
    expect(res.status).toBe(404);
  });

  it("serves an existing bundled icon with cache headers", async () => {
    writeFileSync(join(homePath, "system/icons/finder.png"), "png-bytes");

    const res = await app.request("/system-icons/finder.png");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("png-bytes");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
  });
});
