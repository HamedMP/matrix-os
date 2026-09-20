import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadAppMeta, type AppMeta } from "@matrix-os/kernel";
import { listUniqueAppManifests } from "./app-runtime/app-index.js";
import { computeRuntimeState, type RuntimeState } from "./app-runtime/runtime-state.js";
import { DesignIdEnum, type AppManifest, type DesignId } from "./app-runtime/manifest-schema.js";
import { resolveSystemIconMetadata, type SystemIconMetadata } from "./icon-metadata.js";

export interface AppEntry extends AppMeta {
  slug?: string;
  runtime?: AppManifest["runtime"];
  runtimeState?: RuntimeState | { status: "error"; message: string };
  launchUrl?: string;
  file: string;
  path: string;
  iconUrl?: string;
}

export interface ListAppsOptions {
  includeInactiveDesigns?: boolean;
}

export interface AppCatalog {
  apps: AppEntry[];
  /** Icon metadata keyed by the icon stem each app resolved, so callers such as
   * the shell bootstrap can reuse it instead of re-statting every icon. */
  icons: Record<string, SystemIconMetadata>;
}

export async function listApps(
  homePath: string,
  options: ListAppsOptions = {},
): Promise<AppEntry[]> {
  return (await listAppCatalog(homePath, options)).apps;
}

export async function listAppCatalog(
  homePath: string,
  options: ListAppsOptions = {},
): Promise<AppCatalog> {
  const appsDir = join(homePath, "apps");

  const result: AppEntry[] = [];
  const seen = new Set<string>();

  await scanAppsDir(appsDir, "", result, seen);
  await scanRuntimeApps(
    appsDir,
    result,
    seen,
    await resolveActiveDesignId(homePath),
    options.includeInactiveDesigns ?? false,
  );

  return attachLocalIconUrls(homePath, result.sort((a, b) => a.name.localeCompare(b.name)));
}

const ICON_METADATA_BATCH_SIZE = 16;
const SAFE_ICON_STEM = /^[a-zA-Z0-9_-]{1,64}$/;

export function appIconStem(app: Pick<AppEntry, "icon" | "slug">): string | null {
  if (typeof app.icon === "string" && SAFE_ICON_STEM.test(app.icon)) return app.icon;
  if (typeof app.slug === "string" && SAFE_ICON_STEM.test(app.slug)) return app.slug;
  return null;
}

async function attachLocalIconUrls(homePath: string, apps: AppEntry[]): Promise<AppCatalog> {
  const hydrated: AppEntry[] = [];
  const icons: Record<string, SystemIconMetadata> = {};
  for (let offset = 0; offset < apps.length; offset += ICON_METADATA_BATCH_SIZE) {
    const batch = apps.slice(offset, offset + ICON_METADATA_BATCH_SIZE);
    // In-flight lookups are deduplicated per batch, so this map never holds
    // more than ICON_METADATA_BATCH_SIZE entries; stems resolved by earlier
    // batches are reused from the returned `icons` metadata instead.
    const pending = new Map<string, Promise<SystemIconMetadata | null>>();
    const resolveOnce = (iconStem: string): Promise<SystemIconMetadata | null> => {
      const resolved = icons[iconStem];
      if (resolved) return Promise.resolve(resolved);
      let lookup = pending.get(iconStem);
      if (!lookup) {
        lookup = resolveSystemIconMetadata(homePath, iconStem);
        pending.set(iconStem, lookup);
      }
      return lookup;
    };
    // Bounded batches prevent a large custom-app catalog from flooding the filesystem.
    // eslint-disable-next-line no-await-in-loop -- each bounded batch must settle before the next starts
    const entries = await Promise.all(batch.map(async (app) => {
      const iconStem = appIconStem(app);
      if (!iconStem) return app;
      const icon = await resolveOnce(iconStem);
      if (!icon) return app;
      icons[iconStem] = icon;
      return { ...app, iconUrl: icon.versionedUrl };
    }));
    hydrated.push(...entries);
  }
  return { apps: hydrated, icons };
}

const DEFAULT_DESIGN_ID: DesignId = "flat";

