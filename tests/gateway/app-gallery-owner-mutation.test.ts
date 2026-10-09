import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import * as filesystem from "../../packages/gateway/src/app-gallery/filesystem.js";
import { createAppGalleryService } from "../../packages/gateway/src/app-gallery/service.js";
import { PinnedDirectory } from "../../packages/gateway/src/app-gallery/pinned-directory.js";
import { registerFileRoutes } from "../../packages/gateway/src/server/file-routes.js";
import { withOwnerFileMutation } from "../../packages/gateway/src/owner-file-mutations.js";

vi.mock("../../packages/gateway/src/app-gallery/filesystem.js", async original => ({
  ...await original<typeof import("../../packages/gateway/src/app-gallery/filesystem.js")>(),
  pinDirectory: vi.fn(), readLimited: vi.fn(), readTemplate: vi.fn(), createPrivateStage: vi.fn(),
}));
const homes: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.resetAllMocks(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function home() { const path = await mkdtemp(join(tmpdir(), "gallery-owner-coordination-")); homes.push(path); await mkdir(join(path, "apps")); return path; }
const definition = { id: "folio", name: "Folio", collection: "personal", category: "Finance", description: "A ledger", tagline: "Your spending", icon: "wallet", accent: "forest", view: "finance", entity: "Expense", fields: [{ key: "amount", label: "Amount", kind: "money" }], services: [], importGoal: "Extract receipts", highlights: ["Currency totals"] };
async function fixture(window: "mkdir-open" | "manifest" | "cleanup", fail = false) {
  const homePath = await home(), entered = deferred(), released = deferred();
  // Portable directory doubles exercise service/route wiring; real Linux capabilities have separate suites.
  class Directory {
    constructor(readonly path: string) {}
    async close() {}
    async identity() { const info = await stat(this.path); return { dev: info.dev, ino: info.ino }; }
    async child(name: string): Promise<Directory> { const path = join(this.path, name); const info = await stat(path); if (!info.isDirectory()) throw Object.assign(new Error("Not directory"), { code: "ENOTDIR" }); return new Directory(path); }
    async createChild(name: string): Promise<Directory> {
      await mkdir(join(this.path, name));
      if (name === "folio" && window === "mkdir-open") { entered.resolve(); await released.promise; }
      return this.child(name);
    }
    async ensureChild(name: string): Promise<Directory> { try { return await this.createChild(name); } catch (error) { if (!filesystem.isFsError(error, "EEXIST")) throw error; return this.child(name); } }
    async readFile(name: string) { return readFile(join(this.path, name)); }
  }
  const bytes: Buffer[] = [];
  const stage = {
    async write(value: Buffer) { bytes.push(value); return String(bytes.length - 1); },
    async publish(name: string, destination: Directory, leaf: string) {
      if (leaf === "matrix.json" && window === "manifest") { entered.resolve(); await released.promise; }
      if (fail && leaf === "matrix.json") throw new Error("Publication failure");
      await writeFile(join(destination.path, leaf), bytes[Number(name)], { flag: "wx" });
    },
    release: vi.fn(async () => { if (window === "cleanup") { entered.resolve(); await released.promise; } }),
  };
  vi.mocked(filesystem.pinDirectory).mockImplementation(async path => new Directory(path) as unknown as Awaited<ReturnType<typeof filesystem.pinDirectory>>);
  vi.mocked(filesystem.readLimited).mockImplementation(async path => Buffer.from(path.endsWith("catalog.json") ? JSON.stringify({ version: 1, apps: [definition] }) : "icon"));
  vi.mocked(filesystem.readTemplate).mockImplementation(async () => new Map([["dist/index.html", Buffer.from("__MATRIX_APP_DEFINITION__")], ["index.html", Buffer.from("__MATRIX_APP_DEFINITION__")], ["src/definition.json", Buffer.from("{}")]]));
  vi.mocked(filesystem.createPrivateStage).mockResolvedValue(stage as unknown as Awaited<ReturnType<typeof filesystem.createPrivateStage>>);
  const app = new Hono(); registerFileRoutes(app, { homePath });
  return { homePath, app, service: createAppGalleryService({ homePath, catalogPath: "/catalog.json" }), entered, released, stage };
}
function json(body: unknown): RequestInit { return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }; }
it.each(["mkdir-open", "manifest", "cleanup"] as const)("owner rename/replacement waits through gallery %s window", async window => {
  const f = await fixture(window); const install = f.service.install("folio"); await f.entered.promise;
  let renamed = false, replaced = false;
  const rename = f.app.request("/api/files/rename", json({ from: "apps/folio", to: "apps/moved" })).then(response => { renamed = true; return response; });
  const replacement = f.app.request("/api/files/mkdir", json({ path: "apps/folio" })).then(response => { replaced = true; return response; });
  try {
    await setImmediate(); await setImmediate();
    expect(renamed).toBe(false); expect(replaced).toBe(false); expect(existsSync(join(f.homePath, "apps/moved"))).toBe(false);
  } finally { f.released.resolve(); await Promise.allSettled([install, rename, replacement]); }
  expect(await install).toMatchObject({ status: "installed" });
  expect((await rename).status).toBe(200); expect((await replacement).status).toBe(200);
  expect(JSON.parse(await readFile(join(f.homePath, "apps/moved/matrix.json"), "utf8")).slug).toBe("folio");
  expect(existsSync(join(f.homePath, "apps/folio/matrix.json"))).toBe(false);
});
it("failure holds coordination through cleanup and then releases it", async () => {
  const f = await fixture("cleanup", true), install = f.service.install("folio").catch(error => error); await f.entered.promise;
  let mutated = false;
  const mutation = f.app.request("/api/files/rename", json({ from: "apps/folio", to: "apps/failed" })).then(response => { mutated = true; return response; });
  try { await setImmediate(); expect(mutated).toBe(false); } finally { f.released.resolve(); }
  expect(await install).toBeInstanceOf(Error); expect((await mutation).status).toBe(200); expect(f.stage.release).toHaveBeenCalledOnce();
  expect(existsSync(join(f.homePath, "apps/failed/matrix.json"))).toBe(false);
});
it.each([
  ["/api/files/mkdir", json({ path: "created" })], ["/api/files/touch", json({ path: "new.txt", content: "new" })],
  ["/api/files/duplicate", json({ path: "file.txt" })], ["/api/files/rename", json({ from: "file.txt", to: "renamed.txt" })],
  ["/api/files/copy", json({ from: "file.txt", to: "copy.txt" })], ["/api/files/delete", json({ path: "file.txt" })],
  ["/api/files/trash/restore", json({ trashPath: ".trash/old.txt" })], ["/api/files/trash/empty", json({})],
  ["/files/owner.txt", { method: "PUT", body: "owner text" }],
  ["/api/files/blob?path=upload.txt", { method: "PUT", body: "binary bytes" }],
  ["/api/files/blob?path=temporary/desktop-chat/attachment.txt", { method: "DELETE" }],
])("every registered owner mutation waits: %s", async (url, init) => {
  const homePath = await home(); await writeFile(join(homePath, "file.txt"), "original");
  await mkdir(join(homePath, ".trash")); await writeFile(join(homePath, ".trash/old.txt"), "old");
  await writeFile(join(homePath, ".trash/.manifest.json"), JSON.stringify([{ name: "old.txt", originalPath: "old.txt", deletedAt: new Date(0).toISOString(), trashPath: ".trash/old.txt" }]));
  const entered = deferred(), released = deferred();
  const hold = withOwnerFileMutation(homePath, async () => { entered.resolve(); await released.promise; }); await entered.promise;
  const app = new Hono(); registerFileRoutes(app, { homePath });
  let settled = false; const response = app.request(url, init).then(response => { settled = true; return response; });
  try {
    await setImmediate(); await setImmediate(); expect(settled).toBe(false);
    expect((await app.request("/api/files/stat?path=file.txt")).status).toBe(200);
    expect((await app.request("/api/files/mkdir", { method: "BOGUS" })).status).toBe(404);
  } finally { released.resolve(); await hold; await response; }
  expect((await response).status).toBe(200);
});
it("coordinates resolved home aliases, releases failures, and isolates other homes", async () => {
  const homePath = await home(), entered = deferred(), released = deferred(), order: string[] = [];
  const first = withOwnerFileMutation(homePath, async () => { entered.resolve(); await released.promise; throw new Error("failure"); }).catch(error => error); await entered.promise;
  const second = withOwnerFileMutation(join(homePath, "child/.."), async () => { order.push("second"); });
  await withOwnerFileMutation(resolve(homePath, "../other-owner"), async () => { order.push("other"); });
  expect(order).toEqual(["other"]); released.resolve(); expect(await first).toBeInstanceOf(Error); await second;
  expect(order).toEqual(["other", "second"]); await expect(withOwnerFileMutation(homePath, async () => "available")).resolves.toBe("available");
});
it("caps 32 pending operations per home and returns a safe File API 503, then drains capacity", async () => {
  const homePath = await home(), entered = deferred(), released = deferred();
  const first = withOwnerFileMutation(homePath, async () => { entered.resolve(); await released.promise; }); await entered.promise;
  const pending = Array.from({ length: 32 }, () => withOwnerFileMutation(homePath, async () => {}));
  const app = new Hono(); registerFileRoutes(app, { homePath });
  try {
    const response = await app.request("/api/files/mkdir", json({ path: "private-path" }));
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "File service unavailable" });
    expect(existsSync(join(homePath, "private-path"))).toBe(false);
  } finally { released.resolve(); await Promise.all([first, ...pending]); }
  expect((await app.request("/api/files/mkdir", json({ path: "after-drain" }))).status).toBe(200);
});
it("caps 64 active home keys without evicting holders and deletes keys after settlement", async () => {
  const base = await home(), released = deferred(), entered: Promise<void>[] = [];
  const holds = Array.from({ length: 64 }, (_, index) => {
    const started = deferred(); entered.push(started.promise);
    return withOwnerFileMutation(join(base, String(index)), async () => { started.resolve(); await released.promise; });
  });
  await Promise.all(entered);
  try { await expect(withOwnerFileMutation(join(base, "overflow"), async () => {})).rejects.toMatchObject({ status: 503 }); }
  finally { released.resolve(); await Promise.all(holds); }
  await expect(withOwnerFileMutation(join(base, "overflow"), async () => "released")).resolves.toBe("released");
});

