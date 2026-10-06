import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppGalleryService } from "../../packages/gateway/src/app-gallery/service.js";
import { registerAppGalleryRoutes } from "../../packages/gateway/src/app-gallery/routes.js";
import * as filesystem from "../../packages/gateway/src/app-gallery/filesystem.js";
import { markAuthContextReady, setPlatformVerifiedPrincipal } from "../../packages/gateway/src/request-principal.js";

vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

let root: string, homePath: string, catalogPath: string, templatePath: string;
const definition = { id: "folio", name: "Folio", collection: "personal", category: "Finance", description: "A ledger", tagline: "Your spending", icon: "wallet", accent: "forest", view: "finance", entity: "Expense", fields: [{ key: "amount", label: "Amount", kind: "money" }], services: [], importGoal: "Extract receipts", highlights: ["Currency totals"] };
const placeholder = "__MATRIX_APP_DEFINITION__";
function service(options = {}) { return createAppGalleryService({ homePath, catalogPath, templatePath, ...options }); }
function app(userId: string | null = "owner") {
  const app = new Hono();
  app.use("*", async (c, next) => { markAuthContextReady(c); if (userId) setPlatformVerifiedPrincipal(c, userId); await next(); });
  registerAppGalleryRoutes(app, { homePath, catalogPath, templatePath, ownerIds: ["owner"] });
  return app;
}
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
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("trusted gallery filesystem installation", () => {
  it("lists definitions without creating owner folders", async () => {
    expect(await service().list()).toEqual([{ ...definition, installed: false }]);
    expect(await readdir(homePath)).toEqual([]);
  });
  it("installs an empty personal Postgres Vite app and injects definition", async () => {
    expect(await service().install("folio")).toEqual({ status: "installed", slug: "folio", name: "Folio", path: "/apps/folio/" });
    const manifest = JSON.parse(await readFile(join(homePath, "apps/folio/matrix.json"), "utf8"));
    expect(manifest).toMatchObject({ scope: "personal", runtime: "vite", database: "postgres", listingTrust: "first_party", storage: { tables: { records: { columns: { payload: "jsonb", source_id: "text" } } } } });
    expect(JSON.parse(await readFile(join(homePath, "apps/folio/src/definition.json"), "utf8"))).toEqual(definition);
    expect(await readFile(join(homePath, "apps/folio/dist/index.html"), "utf8")).not.toContain(placeholder);
    expect(await service().list()).toMatchObject([{ installed: true, installedName: "Folio", launchPath: "/apps/folio/" }]);
  });
  it("preserves existing custom apps and returns their manifest name", async () => {
    await service().install("folio");
    const path = join(homePath, "apps/folio/matrix.json");
    const manifest = JSON.parse(await readFile(path, "utf8")); manifest.name = "My custom Folio";
    await writeFile(path, JSON.stringify(manifest));
    await writeFile(join(homePath, "apps/folio/src/definition.json"), "owner changes");
    expect(await service().install("folio")).toMatchObject({ status: "already_installed", name: "My custom Folio" });
    expect(await readFile(join(homePath, "apps/folio/src/definition.json"), "utf8")).toBe("owner changes");
  });
  it("serializes duplicate installs without replacing files", async () => {
    const installer = service();
    const results = await Promise.all([installer.install("folio"), installer.install("folio")]);
    expect(results.map(r => r.status).sort()).toEqual(["already_installed", "installed"]);
  });
  it("rejects unknown ids, invalid catalogs and symlink catalogs", async () => {
    await expect(service().install("../escape")).rejects.toMatchObject({ status: 400 });
    await expect(service().install("missing")).rejects.toMatchObject({ status: 404 });
    await writeFile(catalogPath, '{"version":1,"apps":[]}');
    await expect(service().list()).rejects.toThrow();
    await rm(catalogPath); await writeFile(join(root, "secret"), "{}"); await symlink(join(root, "secret"), catalogPath);
    await expect(service().list()).rejects.toThrow();
  });
  it("rejects symlinks in the template and owner destination", async () => {
    await symlink(join(root, "catalog.json"), join(templatePath, "src/link"));
    await expect(service().install("folio")).rejects.toThrow();
    expect(await readdir(homePath)).toEqual([]);
    await rm(join(templatePath, "src/link"));
    await symlink(templatePath, join(homePath, "apps"));
    await expect(service().install("folio")).rejects.toThrow();
  });
  it("never treats incomplete or invalid owner folders as installed", async () => {
    await mkdir(join(homePath, "apps/folio"), { recursive: true }); await writeFile(join(homePath, "apps/folio/notes.txt"), "keep");
    expect(await service().list()).toMatchObject([{ installed: false }]);
    await expect(service().install("folio")).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(homePath, "apps/folio/notes.txt"), "utf8")).toBe("keep");
  });
  it("validates byte and file caps and requires one built placeholder before mutation", async () => {
    await expect(service({ limits: { maxFileBytes: 10 } }).install("folio")).rejects.toThrow();
    await expect(service({ limits: { maxFiles: 1 } }).install("folio")).rejects.toThrow();
    await expect(service({ limits: { maxTotalBytes: 10 } }).install("folio")).rejects.toThrow();
    await writeFile(join(templatePath, "dist/index.html"), `${placeholder}${placeholder}`);
    await expect(service().install("folio")).rejects.toThrow();
    expect(await readdir(homePath)).toEqual([]);
  });
  it("publishes the manifest only after portable files are complete", async () => {
    const original = filesystem.publishManifest;
    const publish = vi.spyOn(filesystem, "publishManifest").mockImplementation(async (path, bytes) => {
      expect(await readdir(join(homePath, "apps/folio"))).not.toContain("matrix.json");
      expect(await readFile(join(homePath, "apps/folio/dist/index.html"), "utf8")).not.toContain(placeholder);
      expect(JSON.parse(await readFile(join(homePath, "apps/folio/src/definition.json"), "utf8"))).toEqual(definition);
      return original(path, bytes);
    });
    await service().install("folio"); expect(publish).toHaveBeenCalledOnce();
  });
  it("rolls back a failed installation while preserving concurrent owner edits", async () => {
    vi.spyOn(filesystem, "publishManifest").mockImplementation(async () => {
      await writeFile(join(homePath, "apps/folio/src/definition.json"), "owner edits");
      throw new Error("injected publication failure");
    });
    await expect(service().install("folio")).rejects.toThrow("publication failure");
    expect(await readFile(join(homePath, "apps/folio/src/definition.json"), "utf8")).toBe("owner edits");
    expect(await readdir(join(homePath, "apps/folio"))).toEqual(["src"]);
    expect(await service().list()).toMatchObject([{ installed: false }]);
  });
  it("cleans unchanged installer files after a failed publication", async () => {
    vi.spyOn(filesystem, "publishManifest").mockRejectedValue(new Error("injected failure"));
    await expect(service().install("folio")).rejects.toThrow("injected failure");
    expect(await readdir(join(homePath, "apps"))).toEqual([]);
  });
  it("protects pre-existing app files against concurrent installer instances", async () => {
    const results = await Promise.allSettled([service().install("folio"), service().install("folio")]);
    expect(results.filter(result => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(await readFile(join(homePath, "apps/folio/matrix.json"), "utf8"))).toMatchObject({ slug: "folio" });
  });
  it("rejects a catalog beyond its cap and unsafe source placeholders", async () => {
    await expect(service({ limits: { maxCatalogBytes: 10 } }).list()).rejects.toThrow();
    await writeFile(join(templatePath, "index.html"), placeholder + placeholder);
    await expect(service().install("folio")).rejects.toThrow();
    expect(await readdir(homePath)).toEqual([]);
  });
  it("rejects templates that exceed entry and nesting bounds", async () => {
    await expect(service({ limits: { maxEntries: 1 } }).install("folio")).rejects.toThrow();
    await mkdir(join(templatePath, ...Array.from({ length: 18 }, () => "deep")), { recursive: true });
    await expect(service().install("folio")).rejects.toThrow();
  });
  it("never removes symlinks, replaced files or changed content during rollback", async () => {
    const directory = join(homePath, "owned"); await mkdir(directory);
    const paths = ["changed", "replaced", "linked", "missing"].map(name => join(directory, name));
    const owned = await Promise.all(paths.map(path => filesystem.exclusiveWrite(path, Buffer.from("abc"))));
    await writeFile(paths[0], "xyz");
    await rename(paths[1], join(directory, "old-file")); await writeFile(paths[1], "abc");
    await rm(paths[2]); await symlink(catalogPath, paths[2]); await rm(paths[3]);
    await filesystem.cleanOwnedFiles(owned, [await filesystem.directoryIdentity(directory)]);
    expect(await readFile(paths[0], "utf8")).toBe("xyz"); expect(await readFile(paths[1], "utf8")).toBe("abc");
    expect(await readFile(paths[2], "utf8")).toContain('"apps"');
  });
  it("never removes a replacement owner directory and ignores missing folders", async () => {
    const path = join(homePath, "owned"); await mkdir(path); const original = await filesystem.directoryIdentity(path);
    await rename(path, join(homePath, "previous")); await mkdir(path);
    await filesystem.cleanOwnedFiles([], [original]); expect(await readdir(homePath)).toContain("owned");
    await rm(path, { recursive: true }); await filesystem.cleanOwnedFiles([], [original]);
  });
  it("does not overwrite a manifest changed before publication", async () => {
    const path = join(homePath, "matrix.json"); await writeFile(path, "owner data");
    await expect(filesystem.publishManifest(path, Buffer.from("new data"))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path, "utf8")).toBe("owner data"); expect(await readdir(homePath)).toEqual(["matrix.json"]);
  });
  it("keeps business starters personal to their installing owner", async () => {
    await writeFile(catalogPath, JSON.stringify({ version: 1, apps: [{ ...definition, collection: "business" }] }));
    await service().install("folio"); expect(JSON.parse(await readFile(join(homePath, "apps/folio/matrix.json"), "utf8")).scope).toBe("personal");
  });
  it("uses bundled definitions rather than an owner-mutable catalog", async () => {
    await mkdir(join(homePath, "system")); await writeFile(join(homePath, "system/app-gallery.json"), "malicious owner catalog");
    const bundled = createAppGalleryService({ homePath });
    expect((await bundled.list()).length).toBe(24);
  });
  it("rejects invalid owner manifests and preserves renamed runtime slugs", async () => {
    await service().install("folio"); const path = join(homePath, "apps/folio/matrix.json");
    const manifest = JSON.parse(await readFile(path, "utf8")); manifest.slug = "my-folio";
    await writeFile(path, JSON.stringify(manifest)); expect(await service().install("folio")).toMatchObject({ slug: "my-folio", path: "/apps/my-folio/" });
    await writeFile(path, "{}"); expect(await service().list()).toMatchObject([{ installed: false }]);
    await writeFile(path, "bad json"); expect(await service().list()).toMatchObject([{ installed: false }]);
  });
  it("checks the size again after definition injection", async () => {
    await expect(service({ limits: { maxFileBytes: 150 } }).install("folio")).rejects.toThrow("Injected template size limit");
  });
  it("caps simultaneous app copies and frees slots after they settle", async () => {
    await writeFile(catalogPath, JSON.stringify({ version: 1, apps: [definition, { ...definition, id: "atlas" }, { ...definition, id: "agenda" }] }));
    let release!: () => void, started!: () => void, count = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const original = filesystem.readTemplate;
    vi.spyOn(filesystem, "readTemplate").mockImplementation(async (path, limits) => {
      const files = await original(path, limits); if (++count === 2) started(); await gate; return files;
    });
    const installer = service(); const copies = [installer.install("folio"), installer.install("atlas")];
    try { await ready; await expect(installer.install("agenda")).rejects.toMatchObject({ status: 503 }); }
    finally { release(); await Promise.all(copies); }
    expect((await installer.install("agenda")).status).toBe("installed");
  });
  it("reports a conflict when an owner removes an app during concurrent completion", async () => {
    const publish = filesystem.publishManifest;
    vi.spyOn(filesystem, "publishManifest").mockImplementation(async (path, bytes) => { await publish(path, bytes); await rm(join(homePath, "apps/folio"), { recursive: true }); });
    const installer = service(); const results = await Promise.allSettled([installer.install("folio"), installer.install("folio")]);
    expect(results.some(result => result.status === "rejected" && result.reason.status === 409)).toBe(true);
  });
  it("retains owner path replacements when rollback cannot reach its original files", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const path = join(homePath, "original"); await mkdir(path);
    const ownedDirectory = await filesystem.directoryIdentity(path);
    const ownedFile = await filesystem.exclusiveWrite(join(path, "file"), Buffer.from("data"));
    await rename(path, join(homePath, "moved")); await writeFile(path, "owner data");
    await filesystem.cleanOwnedFiles([ownedFile], [ownedDirectory]);
    expect(await readFile(path, "utf8")).toBe("owner data"); expect(console.warn).toHaveBeenCalled();
  });
  it("bounds reads even if a file grows after its stat check", async () => {
    const path = join(homePath, "growing"); await writeFile(path, "a"); const original = fsPromises.open;
    vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (args[0] === path) { const stat = handle.stat.bind(handle); vi.spyOn(handle, "stat").mockImplementation(async () => { const result = await stat(); await writeFile(path, "abcdef"); return result; }); }
      return handle;
    });
    await expect(filesystem.readLimited(path, 3)).rejects.toThrow("File too large");
  });
  it("rejects non-file entries reported by the filesystem", async () => {
    const path = join(templatePath, "special"); await writeFile(path, "device"); const original = fsPromises.lstat;
    vi.spyOn(fsPromises, "lstat").mockImplementation(async (...args) => {
      const info = await original(...args);
      return String(args[0]) === path ? new Proxy(info, { get: (target, key, receiver) => key === "isFile" ? () => false : Reflect.get(target, key, receiver) }) : info;
    });
    await expect(service().install("folio")).rejects.toThrow("Invalid template entry");
  });
  it("preserves data on mkdir failures at each installation boundary", async () => {
    const original = fsPromises.mkdir;
    for (const failPath of [join(homePath, "apps"), join(homePath, "apps/folio"), join(homePath, "apps/folio/dist")]) {
      const mkdir = vi.spyOn(fsPromises, "mkdir").mockImplementation(async (...args) => {
        if (args[0] === failPath) throw Object.assign(new Error("injected IO error"), { code: "EIO" });
        return original(...args);
      });
      await expect(service().install("folio")).rejects.toMatchObject({ code: "EIO" }); mkdir.mockRestore();
      await expect(readFile(join(homePath, "apps/folio/matrix.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  it("accepts a concurrently created safe source subdirectory without overwriting", async () => {
    const original = filesystem.exclusiveWrite;
    vi.spyOn(filesystem, "exclusiveWrite").mockImplementation(async (path, bytes) => {
      if (path.endsWith("dist/index.html")) await mkdir(join(homePath, "apps/folio/src"));
      return original(path, bytes);
    });
    expect((await service().install("folio")).status).toBe("installed");
  });
  it("escapes HTML-sensitive definition content", async () => {
    await writeFile(catalogPath, JSON.stringify({ version: 1, apps: [{ ...definition, description: "</script><script>bad</script>\u2028text" }] }));
    await service().install("folio");
    const html = await readFile(join(homePath, "apps/folio/dist/index.html"), "utf8");
    expect(html).not.toContain("<script>bad"); expect(html).toContain("\\u003c"); expect(html).toContain("\\u2028");
  });
});

describe("owner-bound gallery routes", () => {
  it("rejects anonymous and other owners before reading an unavailable catalog", async () => {
    await rm(catalogPath);
    expect((await app(null).request("/api/app-gallery")).status).toBe(401);
    expect((await app("other").request("/api/app-gallery/folio/install", { method: "POST", body: "{}" })).status).toBe(403);
    expect(await readdir(homePath)).toEqual([]);
  });
  it("lists and installs through authenticated routes", async () => {
    expect((await app().request("/api/app-gallery")).status).toBe(200);
    const result = await app().request("/api/app-gallery/folio/install", { method: "POST", body: "{}" });
    expect(result.status).toBe(201); expect(await result.json()).toMatchObject({ status: "installed" });
    expect((await app().request("/api/app-gallery/folio/install", { method: "POST", body: "{}" })).status).toBe(200);
  });
  it("rejects malformed bodies, caller paths, oversized bodies and unknown ids", async () => {
    for (const body of ["{", '{"templatePath":"/tmp"}', '{"url":"https://example.com"}']) {
      expect((await app().request("/api/app-gallery/folio/install", { method: "POST", body })).status).toBe(400);
    }
    expect((await app().request("/api/app-gallery/folio/install", { method: "POST", body: " ".repeat(5000) })).status).toBe(413);
    expect((await app().request("/api/app-gallery/missing/install", { method: "POST", body: "{}" })).status).toBe(404);
  });
  it("requires initialized auth and explicit configured home ownership", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const uninitialized = new Hono(); registerAppGalleryRoutes(uninitialized, { homePath, catalogPath, templatePath, ownerIds: ["owner"] });
    expect((await uninitialized.request("/api/app-gallery")).status).toBe(500);
    vi.stubEnv("MATRIX_USER_ID", "owner"); vi.stubEnv("MATRIX_CLERK_USER_ID", "clerk-owner");
    const configured = new Hono(); configured.use("*", async (c, next) => { markAuthContextReady(c); setPlatformVerifiedPrincipal(c, "clerk-owner"); await next(); });
    registerAppGalleryRoutes(configured, { homePath, catalogPath, templatePath });
    expect((await configured.request("/api/app-gallery")).status).toBe(200);
  });
  it("enforces explicit Content-Length limits before body parsing", async () => {
    expect((await app().request("/api/app-gallery/folio/install", { method: "POST", headers: { "content-length": "5000" }, body: "{}" })).status).toBe(413);
  });
  it("maps valid but disallowed service ids to a safe bad-request response", async () => {
    vi.spyOn(filesystem, "readTemplate").mockRejectedValue(new filesystem.GalleryError(400, "sensitive internal detail"));
    const response = await app().request("/api/app-gallery/folio/install", { method: "POST", body: "{}" });
    expect(response.status).toBe(400); expect(await response.text()).not.toContain("sensitive");
  });
  it("returns a conflict for occupied incomplete owner folders", async () => {
    await mkdir(join(homePath, "apps/folio"), { recursive: true });
    expect((await app().request("/api/app-gallery/folio/install", { method: "POST", body: "{}" })).status).toBe(409);
    const invalid = await app().request("/api/app-gallery/INVALID/install", { method: "POST", body: "{}" });
    expect(invalid.status).toBe(400);
  });
  it("returns generic service failures without filesystem details", async () => {
    await rm(catalogPath);
    const response = await app().request("/api/app-gallery");
    expect(response.status).toBe(503); expect(await response.text()).not.toContain(root);
  });
});
