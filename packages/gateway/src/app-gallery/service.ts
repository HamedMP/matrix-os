import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import { AppGalleryCatalogSchema, type GalleryApp, type GalleryAppListing, type GalleryInstallResult } from "@matrix-os/contracts/app-gallery";
import { AppManifestSchema } from "../app-runtime/manifest-schema.js";
import { createPrivateStage, DEFAULT_LIMITS, GalleryError, isFsError, pinDirectory, readLimited, readTemplate, type GalleryLimits } from "./filesystem.js";
import type { PinnedDirectory } from "./pinned-directory.js";
import { indexOwnerApps, isOwnerFileUnavailable, readOwnerManifest } from "./owner-index.js";
import { withOwnerFileMutation } from "../owner-file-mutations.js";

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
    category: definition.category, icon: `gallery-${definition.id}`, author: "Matrix OS", version: "1.0.0",
    runtime: "vite", runtimeVersion: "^24.0.0", database: "postgres", scope: "personal", listingTrust: "first_party",
    permissions: [], build: { command: "pnpm exec vite build", output: "dist" },
    storage: { tables: { records: { columns: { payload: "jsonb", source_id: "text" } } } },
  });
}
function injectedFiles(files: Map<string, Buffer>, definition: GalleryApp, icon: Buffer): Map<string, Buffer> {
  const installedDefinition = { ...definition, iconDataUrl: `data:image/png;base64,${icon.toString("base64")}` };
  const json = JSON.stringify(installedDefinition).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  const built = files.get("dist/index.html")?.toString("utf8");
  if (!built || built.split(PLACEHOLDER).length !== 2 || !files.has("src/definition.json")) throw new GalleryError(503, "Invalid starter definition boundary");
  files.set("dist/index.html", Buffer.from(built.replace(PLACEHOLDER, () => json)));
  const source = files.get("index.html")?.toString("utf8");
  if (!source || source.split(PLACEHOLDER).length !== 2) throw new GalleryError(503, "Invalid source definition boundary");
  // Preserve the source placeholder: owner rebuilds must use their edited definition.json fallback.
  files.set("src/definition.json", Buffer.from(JSON.stringify(installedDefinition, null, 2) + "\n"));
  files.set("dist/app-icon.png", icon);
  files.set("public/app-icon.png", icon);
  return files;
}

