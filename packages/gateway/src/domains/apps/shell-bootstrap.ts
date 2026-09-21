import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listAppCatalog, type AppEntry } from "./apps.js";
import { resolveSystemIconMetadata, type SystemIconMetadata } from "../../icon-metadata.js";

export interface ShellBootstrapIcon {
  url: string;
  etag: string | null;
  versionedUrl: string;
}

export interface ShellBootstrap {
  layout: { windows?: unknown[] };
  modules: unknown[];
  apps: AppEntry[];
  icons: Record<string, ShellBootstrapIcon>;
}

const BOOTSTRAP_BUILT_IN_ICON_SLUGS = ["terminal", "workspace", "files", "chat", "chart"] as const;
const SAFE_ICON_SLUG = /^[a-zA-Z0-9_-]{1,64}$/;

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[shell-bootstrap] failed to read bootstrap JSON:", err instanceof Error ? err.message : String(err));
    }
    return null;
  }
}

function normalizeLayout(value: unknown): { windows?: unknown[] } {
  if (value && typeof value === "object" && Array.isArray((value as { windows?: unknown }).windows)) {
    return { windows: (value as { windows: unknown[] }).windows };
  }
  return {};
}

function normalizeModules(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toBootstrapIcon(icon: SystemIconMetadata): ShellBootstrapIcon {
  return { url: icon.url, etag: icon.etag, versionedUrl: icon.versionedUrl };
}

export async function buildShellBootstrap(homePath: string): Promise<ShellBootstrap> {
  const [layoutValue, modulesValue, catalog] = await Promise.all([
    readJsonFile(join(homePath, "system/layout.json")),
    readJsonFile(join(homePath, "system/modules.json")),
    listAppCatalog(homePath),
  ]);
  const { apps } = catalog;

  // The catalog already resolved and stat'ed every app icon; only the built-in
  // launcher icons that no app claimed still need a lookup.
  const icons: Record<string, ShellBootstrapIcon> = {};
  for (const [slug, icon] of Object.entries(catalog.icons)) {
    if (SAFE_ICON_SLUG.test(slug)) icons[slug] = toBootstrapIcon(icon);
  }
  const missingBuiltIns = BOOTSTRAP_BUILT_IN_ICON_SLUGS.filter((slug) => !(slug in icons));
  await Promise.all(missingBuiltIns.map(async (slug) => {
    const icon = await resolveSystemIconMetadata(homePath, slug);
    if (icon) icons[slug] = toBootstrapIcon(icon);
  }));

  return {
    layout: normalizeLayout(layoutValue),
    modules: normalizeModules(modulesValue),
    apps,
    icons,
  };
}
