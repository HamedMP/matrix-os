import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import catalog from "../../home/system/app-gallery.json";
import { createAppGalleryService } from "../../packages/gateway/src/app-gallery/service";
import { DEFAULT_LIMITS, readTemplate } from "../../packages/gateway/src/app-gallery/filesystem";

const definition = catalog.apps.find(app => app.id === "focus")!;
const placeholder = "__MATRIX_APP_DEFINITION__";
let root: string;
let homePath: string;
let templatePath: string;
let catalogPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "matrix-gallery-dependencies-"));
  homePath = join(root, "home");
  templatePath = join(root, "starter");
  catalogPath = join(root, "catalog.json");
  await mkdir(homePath);
  await mkdir(join(templatePath, "src"), { recursive: true });
  await mkdir(join(templatePath, "dist"));
  await writeFile(catalogPath, JSON.stringify({ version: 1, apps: [definition] }));
  await writeFile(join(templatePath, "index.html"), `<script type="application/json">${placeholder}</script>`);
  await writeFile(join(templatePath, "dist/index.html"), `<script type="application/json">${placeholder}</script>`);
  await writeFile(join(templatePath, "src/definition.json"), "{}");
  await writeFile(join(templatePath, "package.json"), '{"scripts":{"build":"vite build"}}');
  // The actual template builder installs pnpm dependencies before compiling.
  // cp -a home carries their build-only store and symlinks into old bundles.
  const dependency = join(templatePath, "node_modules/.pnpm/react@19/node_modules/react");
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, "package.json"), '{"name":"react"}');
  await symlink(".pnpm/react@19/node_modules/react", join(templatePath, "node_modules/react"));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe.skipIf(process.platform !== "linux")("gallery build-only template dependencies", () => {
  it("reads the source and compiled payload without traversing the root dependency store", async () => {
    const files = await readTemplate(templatePath, { ...DEFAULT_LIMITS, maxFiles: 4 });
    expect([...files.keys()].sort()).toEqual([
      "dist/index.html", "index.html", "package.json", "src/definition.json",
    ]);
  });

  it("installs Focus from a built pnpm template and keeps retry idempotent", async () => {
    const service = createAppGalleryService({ homePath, catalogPath, templatePath });
    await expect(service.install("focus")).resolves.toMatchObject({ status: "installed", path: "apps/focus" });
    const destination = join(homePath, "apps/focus");
    expect(JSON.parse(await readFile(join(destination, "matrix.json"), "utf8"))).toMatchObject({
      slug: "focus", database: "postgres", scope: "personal", permissions: [],
    });
    expect(JSON.parse(await readFile(join(destination, "src/definition.json"), "utf8"))).toMatchObject(definition);
    expect(await readFile(join(destination, "dist/index.html"), "utf8")).not.toContain(placeholder);
    await expect(readFile(join(destination, "node_modules/react/package.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(destination, "src/definition.json"), "owner edit");
    await expect(service.install("focus")).resolves.toMatchObject({ status: "already_installed" });
    expect(await readFile(join(destination, "src/definition.json"), "utf8")).toBe("owner edit");
  });

  it("still rejects dependency-named symlinks inside the published source", async () => {
    await rm(join(templatePath, "node_modules"), { recursive: true });
    await symlink(root, join(templatePath, "src/node_modules"));
    await expect(readTemplate(templatePath, DEFAULT_LIMITS)).rejects.toThrow("Template contains symlink");
  });
});
