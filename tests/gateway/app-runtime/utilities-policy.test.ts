import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppDispatcher } from "../../../packages/gateway/src/app-runtime/dispatcher.js";
import { invalidateManifestCache } from "../../../packages/gateway/src/app-runtime/manifest-loader.js";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "utilities-policy-")); invalidateManifestCache(); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
async function serve(slug: string, listingTrust = "first_party", author = "system", runtime = "vite") {
  const dir = join(home, "apps", slug);
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "matrix.json"), JSON.stringify({ name: slug, slug, author, listingTrust, runtime, version: "1.0.0", runtimeVersion: "^1.0.0", build: { command: "vite build", output: "dist" } }));
  await writeFile(join(dir, runtime === "vite" ? "dist/index.html" : "index.html"), "<!doctype html><main>test</main>");
  const app = new Hono(); app.route("/apps/:slug", createAppDispatcher(home));
  const response = await app.request(`/apps/${slug}/`);
  expect(response.status).toBe(200);
  return response.headers.get("content-security-policy")!;
}
describe("bundled Utilities serving policy", () => {
  it("supports isolated workers, WASM, local media, and explicit model hosts", async () => {
    const csp = await serve("utilities");
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).toContain("worker-src 'self' blob: https://cdn.jsdelivr.net");
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("frame-src blob:");
    expect(csp).toContain("https://huggingface.co");
    expect(csp).toContain("https://us.aws.cdn.hf.co");
    expect(csp).not.toMatch(/(?:connect|script)-src[^;]*(?:https:;|\*)/);
    expect(csp).not.toContain("'unsafe-eval'");
  });
  it.each([
    ["ordinary", "first_party", "system", "vite"],
    ["utilities", "community", "system", "vite"],
    ["utilities", "first_party", "contact", "vite"],
    ["utilities", "first_party", "system", "static"],
  ])("keeps ordinary policy for %s/%s/%s/%s", async (slug, trust, author, runtime) => {
    const csp = await serve(slug, trust, author, runtime);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("huggingface");
    expect(csp).not.toContain("wasm-unsafe-eval");
  });
});
