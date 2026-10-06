import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import { AppGalleryCatalogSchema, type GalleryApp, type GalleryAppListing, type GalleryInstallResult } from "@matrix-os/contracts/app-gallery";
import { AppManifestSchema } from "../app-runtime/manifest-schema.js";
import { cleanOwnedFiles, directoryIdentity, DEFAULT_LIMITS, exclusiveWrite, GalleryError, isFsError, publishManifest, readLimited, readTemplate, safeDirectory, type GalleryLimits, type OwnedFile } from "./filesystem.js";

const IdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const PLACEHOLDER = "__MATRIX_APP_DEFINITION__";
// Same path depth for src/app-gallery and compiled dist/app-gallery; never read an owner-mutable catalog.
const BUNDLED_HOME = fileURLToPath(new URL("../../../../home/", import.meta.url));
export interface AppGalleryOptions {
  homePath: string;
  catalogPath?: string;
  templatePath?: string;
  limits?: Partial<GalleryLimits>;
}
export interface AppGalleryService {
  list(): Promise<GalleryAppListing[]>;
  install(id: string): Promise<GalleryInstallResult>;
}

function manifestFor(definition: GalleryApp) {
  return AppManifestSchema.parse({
    name: definition.name, slug: definition.id, description: definition.description,
    category: definition.category, icon: definition.icon, author: "Matrix OS", version: "1.0.0",
    runtime: "vite", runtimeVersion: "^24.0.0", database: "postgres", scope: "personal", listingTrust: "first_party",
    permissions: [], build: { command: "pnpm exec vite build", output: "dist" },
    storage: { tables: { records: { columns: { payload: "jsonb", source_id: "text" } } } },
  });
}
function injectedFiles(files: Map<string, Buffer>, definition: GalleryApp): Map<string, Buffer> {
  const json = JSON.stringify(definition).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  const built = files.get("dist/index.html")?.toString("utf8");
  if (!built || built.split(PLACEHOLDER).length !== 2 || !files.has("src/definition.json")) throw new GalleryError(503, "Invalid starter definition boundary");
  files.set("dist/index.html", Buffer.from(built.replace(PLACEHOLDER, () => json)));
  const source = files.get("index.html")?.toString("utf8");
  if (source?.includes(PLACEHOLDER)) {
    if (source.split(PLACEHOLDER).length !== 2) throw new GalleryError(503, "Invalid source definition boundary");
    files.set("index.html", Buffer.from(source.replace(PLACEHOLDER, () => json)));
  }
  files.set("src/definition.json", Buffer.from(JSON.stringify(definition, null, 2) + "\n"));
  return files;
}

export function createAppGalleryService(options: AppGalleryOptions): AppGalleryService {
  const home = resolve(options.homePath), apps = join(home, "apps");
  const catalogPath = options.catalogPath ?? join(BUNDLED_HOME, "system/app-gallery.json");
  const templatePath = options.templatePath ?? join(BUNDLED_HOME, "app-templates/connected-starter");
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  // At most two concurrent bounded template copies; remove on settlement. No stale registry.
  const inFlight = new Map<string, Promise<GalleryInstallResult>>();
  async function catalog() {
    return AppGalleryCatalogSchema.parse(JSON.parse((await readLimited(catalogPath, limits.maxCatalogBytes)).toString("utf8")));
  }
  async function existing(id: string): Promise<GalleryInstallResult | null> {
    try {
      const dir = join(apps, id);
      await safeDirectory(dir);
      const bytes = await readLimited(join(dir, "matrix.json"), 32_768);
      const parsed = AppManifestSchema.safeParse(JSON.parse(bytes.toString("utf8")));
      if (!parsed.success || parsed.data.slug !== id) return null;
      return { status: "already_installed", slug: parsed.data.slug, name: parsed.data.name, path: `apps/${parsed.data.slug}` };
    } catch (error) {
      if (isFsError(error, "ENOENT") || error instanceof SyntaxError) return null;
      throw error;
    }
  }
  async function installDefinition(definition: GalleryApp): Promise<GalleryInstallResult> {
    const installed = await existing(definition.id);
    if (installed) return installed;
    // Fully validate the bounded trusted template before any owner filesystem mutation.
    const files = injectedFiles(await readTemplate(templatePath, limits), definition);
    const manifest = Buffer.from(JSON.stringify(manifestFor(definition), null, 2) + "\n");
    let bytesTotal = 0;
    for (const bytes of files.values()) {
      bytesTotal += bytes.length;
      if (bytes.length > limits.maxFileBytes || bytesTotal > limits.maxTotalBytes) throw new GalleryError(503, "Injected template size limit");
    }
    await safeDirectory(home);
    try { await mkdir(apps); } catch (error) { if (!isFsError(error, "EEXIST")) throw error; }
    await safeDirectory(apps);
    const appDir = join(apps, definition.id);
    try { await mkdir(appDir); }
    catch (error) {
      if (!isFsError(error, "EEXIST")) throw error;
      const concurrent = await existing(definition.id);
      if (concurrent) return concurrent;
      throw new GalleryError(409, "An incomplete app already occupies this folder");
    }
    const directories = [await directoryIdentity(appDir)], owned: OwnedFile[] = [];
    try {
      for (const [relativePath, bytes] of files) {
        const destination = join(appDir, relativePath);
        const parents: string[] = [];
        for (let parent = dirname(destination); parent !== appDir; parent = dirname(parent)) parents.unshift(parent);
        for (const parent of parents) {
          try { await mkdir(parent); directories.push(await directoryIdentity(parent)); }
          catch (error) { if (!isFsError(error, "EEXIST")) throw error; }
          await safeDirectory(parent);
        }
        owned.push(await exclusiveWrite(destination, bytes));
      }
      // App discovery and schema provisioning begin only after every portable file is present.
      await publishManifest(join(appDir, "matrix.json"), manifest);
      return { status: "installed", slug: definition.id, name: definition.name, path: `apps/${definition.id}` };
    } catch (error) { await cleanOwnedFiles(owned, directories); throw error; }
  }
  return {
    async list() {
      const result: GalleryAppListing[] = [];
      for (const definition of (await catalog()).apps) {
        const installed = await existing(definition.id);
        result.push({ ...definition, installed: Boolean(installed), ...(installed ? { installedName: installed.name, launchPath: installed.path } : {}) });
      }
      return result;
    },
    async install(id) {
      if (!IdSchema.safeParse(id).success) throw new GalleryError(400, "Invalid app id");
      const definition = (await catalog()).apps.find(app => app.id === id);
      if (!definition) throw new GalleryError(404, "App not found");
      const pending = inFlight.get(id);
      if (pending) {
        await pending;
        const installed = await existing(id);
        if (!installed) throw new GalleryError(409, "App changed during installation");
        return installed;
      }
      if (inFlight.size >= 2) throw new GalleryError(503, "Gallery is busy");
      const job = installDefinition(definition);
      inFlight.set(id, job);
      try { return await job; } finally { inFlight.delete(id); }
    },
  };
}