export function createAppGalleryService(options: AppGalleryOptions): AppGalleryService {
  const home = resolve(options.homePath);
  const catalogPath = options.catalogPath ?? join(BUNDLED_HOME, "system/app-gallery.json");
  const templatePath = options.templatePath ?? join(BUNDLED_HOME, "app-templates/connected-starter");
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  // At most two concurrent bounded template copies; remove on settlement. No stale registry.
  const inFlight = new Map<string, Promise<GalleryInstallResult>>();
  async function catalog() {
    return AppGalleryCatalogSchema.parse(JSON.parse((await readLimited(catalogPath, limits.maxCatalogBytes)).toString("utf8")));
  }
  async function existing(apps: PinnedDirectory, id: string): Promise<GalleryInstallResult | null> {
    let directory: PinnedDirectory | undefined;
    try {
      directory = await apps.child(id);
      const { manifest } = await readOwnerManifest(directory);
      if (!manifest || manifest.slug !== id) return null;
      return { status: "already_installed", slug: id, name: manifest.name, path: `apps/${id}` };
    } catch (error) {
      if (isOwnerFileUnavailable(error) || isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR") || error instanceof SyntaxError) return null;
      throw error;
    } finally { await directory?.close(); }
  }
  async function installDefinition(definition: GalleryApp): Promise<GalleryInstallResult> {
    const owner = await pinDirectory(home);
    let apps: PinnedDirectory | undefined;
    try {
      try { apps = await owner.child("apps"); }
      catch (error) { if (!isFsError(error, "ENOENT")) throw error; }
      const index = apps ? await indexOwnerApps(apps) : null;
      if (index?.unavailable) throw new GalleryError(409, "Owner app identity cannot be verified");
      if (index?.entries.has(definition.id)) {
        const indexed = index.entries.get(definition.id);
        if (!indexed) throw new GalleryError(409, "Duplicate owner app slug");
        return indexed;
      }
      const installed = apps ? await existing(apps, definition.id) : null;
      if (installed) return installed;
      // Validate and prepare everything privately before creating any discoverable app folder.
      const icon = await readLimited(join(BUNDLED_HOME, "apps/app-gallery/src/assets/icons", `${definition.id}.png`), limits.maxFileBytes);
      const files = injectedFiles(await readTemplate(templatePath, limits), definition, icon);
      const manifest = Buffer.from(JSON.stringify(manifestFor(definition), null, 2) + "\n");
      let bytesTotal = 0;
      for (const bytes of files.values()) {
        bytesTotal += bytes.length;
        if (bytes.length > limits.maxFileBytes || bytesTotal > limits.maxTotalBytes) throw new GalleryError(503, "Injected template size limit");
      }
      const stage = await createPrivateStage(owner);
      const directories: PinnedDirectory[] = [];
      try {
        const prepared: { path: string; name: string }[] = [];
        for (const [path, bytes] of files) prepared.push({ path, name: await stage.write(bytes) });
        const manifestName = await stage.write(manifest);
        apps ??= await owner.ensureChild("apps");
        let destination: PinnedDirectory;
        try { destination = await apps.createChild(definition.id); }
        catch (error) {
          if (!isFsError(error, "EEXIST")) throw error;
          const concurrent = await existing(apps, definition.id);
          if (concurrent) return concurrent;
          throw new GalleryError(409, "An incomplete app already occupies this folder");
        }
        directories.push(destination);
        // Request-scoped directory capabilities, bounded by template entry/depth limits.
        const parents = new Map<string, PinnedDirectory>([["", destination]]);
        for (const file of prepared) {
          const segments = file.path.split("/");
          const name = segments.pop()!;
          let prefix = "", parent = destination;
          for (const segment of segments) {
            prefix = prefix ? `${prefix}/${segment}` : segment;
            let child = parents.get(prefix);
            if (!child) { child = await parent.ensureChild(segment); directories.push(child); parents.set(prefix, child); }
            parent = child;
          }
          await stage.publish(file.name, parent, name);
        }
        // Refuse publication if the visible folder was replaced; never remove uncertain visible files.
        const current = await apps.child(definition.id);
        try {
          const a = await current.identity(), b = await destination.identity();
          if (a.dev !== b.dev || a.ino !== b.ino) throw new GalleryError(409, "App folder changed during installation");
        } finally { await current.close(); }
        const boundOwner = await pinDirectory(home);
        try {
          const a = await boundOwner.identity(), b = await owner.identity();
          if (a.dev !== b.dev || a.ino !== b.ino) throw new GalleryError(409, "Owner home changed during installation");
        } finally { await boundOwner.close(); }
        const boundApps = await owner.child("apps");
        try {
          const a = await boundApps.identity(), b = await apps.identity();
          if (a.dev !== b.dev || a.ino !== b.ino) throw new GalleryError(409, "App root changed during installation");
        } finally { await boundApps.close(); }
        for (const [prefix, expected] of parents) {
          if (!prefix) continue;
          const segments = prefix.split("/"); const name = segments.pop()!;
          const bound = await parents.get(segments.join("/"))!.child(name);
          try {
            const a = await bound.identity(), b = await expected.identity();
            if (a.dev !== b.dev || a.ino !== b.ino) throw new GalleryError(409, "App directory changed during installation");
          } finally { await bound.close(); }
        }
        const finalIndex = await indexOwnerApps(apps);
        if (finalIndex.unavailable || finalIndex.entries.has(definition.id)) throw new GalleryError(409, "Owner app changed before publication");
        await stage.publish(manifestName, destination, "matrix.json");
        return { status: "installed", slug: definition.id, name: definition.name, path: `apps/${definition.id}` };
      } finally {
        const closed = await Promise.allSettled(directories.reverse().map(directory => directory.close()));
        for (const result of closed) if (result.status === "rejected") console.warn("[app-gallery] Failed to close app directory", result.reason);
        await stage.release();
      }
    } finally { try { await apps?.close(); } finally { await owner.close(); } }
  }
  return {
    async list() {
      const definitions = (await catalog()).apps;
      const owner = await pinDirectory(home);
      let apps: PinnedDirectory | undefined;
      try {
        try { apps = await owner.child("apps"); }
        catch (error) { if (!isFsError(error, "ENOENT")) throw error; }
        const index = apps ? await indexOwnerApps(apps) : null;
        const result: GalleryAppListing[] = [];
        for (const definition of definitions) {
          const installed = index?.unavailable ? null : index?.entries.has(definition.id) ? index.entries.get(definition.id) : apps ? await existing(apps, definition.id) : null;
          result.push({ ...definition, installed: Boolean(installed), ...(installed ? { installedName: installed.name, launchPath: installed.path } : {}) });
        }
        return result;
      } finally { try { await apps?.close(); } finally { await owner.close(); } }
    },
    async install(id) {
      if (!IdSchema.safeParse(id).success) throw new GalleryError(400, "Invalid app id");
      const definition = (await catalog()).apps.find(app => app.id === id);
      if (!definition) throw new GalleryError(404, "App not found");
      const pending = inFlight.get(id);
      if (pending) {
        await pending;
        const entry = (await this.list()).find(app => app.id === id);
        if (!entry?.installed) throw new GalleryError(409, "App changed during installation");
        return { status: "already_installed", slug: id, name: entry.installedName!, path: entry.launchPath! };
      }
      if (inFlight.size >= 2) throw new GalleryError(503, "Gallery is busy");
      const job = withOwnerFileMutation(home, () => installDefinition(definition));
      inFlight.set(id, job);
      try { return await job; } finally { inFlight.delete(id); }
    },
  };
}
