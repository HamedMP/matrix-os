import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createAppDispatcher } from "../../../packages/gateway/src/app-runtime/dispatcher.js";
import { invalidateManifestCache } from "../../../packages/gateway/src/app-runtime/manifest-loader.js";

let tmpDir: string;
let homeDir: string;
let app: Hono;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "matrix-os-dispatcher-"));
  homeDir = tmpDir;
  await mkdir(join(homeDir, "apps"), { recursive: true });
  invalidateManifestCache();

  app = new Hono();
  const dispatcher = createAppDispatcher(homeDir);
  app.route("/apps/:slug", dispatcher);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function installStaticApp(slug: string, htmlContent: string) {
  const appDir = join(homeDir, "apps", slug);
  await mkdir(appDir, { recursive: true });
  await writeFile(
    join(appDir, "matrix.json"),
    JSON.stringify({
      name: slug,
      slug,
      version: "1.0.0",
      runtime: "static",
      runtimeVersion: "^1.0.0",
    }),
  );
  await writeFile(join(appDir, "index.html"), htmlContent);
}

async function installViteApp(slug: string, distHtml: string) {
  const appDir = join(homeDir, "apps", slug);
  await mkdir(join(appDir, "dist"), { recursive: true });
  await writeFile(
    join(appDir, "matrix.json"),
    JSON.stringify({
      name: slug,
      slug,
      version: "1.0.0",
      runtime: "vite",
      runtimeVersion: "^1.0.0",
      build: { command: "pnpm build", output: "dist" },
    }),
  );
  await writeFile(join(appDir, "dist", "index.html"), distHtml);
}

describe("App Runtime Dispatcher", () => {
  describe("static serving", () => {
    it("serves index.html for static app at /apps/:slug/", async () => {
      await installStaticApp("calculator", "<html><body>Calculator</body></html>");
      const res = await app.request("/apps/calculator/");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Calculator");
      expect(res.headers.get("content-type")).toContain("text/html");
    });

    it("serves nested static files", async () => {
      const appDir = join(homeDir, "apps", "calculator");
      await installStaticApp("calculator", "<html></html>");
      await writeFile(join(appDir, "style.css"), "body { margin: 0; }");

      const res = await app.request("/apps/calculator/style.css");
      expect(res.status).toBe(200);
      const css = await res.text();
      expect(css).toContain("body");
      expect(res.headers.get("content-type")).toContain("text/css");
    });
  });

  describe("vite serving", () => {
    it("serves dist/index.html for vite app at /apps/:slug/", async () => {
      await installViteApp("notes", "<html><body>Notes SPA</body></html>");
      const res = await app.request("/apps/notes/");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Notes SPA");
    });

    it("returns 503 needs_build when vite dist/ is missing", async () => {
      const appDir = join(homeDir, "apps", "broken-vite");
      await mkdir(appDir, { recursive: true });
      await writeFile(
        join(appDir, "matrix.json"),
        JSON.stringify({
          name: "broken-vite",
          slug: "broken-vite",
          version: "1.0.0",
          runtime: "vite",
          runtimeVersion: "^1.0.0",
          build: { command: "pnpm build", output: "dist" },
        }),
      );

      const res = await app.request("/apps/broken-vite/");
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe("needs_build");
    });
  });

  describe("security", () => {
    it("rejects path traversal slug with 400 or 404", async () => {
      // Hono normalizes URLs, so ../etc/passwd gets resolved before routing.
      // A slug containing dots is rejected by SAFE_SLUG regex.
      const res = await app.request("/apps/..%2f..%2fetc%2fpasswd/");
      // Either 400 (SAFE_SLUG rejects) or 404 (route doesn't match) is acceptable
      expect([400, 404]).toContain(res.status);
    });

    it("rejects invalid slug with 400", async () => {
      const res = await app.request("/apps/-bad-slug/");
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing manifest", async () => {
      const res = await app.request("/apps/nonexistent/");
      expect(res.status).toBe(404);
    });
  });

  describe("WebSocket", () => {
    it("rejects WebSocket upgrade in static/vite modes with 400", async () => {
      await installStaticApp("calculator", "<html></html>");
      const res = await app.request("/apps/calculator/ws", {
        headers: { Upgrade: "websocket" },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("ws_not_supported");
    });
  });

  describe("SPA fallback", () => {
    it("serves index.html for non-existing paths in vite mode", async () => {
      await installViteApp("spa-app", "<html><body>SPA Fallback</body></html>");
      const res = await app.request("/apps/spa-app/some/deep/route");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("SPA Fallback");
    });
  });
});
