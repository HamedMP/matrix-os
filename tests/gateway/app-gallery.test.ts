import assert from "node:assert/strict";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, it } from "vitest";
import { createAppGalleryService } from "../../packages/gateway/src/app-gallery/service.js";
import { registerAppGalleryRoutes } from "../../packages/gateway/src/app-gallery/routes.js";
import { createPrivateStage, PrivateStage, readLimited, readTemplate, DEFAULT_LIMITS, pinDirectory } from "../../packages/gateway/src/app-gallery/filesystem.js";
import { PinnedDirectory } from "../../packages/gateway/src/app-gallery/pinned-directory.js";
import { markAuthContextReady, setPlatformVerifiedPrincipal } from "../../packages/gateway/src/request-principal.js";

let root: string, homePath: string, catalogPath: string, templatePath: string;
const definition = { id: "folio", name: "Folio", collection: "personal", category: "Finance", description: "A ledger", tagline: "Your spending", icon: "wallet", accent: "forest", view: "finance", entity: "Expense", fields: [{ key: "amount", label: "Amount", kind: "money" }], services: [], importGoal: "Extract receipts", highlights: ["Currency totals"] };
const placeholder = "__MATRIX_APP_DEFINITION__";
const restorers: (() => void)[] = []; // At most3 patches per test, reset after each test.
function patch<T extends object, K extends keyof T>(target: T, key: K, replacement: (original: T[K]) => T[K]) {
  const original = target[key]; target[key] = replacement(original); restorers.push(() => { target[key] = original; });
}
function service(options = {}) { return createAppGalleryService({ homePath, catalogPath, templatePath, ...options }); }
function app(userId: string | null = "owner") {
  const app = new Hono();
  app.use("*", async (c, next) => { markAuthContextReady(c); if (userId) setPlatformVerifiedPrincipal(c, userId); await next(); });
  registerAppGalleryRoutes(app, { homePath, catalogPath, templatePath, ownerIds: ["owner"] }); return app;
}
const stageRoot = () => join(homePath, "data/app-gallery-staging");
const target = (name: string) => join(homePath, "apps/folio", name);
async function absent(path: string) { await assert.rejects(readFile(path), { code: "ENOENT" }); }
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "matrix-gallery-"));
  homePath = join(root, "home"); catalogPath = join(root, "catalog.json"); templatePath = join(root, "starter");
  await mkdir(homePath); await mkdir(join(templatePath, "dist"), { recursive: true }); await mkdir(join(templatePath, "src"));
  await writeFile(catalogPath, JSON.stringify({ version: 1, apps: [definition] }));
  await writeFile(join(templatePath, "dist/index.html"), `<script type="application/json" id="matrix-app-definition">${placeholder}</script>`);
  await writeFile(join(templatePath, "index.html"), `<script>${placeholder}</script>`);
  await writeFile(join(templatePath, "src/definition.json"), "{}");
  await writeFile(join(templatePath, "package.json"), '{"scripts":{"build":"vite build"}}');
});
afterEach(async () => { for (const restore of restorers.reverse()) restore(); restorers.length = 0; await rm(root, { recursive: true, force: true }); });

