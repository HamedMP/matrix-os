import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { upgradeGalleryStarters } from "../../packages/gateway/src/app-gallery/sync-upgrade";
import catalog from "../../home/system/app-gallery.json";
import shippedLegacy from "../../home/system/gallery-starter-legacy.json";
import { manifestFor } from "../../packages/gateway/src/app-gallery/service";
const definition = catalog.apps.find(a => a.id === "people")!;
const html = '<script id="matrix-app-definition">__MATRIX_APP_DEFINITION__</script>';
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
let home: string;
const files = new Map([["src/App.tsx", Buffer.from("new app")], ["src/SyncProgress.tsx", Buffer.from("new progress")], ["dist/index.html", Buffer.from(html + "new runtime")], ["dist/assets/new.js", Buffer.from("new bundle")]]);
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "gallery-upgrade-"));
  for (const path of ["src", "dist/assets"]) await mkdir(join(home, "apps/people", path), { recursive: true });
  await writeFile(join(home, "apps/people/matrix.json"), JSON.stringify(manifestFor(definition)));
  await writeFile(join(home, "apps/people/src/definition.json"), JSON.stringify(definition));
  await writeFile(join(home, "apps/people/src/App.tsx"), "old app");
  await writeFile(join(home, "apps/people/dist/index.html"), html.replace("__MATRIX_APP_DEFINITION__", JSON.stringify(definition)));
  await writeFile(join(home, "apps/people/dist/assets/old.js"), "old bundle");
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const upgrade = () => upgradeGalleryStarters({ homePath: home, apps: [definition], files, legacy: { files: { "src/App.tsx": digest("old app"), "dist/assets/old.js": digest("old bundle") }, html } });
it("upgrades a verified installed starter without touching its records, definition, manifest or additional files", async () => {
  await writeFile(join(home, "apps/people/my-notes.txt"), "owner text");
  expect(await upgrade()).toEqual({ updated: ["people"], preserved: [] });
  expect(await readFile(join(home, "apps/people/src/App.tsx"), "utf8")).toBe("new app");
  expect(await readFile(join(home, "apps/people/src/SyncProgress.tsx"), "utf8")).toBe("new progress");
  expect(await readFile(join(home, "apps/people/src/definition.json"), "utf8")).toBe(JSON.stringify(definition));
  expect(await readFile(join(home, "apps/people/my-notes.txt"), "utf8")).toBe("owner text");
  expect(await readFile(join(home, "apps/people/dist/index.html"), "utf8")).toContain("new runtime");
  expect(await upgrade()).toEqual({ updated: [], preserved: [] });
});
it.each(["src/App.tsx", "dist/index.html", "dist/assets/old.js", "src/SyncProgress.tsx"])("preserves the whole installed app when %s contains owner changes", async path => {
  await writeFile(join(home, "apps/people", path), "owner customization");
  expect(await upgrade()).toEqual({ updated: [], preserved: ["people"] });
  expect(await readFile(join(home, "apps/people", path), "utf8")).toBe("owner customization");
});
it("recognizes the manifest and definition rewritten by the installer despite their raw starter signatures", async () => {
  const legacy = { files: { "src/App.tsx": digest("old app"), "dist/assets/old.js": digest("old bundle"),
    "matrix.json": shippedLegacy.files["matrix.json"], "src/definition.json": shippedLegacy.files["src/definition.json"] }, html };
  expect(await upgradeGalleryStarters({ homePath: home, apps: [definition], files, legacy })).toEqual({ updated: ["people"], preserved: [] });
});
it("preserves an owner-customized manifest", async () => {
  const path = join(home, "apps/people/matrix.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...manifest, permissions: ["network"] }));
  expect(await upgrade()).toEqual({ updated: [], preserved: ["people"] });
});
