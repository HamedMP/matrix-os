import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("shell service worker", () => {
  it("turns uncached static fetch failures into a response instead of rejecting the FetchEvent", async () => {
    const source = await readFile("shell/public/service-worker.js", "utf8");

    expect(source).toContain("[sw] static fetch failed:");
    expect(source).toContain('new Response("offline",');
    expect(source).toContain("status: 504");
  });
});
