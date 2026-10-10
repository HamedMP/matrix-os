import { afterEach, expect, it, vi } from "vitest";
import * as filesystem from "../../packages/gateway/src/app-gallery/filesystem.js";
import { indexOwnerApps, readOwnerManifest } from "../../packages/gateway/src/app-gallery/owner-index.js";
import { GalleryFileError, type PinnedDirectory } from "../../packages/gateway/src/app-gallery/pinned-directory.js";
import { createAppGalleryService } from "../../packages/gateway/src/app-gallery/service.js";

vi.mock("../../packages/gateway/src/app-gallery/filesystem.js", async original => ({
  ...await original<typeof import("../../packages/gateway/src/app-gallery/filesystem.js")>(),
  pinDirectory: vi.fn(), readLimited: vi.fn(), readTemplate: vi.fn(), createPrivateStage: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

const definition = { id: "folio", name: "Folio", collection: "personal", category: "Finance", description: "A ledger", tagline: "Your spending", icon: "wallet", accent: "forest", view: "finance", entity: "Expense", fields: [{ key: "amount", label: "Amount", kind: "money" }], services: [], importGoal: "Extract receipts", highlights: ["Currency totals"] };
const error = (code: string) => Object.assign(new Error("Filesystem error"), { code });
function setup(code = "ENOTDIR") {
  const apps = { entries: async function* () {}, child: vi.fn().mockRejectedValue(error(code)), createChild: vi.fn().mockRejectedValue(error("EEXIST")), close: vi.fn() };
  const owner = { child: vi.fn().mockResolvedValue(apps), close: vi.fn() };
  const stage = { write: vi.fn().mockResolvedValue("private-file"), publish: vi.fn(), release: vi.fn() };
  vi.mocked(filesystem.pinDirectory).mockResolvedValue(owner as unknown as Awaited<ReturnType<typeof filesystem.pinDirectory>>);
  vi.mocked(filesystem.readLimited).mockImplementation(async path => Buffer.from(path.endsWith("catalog.json") ? JSON.stringify({ version: 1, apps: [definition, { ...definition, id: "focus", name: "Focus" }] }) : "icon"));
  apps.child.mockImplementation(async id => { throw error(id === "folio" ? code : "ENOENT"); });
  vi.mocked(filesystem.readTemplate).mockResolvedValue(new Map([["dist/index.html", Buffer.from('<script type="application/json" id="matrix-app-definition">__MATRIX_APP_DEFINITION__</script>')], ["index.html", Buffer.from("__MATRIX_APP_DEFINITION__")], ["src/definition.json", Buffer.from("{}")]]));
  vi.mocked(filesystem.createPrivateStage).mockResolvedValue(stage as unknown as Awaited<ReturnType<typeof filesystem.createPrivateStage>>);
  return { apps, owner, stage, service: createAppGalleryService({ homePath: "/owner", catalogPath: "/catalog.json" }) };
}
it("a nondirectory app does not hide the rest of the Gallery", async () => {
  const { owner, apps, service } = setup();
  await expect(service.list()).resolves.toMatchObject([{ id: "folio", installed: false }, { id: "focus", installed: false }]);
  expect(owner.close).toHaveBeenCalledOnce(); expect(apps.close).toHaveBeenCalledOnce();
});
it("installation reports a conflict without publishing over the owner file", async () => {
  const { stage, service } = setup();
  await expect(service.install("folio")).rejects.toMatchObject({ status: 409 });
  expect(stage.publish).not.toHaveBeenCalled(); expect(stage.release).toHaveBeenCalledOnce();
});
it("unexpected filesystem failures remain errors", async () => {
  await expect(setup("EIO").service.list()).rejects.toMatchObject({ code: "EIO" });
});

it("bounds index enumeration and closes the directory iterator when the budget is exceeded", async () => {
  let closed = false;
  const apps = { async *entries() { try { for(let i=0;i<16_385;i++) yield { name: String(i), isDirectory: () => false }; } finally { closed = true; } } };
  await expect(indexOwnerApps(apps as unknown as PinnedDirectory)).resolves.toMatchObject({ unavailable: true });
  expect(closed).toBe(true);
});
it("bounds owner directories while closing already admitted handles", async () => {
  const close = vi.fn();
  const apps = {
    async *entries() { for(let i=0;i<513;i++) yield { name: String(i), isDirectory: () => true }; },
    async child() { return { readFile: async () => { throw error("ENOENT"); }, async *entries() {}, close }; },
  };
  await expect(indexOwnerApps(apps as unknown as PinnedDirectory)).resolves.toMatchObject({ unavailable: true });
  expect(close).toHaveBeenCalledTimes(512);
});
it("shares runtime discovery exclusions without reading dependency folders", async () => {
  const child = vi.fn();
  const apps = { async *entries() { for(const name of ["node_modules",".git","dist",".next",".cache",".vite","_template-next","_template-vite"]) yield { name, isDirectory: () => true }; }, child };
  const index = await indexOwnerApps(apps as unknown as PinnedDirectory);
  expect(index.entries.size).toBe(0); expect(child).not.toHaveBeenCalled();
});
it("isolates only typed bounded-file rejection while retaining unexpected failures", async () => {
  const readFile = vi.fn().mockRejectedValue(new GalleryFileError("Invalid file"));
  await expect(readOwnerManifest({readFile} as unknown as PinnedDirectory)).resolves.toEqual({manifest:null,unavailable:true});
  readFile.mockRejectedValue(new filesystem.GalleryError(503,"Unexpected directory failure"));
  await expect(readOwnerManifest({readFile} as unknown as PinnedDirectory)).rejects.toThrow("Unexpected directory failure");
});

it.each(["ELOOP", "EACCES", "EPERM"])("an inaccessible owner manifest (%s) is unavailable rather than fatal", async code => {
  const readFile = vi.fn().mockRejectedValue(error(code));
  await expect(readOwnerManifest({ readFile } as unknown as PinnedDirectory)).resolves.toEqual({ manifest: null, unavailable: true });
});
it.each(["ELOOP", "EACCES", "EPERM"])("an inaccessible child folder (%s) keeps listing usable and installation closed", async code => {
  const { apps, service, stage } = setup();
  apps.entries = async function* () { yield { name: "custom", isDirectory: () => true } as never; };
  apps.child.mockImplementation(async name => { throw error(name === "custom" ? code : "ENOENT"); });
  await expect(service.list()).resolves.toMatchObject([{ id: "folio", installed: false }, { id: "focus", installed: false }]);
  await expect(service.install("folio")).rejects.toMatchObject({ status: 409 });
  expect(stage.publish).not.toHaveBeenCalled();
});
it.each(["EACCES", "EPERM"])("unreadable enumeration (%s) closes admitted handles and keeps identity unavailable", async code => {
  const close = vi.fn();
  const apps = {
    async *entries() { yield { name: "custom", isDirectory: () => true }; },
    async child() { return { readFile: async () => { throw error("ENOENT"); }, async *entries() { throw error(code); }, close }; },
  };
  await expect(indexOwnerApps(apps as unknown as PinnedDirectory)).resolves.toMatchObject({ unavailable: true });
  expect(close).toHaveBeenCalledOnce();
});
it.each(["ELOOP", "EACCES", "EPERM"])("an inaccessible catalog destination (%s) does not hide other entries", async code => {
  await expect(setup(code).service.list()).resolves.toMatchObject([{ id: "folio", installed: false }, { id: "focus", installed: false }]);
});
it("unexpected manifest and child-folder I/O failures remain errors", async () => {
  await expect(readOwnerManifest({ readFile: async () => { throw error("EIO"); } } as unknown as PinnedDirectory)).rejects.toMatchObject({ code: "EIO" });
  const apps = { async *entries() { yield { name: "custom", isDirectory: () => true }; }, async child() { throw error("EIO"); } };
  await expect(indexOwnerApps(apps as unknown as PinnedDirectory)).rejects.toMatchObject({ code: "EIO" });
});


it.each(["entries", "directories", "depth"])("keeps Gallery visible and new installs closed when owner %s exhaust its budget", async budget => {
  const { apps, service, stage } = setup();
  if (budget === "entries") apps.entries = async function* () { for (let i = 0; i < 16_385; i++) yield { name: String(i), isDirectory: () => false } as never; };
  else if (budget === "directories") apps.entries = async function* () { for (let i = 0; i < 513; i++) yield { name: String(i), isDirectory: () => true } as never; };
  else {
    const nested = (depth: number): unknown => ({ readFile: async () => { throw error("ENOENT"); }, async *entries() { if (depth < 18) yield { name: "source", isDirectory: () => true }; }, child: async () => nested(depth + 1), close: vi.fn() });
    apps.entries = async function* () { yield { name: "custom", isDirectory: () => true } as never; };
    apps.child.mockImplementation(async name => { if (name !== "custom") throw error("ENOENT"); return nested(1); });
  }
  await expect(service.list()).resolves.toMatchObject([{ id: "folio", installed: false }, { id: "focus", installed: false }]);
  await expect(service.install("focus")).rejects.toMatchObject({ status: 409 });
  expect(stage.publish).not.toHaveBeenCalled();
});

it("closes all admitted nested owner handles when maximum depth is reached", async () => {
  const close = vi.fn();
  const nested = (depth: number): unknown => ({ readFile: async () => { throw error("ENOENT"); }, async *entries() { if (depth < 18) yield { name: "source", isDirectory: () => true }; }, child: async () => nested(depth + 1), close });
  const result = await indexOwnerApps(nested(0) as PinnedDirectory);
  expect(result.unavailable).toBe(true);
  expect(close).toHaveBeenCalledTimes(16);
});
