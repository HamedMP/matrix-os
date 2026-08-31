import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("shell service worker", () => {
  it("moves clients off the executable-asset cache generation that could strand stale bundles", async () => {
    const source = await readFile("shell/public/service-worker.js", "utf8");

    expect(source).toContain('const VERSION = "v3"');
  });

  it("turns uncached static fetch failures into a response instead of rejecting the FetchEvent", async () => {
    const source = await readFile("shell/public/service-worker.js", "utf8");

    expect(source).toContain("[sw] static fetch failed:");
    expect(source).toContain('new Response("offline",');
    expect(source).toContain("status: 504");
  });

  it("keeps private API and app document routes out of the service worker cache", async () => {
    const source = await readFile("shell/public/service-worker.js", "utf8");

    expect(source).toContain('p.startsWith("/api/")');
    expect(source).toContain('p.startsWith("/v1/")');
    expect(source).toContain('p.startsWith("/files/apps/")');
    expect(source).toContain('p.startsWith("/_next/data/")');
    expect(source).toContain('p.startsWith("/sign-in")');
    expect(source).toContain('p.startsWith("/sign-up")');
  });

  it("limits static caching to safe image, audio, and font files", async () => {
    const source = await readFile("shell/public/service-worker.js", "utf8");

    expect(source).not.toContain('p.startsWith("/_next/static/")');
    expect(source).not.toMatch(/woff2\?\|ttf\|css\|js/);
    expect(source).toContain('p.startsWith("/icons/")');
    expect(source).toContain('p.startsWith("/wallpapers/")');
    expect(source).toContain('p.startsWith("/files/system/wallpapers/")');
  });
});
