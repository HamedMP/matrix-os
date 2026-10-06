import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerAppGalleryRoutes } from "../../packages/gateway/src/app-gallery/routes";
import { markAuthContextReady, setPlatformVerifiedPrincipal } from "../../packages/gateway/src/request-principal";
import { AppManifestSchema } from "../../packages/gateway/src/app-runtime/manifest-schema";
import { loadGallery, installGalleryApp, openGalleryApp, type GalleryBridge } from "../../home/apps/app-gallery/src/model";

const execute = promisify(execFile);
const roots: string[] = []; // Test-owned; drained after each test.
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
beforeAll(async () => {
  await execute(process.execPath, ["scripts/build-app-gallery-template.mjs"], { timeout: 30_000 });
}, 35_000);

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "matrix-gallery-wiring-"));
  roots.push(root);
  const homePath = join(root, "home");
  await mkdir(homePath);
  const app = new Hono();
  app.use("*", async (context, next) => {
    markAuthContextReady(context);
    setPlatformVerifiedPrincipal(context, "test-owner");
    await next();
  });
  registerAppGalleryRoutes(app, { homePath, ownerIds: ["test-owner"] });
  const opened: { name: string; path: string }[] = [];
  const bridge: GalleryBridge = {
    async gatewayFetch(url, init) {
      const response = await app.request(url, init);
      if (!response.ok) throw new Error("Request failed");
      return response.json();
    },
    integrations: async () => [],
    openApp: (name, path) => { opened.push({ name, path }); },
  };
  return { homePath, bridge, opened };
}

describe("bundled gallery through client, authenticated route, and portable runtime", () => {
  it("loads the complete shipped catalog through the actual client parser", async () => {
    const { bridge } = await fixture();
    const { apps, connections } = await loadGallery(bridge);
    expect(apps).toHaveLength(24);
    expect(apps.every(app => !app.installed)).toBe(true);
    expect(connections).toEqual([]);
  });
  it.skipIf(process.platform !== "linux")("installs and opens all 24 actual compiled portable starters", async () => {
    const { bridge, homePath, opened } = await fixture();
    for (const definition of (await loadGallery(bridge)).apps) {
      const installed = await installGalleryApp(bridge, definition.id);
      const folder = join(homePath, installed.path);
      const manifest = AppManifestSchema.parse(JSON.parse(await readFile(join(folder, "matrix.json"), "utf8")));
      expect(manifest).toMatchObject({ slug: definition.id, database: "postgres", scope: "personal", runtime: "vite" });
      const html = await readFile(join(folder, "dist/index.html"), "utf8");
      expect(html).not.toContain("__MATRIX_APP_DEFINITION__");
      expect(html).toContain('id="matrix-app-definition"');
      expect(html).toContain(`"id":"${definition.id}"`);
      expect(JSON.parse(await readFile(join(folder, "src/definition.json"), "utf8"))).toEqual(
        Object.fromEntries(Object.entries(definition).filter(([key]) => key !== "installed")),
      );
      await openGalleryApp(bridge, { ...definition, installed: true, installedName: installed.name, launchPath: installed.path });
      expect(opened.at(-1)).toEqual({ name: definition.name, path: `apps/${definition.id}` });
    }
    expect((await loadGallery(bridge)).apps.every(app => app.installed)).toBe(true);
  }, 120_000);
});