describe.skipIf(process.platform !== "linux")("Linux descriptor-anchored gallery", () => {
  it("lists without creating owner state", async () => {
    assert.deepEqual(await service().list(), [{ ...definition, installed: false }]); assert.deepEqual(await readdir(homePath), []);
  });
  it("installs source, built assets, definition and personal Postgres manifest", async () => {
    assert.deepEqual(await service().install("folio"), { status: "installed", slug: "folio", name: "Folio", path: "apps/folio" });
    const manifest = JSON.parse(await readFile(target("matrix.json"), "utf8"));
    assert.equal(manifest.runtime, "vite"); assert.equal(manifest.scope, "personal"); assert.equal(manifest.listingTrust, "first_party"); assert.equal(manifest.database, "postgres");
    assert.deepEqual(manifest.storage.tables.records.columns, { payload: "jsonb", source_id: "text" });
    assert.deepEqual(JSON.parse(await readFile(target("src/definition.json"), "utf8")), definition);
    assert(!String(await readFile(target("dist/index.html"))).includes(placeholder));
    assert.equal(await readFile(target("index.html"), "utf8"), `<script>${placeholder}</script>`); assert.deepEqual(await readdir(stageRoot()), []);
    assert.equal((await service().list())[0].launchPath, "apps/folio");
  });
  it("preserves custom names and owner edits", async () => {
    await service().install("folio"); const manifest = JSON.parse(await readFile(target("matrix.json"), "utf8")); manifest.name = "My Folio";
    await writeFile(target("matrix.json"), JSON.stringify(manifest)); await writeFile(target("src/definition.json"), "owner data");
    assert.equal((await service().install("folio")).name, "My Folio"); assert.equal(await readFile(target("src/definition.json"), "utf8"), "owner data");
  });
  it("serializes duplicate clicks", async () => {
    const installer = service(); const results = await Promise.all([installer.install("folio"), installer.install("folio")]);
    assert.deepEqual(results.map(row => row.status).sort(), ["already_installed", "installed"]);
  });
  it("handles independent concurrent installer instances exclusively", async () => {
    const results = await Promise.allSettled([service().install("folio"), service().install("folio")]);
    assert(results.some(result => result.status === "fulfilled")); assert.equal(JSON.parse(await readFile(target("matrix.json"), "utf8")).slug, "folio");
  });
  it("leaves incomplete owner folders unchanged", async () => {
    await mkdir(target("."), { recursive: true }); await writeFile(target("notes.txt"), "keep");
    await assert.rejects(service().install("folio"), { status: 409 }); assert.equal(await readFile(target("notes.txt"), "utf8"), "keep");
    assert.equal((await service().list())[0].installed, false);
  });
  it("rejects mismatched manifest slugs", async () => {
    await service().install("folio"); const manifest = JSON.parse(await readFile(target("matrix.json"), "utf8")); manifest.slug = "different";
    await writeFile(target("matrix.json"), JSON.stringify(manifest)); assert.equal((await service().list())[0].installed, false); await assert.rejects(service().install("folio"), { status: 409 });
  });
  for (const invalid of ["{}", "bad json"]) it(`rejects owner manifest ${invalid}`, async () => {
    await mkdir(target("."), { recursive: true }); await writeFile(target("matrix.json"), invalid); assert.equal((await service().list())[0].installed, false);
  });
  for (const id of ["../escape", "INVALID", "missing"]) it(`rejects id ${id}`, async () => { await assert.rejects(service().install(id), { status: id === "missing" ? 404 : 400 }); });
  for (const key of ["maxFileBytes", "maxTotalBytes", "maxCatalogBytes", "maxFiles", "maxEntries"]) it(`enforces ${key}`, async () => {
    await assert.rejects(service({ limits: { [key]: 1 } }).install("folio")); assert.deepEqual(await readdir(homePath), []);
  });
  it("rechecks size after definition injection", async () => { await assert.rejects(service({ limits: { maxFileBytes: 150 } }).install("folio"), /Injected template size limit/); });
  it("rejects excessive directory nesting", async () => { await mkdir(join(templatePath, ...Array.from({ length: 18 }, () => "deep")), { recursive: true }); await assert.rejects(service().install("folio"), /nesting/); });
  for (const location of ["catalog", "template", "home", "apps", "destination", "asset"]) it(`rejects static ${location} symlink`, async () => {
    const outside = join(root, "outside"); await mkdir(outside);
    if (location === "catalog") { await rename(catalogPath, join(root, "catalog-source")); await symlink(join(root, "catalog-source"), catalogPath); }
    if (location === "template") { await rename(templatePath, join(root, "starter-source")); await symlink(join(root, "starter-source"), templatePath); }
    if (location === "home") { await rename(homePath, join(root, "home-source")); await symlink(join(root, "home-source"), homePath); }
    if (location === "apps") await symlink(outside, join(homePath, "apps"));
    if (location === "destination") { await mkdir(join(homePath, "apps")); await symlink(outside, target(".")); }
    if (location === "asset") await symlink(catalogPath, join(templatePath, "src/link"));
    await assert.rejects(service().install("folio")); assert.deepEqual(await readdir(outside), []);
  });
  it("rejects nested runtime manifests", async () => { await writeFile(join(templatePath, "src/matrix.json"), "{}"); await assert.rejects(readTemplate(templatePath, DEFAULT_LIMITS), /Nested/); });
  for (const content of ["missing", placeholder + placeholder]) it(`rejects built boundary ${content}`, async () => { await writeFile(join(templatePath, "dist/index.html"), content); await assert.rejects(service().install("folio")); });
  for (const content of ["missing", placeholder + placeholder]) it(`rejects source boundary ${content}`, async () => { await writeFile(join(templatePath, "index.html"), content); await assert.rejects(service().install("folio")); });
  it("escapes HTML-sensitive definitions", async () => {
    await writeFile(catalogPath, JSON.stringify({ version: 1, apps: [{ ...definition, description: "</script>\u2028text" }] })); await service().install("folio");
    const html = await readFile(target("dist/index.html"), "utf8"); assert(html.includes("\\u003c")); assert(html.includes("\\u2028"));
  });
  it("keeps Business installs personal", async () => { await writeFile(catalogPath, JSON.stringify({ version: 1, apps: [{ ...definition, collection: "business" }] })); await service().install("folio"); assert.equal(JSON.parse(await readFile(target("matrix.json"), "utf8")).scope, "personal"); });
  it("publishes manifest last", async () => {
    patch(PrivateStage.prototype, "publish", original => async function(this: PrivateStage, name, destination, filename) {
      if (filename === "matrix.json") { await absent(target("matrix.json")); assert.deepEqual(JSON.parse(await readFile(target("src/definition.json"), "utf8")), definition); }
      return original.call(this, name, destination, filename);
    }); await service().install("folio");
  });
  it("retains visible files and owner replacement when publication fails", async () => {
    patch(PrivateStage.prototype, "publish", original => async function(this: PrivateStage, name, destination, filename) {
      if (filename === "matrix.json") { await rename(target("index.html"), target("old-index")); await writeFile(target("index.html"), "owner replacement"); throw new Error("publication failed"); }
      return original.call(this, name, destination, filename);
    }); await assert.rejects(service().install("folio"), /publication failed/);
    assert.equal(await readFile(target("index.html"), "utf8"), "owner replacement"); await absent(target("matrix.json")); assert.deepEqual(await readdir(stageRoot()), []);
  });
  it("does not delete a visible replacement during awaited private cleanup", async () => {
    patch(PrivateStage.prototype, "release", original => async function(this: PrivateStage) {
      await rename(target("index.html"), target("original-index")); await writeFile(target("index.html"), "owner replacement"); return original.call(this);
    }); await service().install("folio"); assert.equal(await readFile(target("index.html"), "utf8"), "owner replacement");
  });
  it("cleans partial private writes before any visible folder exists", async () => {
    patch(PinnedDirectory.prototype, "openFile", original => async function(this: PinnedDirectory, name, flags) {
      const handle = await original.call(this, name, flags);
      if (flags & constants.O_EXCL) {
        const write = handle.write.bind(handle); let calls = 0;
        handle.write = (async () => { if (calls++ === 0) return write(Buffer.from("abc"), 0, 3, 0); throw new Error("partial write failed"); }) as unknown as typeof handle.write;
      } return handle;
    }); await assert.rejects(service().install("folio"), /partial write failed/); await absent(join(homePath, "apps")); assert.deepEqual(await readdir(stageRoot()), []);
  });
  it("rejects writes with no progress and releases private slot", async () => {
    patch(PinnedDirectory.prototype, "openFile", original => async function(this: PinnedDirectory, name, flags) { const handle = await original.call(this, name, flags); if (flags & constants.O_EXCL) handle.write = (async () => ({ bytesWritten: 0, buffer: "" })) as unknown as typeof handle.write; return handle; });
    await assert.rejects(service().install("folio"), /no progress/); assert.deepEqual(await readdir(stageRoot()), []);
  });
  it("anchors writes when an ancestor becomes an outside symlink", async () => {
    const directory = join(homePath, "safe"); const moved = join(homePath, "moved"); const outside = join(root, "outside"); await mkdir(directory); await mkdir(outside);
    const pinned = await pinDirectory(directory);
    try {
      await rename(directory, moved); await symlink(outside, directory);
      const file = await pinned.openFile("owned", constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY); try { await file.writeFile("safe"); } finally { await file.close(); }
      assert.equal(await readFile(join(moved, "owned"), "utf8"), "safe"); assert.deepEqual(await readdir(outside), []);
    } finally { await pinned.close(); }
  });
  it("rejects an ancestor symlink swapped during descriptor traversal", async () => {
    const victim = join(homePath, "victim"); const outside = join(root, "outside"); await mkdir(victim); await mkdir(outside);
    patch(PinnedDirectory.prototype, "child", original => async function(this: PinnedDirectory, name) { if (name === "victim") { await rename(victim, join(homePath, "previous")); await symlink(outside, victim); } return original.call(this, name); });
    await assert.rejects(pinDirectory(victim)); assert.deepEqual(await readdir(outside), []);
  });
  it("anchors traversal when a pinned intermediate ancestor is swapped", async () => {
    const victim = join(homePath, "victim"), moved = join(homePath, "original"), outside = join(root, "outside");
    await mkdir(join(victim, "child"), { recursive: true }); await mkdir(join(outside, "child"), { recursive: true });
    await writeFile(join(victim, "child/message"), "authorized"); await writeFile(join(outside, "child/message"), "outside secret");
    patch(PinnedDirectory.prototype, "child", original => async function(this: PinnedDirectory, name) {
      if (name === "child") { await rename(victim, moved); await symlink(outside, victim); }
      return original.call(this, name);
    });
    const pinned = await pinDirectory(join(victim, "child"));
    try { assert.equal(String(await pinned.readFile("message", 100)), "authorized"); } finally { await pinned.close(); }
  });
  it("anchors reads when the parent is swapped after pinning", async () => {
    const directory = join(homePath, "safe"); const outside = join(root, "outside"); await mkdir(directory); await mkdir(outside); await writeFile(join(directory, "message"), "authorized"); await writeFile(join(outside, "message"), "outside secret");
    patch(PinnedDirectory.prototype, "openFile", original => async function(this: PinnedDirectory, name, flags) { if (name === "message") { await rename(directory, join(homePath, "moved")); await symlink(outside, directory); } return original.call(this, name, flags); });
    assert.equal(String(await readLimited(join(directory, "message"), 100)), "authorized");
  });
  it("preserves a destination folder replacement and withholds manifest", async () => {
    let swapped = false;
    patch(PrivateStage.prototype, "publish", original => async function(this: PrivateStage, name, directory, filename) {
      await original.call(this, name, directory, filename);
      if (!swapped) { swapped = true; await rename(target("."), join(homePath, "apps/moved")); await mkdir(target(".")); await writeFile(target("owner"), "keep"); }
    }); await assert.rejects(service().install("folio"), { status: 409 }); assert.equal(await readFile(target("owner"), "utf8"), "keep"); await absent(target("matrix.json"));
  });
  it("preserves a changed apps root and withholds manifest", async () => {
    let swapped = false;
    patch(PrivateStage.prototype, "publish", original => async function(this: PrivateStage, name, directory, filename) { await original.call(this, name, directory, filename); if (!swapped) { swapped = true; await rename(join(homePath, "apps"), join(homePath, "previous-apps")); await mkdir(join(homePath, "apps")); } });
    await assert.rejects(service().install("folio"), { status: 409 }); assert.deepEqual(await readdir(join(homePath, "apps")), []);
  });
  it("rejects a replaced asset directory before manifest publication", async () => {
    patch(PrivateStage.prototype, "publish", original => async function(this: PrivateStage, name, directory, filename) { await original.call(this, name, directory, filename); if (filename === "definition.json") { await rename(target("src"), target("previous-src")); await mkdir(target("src")); } });
    await assert.rejects(service().install("folio"), { status: 409 }); await absent(target("matrix.json"));
  });
  it("bounds abandoned staging with four exclusive slots", async () => {
    const owner = await pinDirectory(homePath); const stages: PrivateStage[] = [];
    try { for (let index = 0; index < 4; index++) stages.push(await createPrivateStage(owner)); await assert.rejects(createPrivateStage(owner), /requires recovery/); }
    finally { for (const stage of stages) await stage.release(); await owner.close(); }
    assert.deepEqual(await readdir(stageRoot()), []);
  });
  it("rejects publicly readable pre-existing private staging", async () => {
    await mkdir(stageRoot(), { recursive: true }); await chmod(stageRoot(), 0o755); await assert.rejects(service().install("folio"), /permissions/); await absent(join(homePath, "apps"));
  });
  it("retains unknown private recovery files instead of deleting recursively", async () => {
    const owner = await pinDirectory(homePath); const stage = await createPrivateStage(owner);
    const handle = await stage.directory.openFile("unknown", constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY); await handle.close();
    await stage.release(); await owner.close(); assert.deepEqual(await readdir(join(stageRoot(), "slot-0")), ["unknown"]);
  });
  it("enforces bounded reads", async () => { await assert.rejects(readLimited(catalogPath, 10), /Invalid file/); });
  it("rejects malformed catalogs", async () => { await writeFile(catalogPath, '{"version":1,"apps":[]}'); await assert.rejects(service().list()); });
  it("installs through authenticated Hono and returns canonical paths", async () => {
    assert.equal((await app().request("/api/app-gallery")).status, 200); const response = await app().request("/api/app-gallery/folio/install", { method: "POST", body: "{}" }); assert.equal(response.status, 201); assert.equal((await response.json()).path, "apps/folio");
    assert.equal((await app().request("/api/app-gallery/folio/install", { method: "POST", body: "{}" })).status, 200);
  });
});

