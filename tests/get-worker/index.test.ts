import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createInstallerHandler } from "../../packages/get-worker/src/handler";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// `curl -fsSL https://get.matrix-os.com | sh` is the documented standalone
// install path. These tests cover the Worker that answers that host: it must
// return the repository's installer byte-for-byte, and nothing else that a
// shell could run.
describe("get.matrix-os.com installer handler", () => {
  let script: string;
  let handle: (request: Request) => Response;

  beforeAll(async () => {
    script = await readFile(resolve(repoRoot, "scripts/install.sh"), "utf8");
    handle = createInstallerHandler(script);
  });

  it.each(["/", "/install.sh"])("serves the installer at %s", async (path) => {
    const response = handle(new Request(`https://get.matrix-os.com${path}`));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(script);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    // Cloudflare must never hold an old installer after a deploy.
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
  });

  it("ignores query strings so cache-busting installs still work", async () => {
    const response = handle(new Request("https://get.matrix-os.com/?v=1"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(script);
  });

  it("answers HEAD without a body", async () => {
    const response = handle(new Request("https://get.matrix-os.com/", { method: "HEAD" }));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-length")).toBe(String(new TextEncoder().encode(script).length));
  });

  it("returns 404 for unknown paths so `curl -f | sh` runs nothing", async () => {
    const response = handle(new Request("https://get.matrix-os.com/install.ps1"));

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("#!/bin/sh");
  });

  it("rejects methods other than GET and HEAD", () => {
    const response = handle(new Request("https://get.matrix-os.com/", { method: "POST", body: "x" }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it.each(["", "<html>not a script</html>"])("refuses to serve a bundle that is not the installer", (broken) => {
    expect(() => createInstallerHandler(broken)).toThrow(/installer/i);
  });
});