async function resolveActiveDesignId(homePath: string): Promise<DesignId> {
  const themePath = join(homePath, "system/theme.json");
  let theme: unknown;
  try {
    theme = JSON.parse(await readFile(themePath, "utf8"));
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      console.warn(
        `[apps] theme config is not valid JSON; falling back to the "${DEFAULT_DESIGN_ID}" design`,
      );
      return DEFAULT_DESIGN_ID;
    }
    if (isExpectedFsScanError(err)) {
      return DEFAULT_DESIGN_ID;
    }
    console.warn(
      `[apps] Failed to read theme config: ${err instanceof Error ? err.message : String(err)}`,
    );
    return DEFAULT_DESIGN_ID;
  }
  if (!theme || typeof theme !== "object" || !("style" in theme)) return DEFAULT_DESIGN_ID;
  const style = DesignIdEnum.safeParse(theme.style);
  return style.success ? style.data : DEFAULT_DESIGN_ID;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  ".cache",
  ".vite",
  "_template-next",
  "_template-vite",
]);

function scanAppsDir(
  baseDir: string,
  prefix: string,
  result: AppEntry[],
  seen: Set<string>,
): Promise<void> {
  const dir = prefix ? join(baseDir, prefix) : baseDir;
  return readdir(dir, { withFileTypes: true })
    .then(async (entries) => {
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;

        const fullPath = join(dir, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          // Always recurse to discover nested apps (e.g. games/snake inside games/)
          await scanAppsDir(baseDir, relativePath, result, seen);
          continue;
        }

        if (!prefix && entry.isFile() && entry.name.endsWith(".html")) {
          const slug = entry.name.replace(/\.html$/, "");
          if (seen.has(slug)) continue;
          const meta = safeLoadAppMeta(baseDir, entry.name);
          seen.add(slug);
          result.push({
            ...meta,
            file: entry.name,
            path: `/files/apps/${entry.name}`,
          });
        }
      }
    })
    .catch((err: unknown) => {
      if (isExpectedFsScanError(err)) {
        logAppScanSkip(prefix || ".", err);
        return;
      }
      logAppScanSkip(prefix || ".", err);
    });
}

async function scanRuntimeApps(
  appsDir: string,
  result: AppEntry[],
  seen: Set<string>,
  activeDesign: DesignId,
  includeInactiveDesigns: boolean,
): Promise<void> {
  try {
    const apps = await listUniqueAppManifests(appsDir);
    for (const app of apps) {
      if (seen.has(app.slug)) continue;
      // Hidden apps are parked: not listed in the launcher and not registered.
      if (app.manifest.hidden) {
        seen.add(app.slug);
        continue;
      }
      // Design-scoped apps are listed only while the shell's active design matches.
      if (
        !includeInactiveDesigns
        && app.manifest.designs
        && !app.manifest.designs.includes(activeDesign)
      ) {
        seen.add(app.slug);
        continue;
      }
      seen.add(app.slug);
      result.push({
        name: app.manifest.name,
        description: app.manifest.description,
        icon: app.manifest.icon,
        category: app.manifest.category ?? "utility",
        author: app.manifest.author,
        version: app.manifest.version,
        slug: app.slug,
        runtime: app.manifest.runtime,
        runtimeState: await safeComputeRuntimeState(app.manifest, app.appDir, app.relativePath),
        launchUrl: `/apps/${app.slug}/`,
        file: `${app.relativePath}/index.html`,
        path: `/files/apps/${app.relativePath}/index.html`,
      });
    }
  } catch (err: unknown) {
    logAppScanSkip(".", err);
  }
}

async function safeComputeRuntimeState(
  manifest: AppManifest,
  appDir: string,
  relativePath: string,
): Promise<RuntimeState | { status: "error"; message: string }> {
  try {
    return await computeRuntimeState(manifest, appDir);
  } catch (err: unknown) {
    logAppScanSkip(relativePath, err);
    return { status: "error", message: "App runtime unavailable" };
  }
}

function safeLoadAppMeta(appsDir: string, entry: string): AppMeta {
  try {
    return loadAppMeta(appsDir, entry);
  } catch (err: unknown) {
    logAppScanSkip(entry, err);
    return { name: entry.replace(/\.html$/, ""), category: "utility" };
  }
}

function isExpectedFsScanError(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("code" in err)) return false;
  return ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"].includes(String(err.code));
}

function logAppScanSkip(entry: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[apps] Skipping unreadable app entry ${entry}: ${message}`);
}