it.skipIf(process.platform !== "linux")("holds the actual Linux mkdir-to-open interval against the owner rename API", async () => {
  const f = await fixture("manifest");
  const actual = await vi.importActual<typeof import("../../packages/gateway/src/app-gallery/filesystem.js")>("../../packages/gateway/src/app-gallery/filesystem.js");
  vi.mocked(filesystem.pinDirectory).mockImplementation(actual.pinDirectory);
  vi.mocked(filesystem.createPrivateStage).mockImplementation(actual.createPrivateStage);
  const entered = deferred(), released = deferred(), child = PinnedDirectory.prototype.child;
  vi.spyOn(PinnedDirectory.prototype, "child").mockImplementation(async function (this: PinnedDirectory, name: string) {
    if (name === "folio" && existsSync(`${this.path}/${name}`)) { entered.resolve(); await released.promise; }
    return child.call(this, name);
  });
  const install = f.service.install("folio"); await entered.promise;
  let renamed = false;
  const rename = f.app.request("/api/files/rename", json({ from: "apps/folio", to: "apps/moved" })).then(response => { renamed = true; return response; });
  try { await setImmediate(); expect(renamed).toBe(false); }
  finally { released.resolve(); await Promise.allSettled([install, rename]); }
  expect(await install).toMatchObject({ status: "installed" }); expect((await rename).status).toBe(200);
  expect(JSON.parse(await readFile(join(f.homePath, "apps/moved/matrix.json"), "utf8")).slug).toBe("folio");
});
it("retains body limits and releases a rejected request before subsequent writes", async () => {
  const homePath = await home(), app = new Hono(); registerFileRoutes(app, { homePath });
  const response = await app.request("/files/oversized.txt", { method: "PUT", body: "x".repeat(10 * 1024 * 1024 + 1) });
  expect(response.status).toBe(413); expect(existsSync(join(homePath, "oversized.txt"))).toBe(false);
  expect((await app.request("/files/valid.txt", { method: "PUT", body: "valid" })).status).toBe(200);
});
it("an admitted File API write blocks the installer before its first owner-directory access", async () => {
  const f = await fixture("manifest"), entered = deferred(), released = deferred(), app = new Hono();
  registerFileRoutes(app, {
    homePath: f.homePath, getOwnerId: () => "owner",
    projectPathAdmission: {
      async withPaths(_input, operation) { entered.resolve(); await released.promise; return operation(); },
      async withStoredPaths(_input, operation) { return operation(); },
    },
  });
  const write = app.request("/api/files/touch", json({ path: "owner.txt", content: "owner" })); await entered.promise;
  const install = f.service.install("folio");
  try {
    await setImmediate(); expect(filesystem.pinDirectory).not.toHaveBeenCalled(); expect(existsSync(join(f.homePath, "apps/folio"))).toBe(false);
  } finally { released.resolve(); f.released.resolve(); await Promise.allSettled([write, install]); }
  expect((await write).status).toBe(200); expect(await install).toMatchObject({ status: "installed" });
});
