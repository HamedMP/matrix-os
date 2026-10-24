import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, opendir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as filesystem from "../../packages/gateway/src/app-gallery/filesystem.js";
import { createAppGalleryService } from "../../packages/gateway/src/app-gallery/service.js";
import { PinnedDirectory } from "../../packages/gateway/src/app-gallery/pinned-directory.js";
import { invalidateAppIndexCache, listUniqueAppManifests } from "../../packages/gateway/src/app-runtime/app-index.js";
import { listApps } from "../../packages/gateway/src/apps.js";

vi.mock("../../packages/gateway/src/app-gallery/filesystem.js", async original => ({
  ...await original<typeof import("../../packages/gateway/src/app-gallery/filesystem.js")>(),
  pinDirectory: vi.fn(), readLimited: vi.fn(), readTemplate: vi.fn(), createPrivateStage: vi.fn(),
}));

const homes: string[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); invalidateAppIndexCache();
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});
async function home() { const path = await mkdtemp(join(tmpdir(), "gallery-index-refresh-")); homes.push(path); await mkdir(join(path, "apps")); return path; }
const definition = { id: "folio", name: "Folio", collection: "personal", category: "Finance", description: "A ledger", tagline: "Your spending", icon: "wallet", accent: "forest", view: "finance", entity: "Expense", fields: [{ key: "amount", label: "Amount", kind: "money" }], services: [], importGoal: "Extract receipts", highlights: ["Currency totals"] };
const slugs = async (homePath: string) => (await listUniqueAppManifests(join(homePath, "apps"))).map(app => app.slug);

// Portable directory doubles; the real Linux descriptor installer has its own suite.
class Directory {
  constructor(readonly path: string) {}
  async close() {}
  async identity() { const info = await stat(this.path); return { dev: info.dev, ino: info.ino }; }
  async child(name: string): Promise<Directory> { const path = join(this.path, name); if (!(await stat(path)).isDirectory()) throw Object.assign(new Error("Not directory"), { code: "ENOTDIR" }); return new Directory(path); }
  async createChild(name: string): Promise<Directory> { await mkdir(join(this.path, name)); return this.child(name); }
  async ensureChild(name: string): Promise<Directory> { try { return await this.createChild(name); } catch (error) { if (!filesystem.isFsError(error, "EEXIST")) throw error; return this.child(name); } }
  async entries() { return opendir(this.path); }
  async readFile(name: string, maxBytes: number) {
    const directory = { openFile: async (_name: string, flags: number) => open(join(this.path, name), flags | constants.O_NOFOLLOW) };
    return PinnedDirectory.prototype.readFile.call(directory as PinnedDirectory, name, maxBytes);
  }
}
function installer(homePath: string, failManifest = false) {
  const bytes: Buffer[] = [];
  const stage = {
    async write(value: Buffer) { bytes.push(value); return String(bytes.length - 1); },
    async publish(name: string, destination: Directory, leaf: string) {
      if (failManifest && leaf === "matrix.json") throw new Error("Publication failure");
      await writeFile(join(destination.path, leaf), bytes[Number(name)], { flag: "wx" });
    },
    release: vi.fn(async () => {}),
  };
  vi.mocked(filesystem.pinDirectory).mockImplementation(async path => new Directory(path) as unknown as Awaited<ReturnType<typeof filesystem.pinDirectory>>);
  vi.mocked(filesystem.readLimited).mockImplementation(async path => Buffer.from(path.endsWith("catalog.json") ? JSON.stringify({ version: 1, apps: [definition] }) : "icon"));
  vi.mocked(filesystem.readTemplate).mockImplementation(async () => new Map([["dist/index.html", Buffer.from("__MATRIX_APP_DEFINITION__")], ["index.html", Buffer.from("__MATRIX_APP_DEFINITION__")], ["src/definition.json", Buffer.from("{}")]]));
  vi.mocked(filesystem.createPrivateStage).mockResolvedValue(stage as unknown as Awaited<ReturnType<typeof filesystem.createPrivateStage>>);
  return createAppGalleryService({ homePath, catalogPath: "/catalog.json" });
}

it("lists a fresh install immediately even when the app index was cached before publication", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); // Freeze the index TTL so only invalidation can refresh it.
  const homePath = await home();
  expect(await slugs(homePath)).toEqual([]);
  expect((await listApps(homePath)).map(app => app.slug)).not.toContain("folio");
  await expect(installer(homePath).install("folio")).resolves.toMatchObject({ status: "installed" });
  expect(await slugs(homePath)).toEqual(["folio"]);
  // Web and Electron Open resolve `matrix-app:folio` against this /api/apps listing.
  expect((await listApps(homePath)).map(app => app.slug)).toContain("folio");
});

it("keeps other owners' cached app indexes when one owner installs", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const homePath = await home(), otherHome = await home();
  expect(await slugs(otherHome)).toEqual([]);
  await installer(homePath).install("folio");
  await mkdir(join(otherHome, "apps/folio"));
  await copyFile(join(homePath, "apps/folio/matrix.json"), join(otherHome, "apps/folio/matrix.json"));
  expect(await slugs(otherHome)).toEqual([]);
});

it("keeps the cached index when publication fails", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const homePath = await home(), source = await home();
  await installer(source).install("folio");
  const manifest = JSON.parse(await readFile(join(source, "apps/folio/matrix.json"), "utf8"));
  expect(await slugs(homePath)).toEqual([]);
  // An unrelated app appears while the index is cached; only a successful publication may refresh it.
  await mkdir(join(homePath, "apps/ledger"));
  await writeFile(join(homePath, "apps/ledger/matrix.json"), JSON.stringify({ ...manifest, slug: "ledger", name: "Ledger" }));
  await expect(installer(homePath, true).install("folio")).rejects.toThrow("Publication failure");
  expect(await slugs(homePath)).toEqual([]);
});