describe("gallery boundaries on every host", () => {
  it("denies anonymous callers before touching an unavailable catalog", async () => { await rm(catalogPath); assert.equal((await app(null).request("/api/app-gallery")).status, 401); });
  it("denies non-owner installation before filesystem access", async () => { await rm(catalogPath); assert.equal((await app("other").request("/api/app-gallery/folio/install", { method: "POST", body: "{}" })).status, 403); assert.deepEqual(await readdir(homePath), []); });
  for (const body of ["{", '{"templatePath":"/tmp"}', '{"url":"https://example.com"}']) it(`rejects unsafe body ${body}`, async () => { assert.equal((await app().request("/api/app-gallery/folio/install", { method: "POST", body })).status, 400); });
  it("bounds streamed bodies", async () => { assert.equal((await app().request("/api/app-gallery/folio/install", { method: "POST", body: " ".repeat(5000) })).status, 413); });
  it("bounds Content-Length bodies", async () => { assert.equal((await app().request("/api/app-gallery/folio/install", { method: "POST", headers: { "content-length": "5000" }, body: "{}" })).status, 413); });
  it.skipIf(process.platform === "linux")("explicitly fails closed without Linux directory capabilities", async () => { await assert.rejects(service().install("folio"), { status: 503 }); assert.deepEqual(await readdir(homePath), []); const response = await app().request("/api/app-gallery"); assert.equal(response.status, 503); assert(!String(await response.text()).includes(homePath)); });
  it("resolves compiled imports through the actual source package export", async () => {
    const source = await readFile(new URL("../../packages/gateway/src/app-gallery/service.ts", import.meta.url), "utf8");
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true } }).outputText;
    const contractImport = output.match(/import \{ AppGalleryCatalogSchema \} from "([^"]+)"/); assert.equal(contractImport?.[1], "@matrix-os/contracts/app-gallery");
    const contracts = fileURLToPath(new URL("../../packages/contracts/", import.meta.url)); const packageJson = JSON.parse(await readFile(join(contracts, "package.json"), "utf8"));
    const runtime = join(root, "runtime"); await mkdir(join(runtime, "node_modules/@matrix-os"), { recursive: true }); await symlink(contracts, join(runtime, "node_modules/@matrix-os/contracts"));
    const probe = join(runtime, "compiled-import.mjs"); await writeFile(probe, `import {AppGalleryCatalogSchema} from ${JSON.stringify(contractImport?.[1])}; console.log(JSON.stringify({url:import.meta.resolve(${JSON.stringify(contractImport?.[1])}),version:AppGalleryCatalogSchema.parse(${JSON.stringify({ version: 1, apps: [definition] })}).version}));`);
    const { stdout } = await promisify(execFile)(process.execPath, [probe], { timeout: 10_000 });
    assert.deepEqual(JSON.parse(stdout), { url: new URL(packageJson.exports["./app-gallery"], pathToFileURL(join(contracts, "package.json"))).href, version: 1 });
  });
});
