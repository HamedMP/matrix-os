import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { listApps, type AppEntry } from "./apps.js";
import { resolveSystemIconPath } from "./default-icons.js";

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

function versionedIconUrl(url: string, etag: string | null): string {
  if (!etag) return url;
  const normalized = etag.replace(/^W\//, "").replace(/^"|"$/g, "");
  if (!normalized) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(normalized)}`;
}

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

async function resolveBootstrapIcon(homePath: string, slug: string): Promise<ShellBootstrapIcon | null> {
  if (!SAFE_ICON_SLUG.test(slug)) return null;
  const target = await resolveSystemIconPath(homePath, `${slug}.png`);
  if (!target) return null;
  try {
    const iconStat = await stat(target);
    const etag = `"${iconStat.mtimeMs.toString(36)}-${iconStat.size.toString(36)}"`;
    const url = `/icons/${basename(target)}`;
    return { url, etag, versionedUrl: versionedIconUrl(url, etag) };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[shell-bootstrap] failed to stat bootstrap icon:", err instanceof Error ? err.message : String(err));
    }
    return null;
  }
}

export async function buildShellBootstrap(homePath: string): Promise<ShellBootstrap> {
  const [layoutValue, modulesValue, apps] = await Promise.all([
    readJsonFile(join(homePath, "system/layout.json")),
    readJsonFile(join(homePath, "system/modules.json")),
    listApps(homePath),
  ]);

  const iconSlugs = new Set<string>(BOOTSTRAP_BUILT_IN_ICON_SLUGS);
  for (const app of apps) {
    if (typeof app.icon === "string" && SAFE_ICON_SLUG.test(app.icon)) {
      iconSlugs.add(app.icon);
    } else if (typeof app.slug === "string" && SAFE_ICON_SLUG.test(app.slug)) {
      iconSlugs.add(app.slug);
    }
  }

  const icons: Record<string, ShellBootstrapIcon> = {};
  await Promise.all(Array.from(iconSlugs).map(async (slug) => {
    const icon = await resolveBootstrapIcon(homePath, slug);
    if (icon) icons[slug] = icon;
  }));

  return {
    layout: normalizeLayout(layoutValue),
    modules: normalizeModules(modulesValue),
    apps,
    icons,
  };
}
