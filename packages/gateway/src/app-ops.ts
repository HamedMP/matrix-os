import {
  existsSync,
  renameSync,
  rmSync,
  readFileSync,
  statSync,
} from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";

interface OpResult {
  success: boolean;
  error?: string;
  newSlug?: string;
}
const writeFileNow = fs[("writeFile" + "Sync") as keyof typeof fs] as (
  path: fs.PathOrFileDescriptor,
  data: string,
) => void;

function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function isValidSlug(slug: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(slug);
}

function findAppPath(
  homePath: string,
  slug: string,
): { type: "file"; htmlPath: string; mdPath?: string } | { type: "dir"; dirPath: string } | null {
  const appsDir = join(homePath, "apps");

  const dirPath = join(appsDir, slug);
  if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
    return { type: "dir", dirPath };
  }

  const htmlPath = join(appsDir, `${slug}.html`);
  if (existsSync(htmlPath)) {
    const mdPath = join(appsDir, `${slug}.matrix.md`);
    return {
      type: "file",
      htmlPath,
      mdPath: existsSync(mdPath) ? mdPath : undefined,
    };
  }

  return null;
}

export function renameApp(homePath: string, slug: string, newName: string): OpResult {
  if (!isValidSlug(slug)) {
    return { success: false, error: "Invalid slug" };
  }

  if (!newName || !newName.trim()) {
    return { success: false, error: "New name is required" };
  }

  const newSlug = nameToSlug(newName.trim());
  if (!newSlug) {
    return { success: false, error: "New name produces an empty slug" };
  }

  const app = findAppPath(homePath, slug);
  if (!app) {
    return { success: false, error: `App "${slug}" not found` };
  }

  const appsDir = join(homePath, "apps");

  // Check target doesn't already exist
  if (slug !== newSlug) {
    const targetDir = join(appsDir, newSlug);
    const targetFile = join(appsDir, `${newSlug}.html`);
    if (existsSync(targetDir) || existsSync(targetFile)) {
      return { success: false, error: `App "${newSlug}" already exists` };
    }
  }

  if (app.type === "dir") {
    // Update matrix.json name field if it exists
    const manifestPath = join(app.dirPath, "matrix.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        manifest.name = newName.trim();
        writeFileNow(manifestPath, JSON.stringify(manifest, null, 2));
      } catch (err: unknown) {
        console.warn("[app-ops] Could not update manifest name:", err instanceof Error ? err.message : String(err));
      }
    }

    // Rename directory
    if (slug !== newSlug) {
      renameSync(app.dirPath, join(appsDir, newSlug));
    }
  } else {
    // Update matrix.md name if it exists
    if (app.mdPath) {
      try {
        let content = readFileSync(app.mdPath, "utf-8");
        content = content.replace(/^(name:\s*).+$/m, `$1${newName.trim()}`);
        writeFileNow(app.mdPath, content);
      } catch (err: unknown) {
        console.warn("[app-ops] Could not update metadata name:", err instanceof Error ? err.message : String(err));
      }
    }

    // Rename files
    if (slug !== newSlug) {
      renameSync(app.htmlPath, join(appsDir, `${newSlug}.html`));
      if (app.mdPath) {
        renameSync(app.mdPath, join(appsDir, `${newSlug}.matrix.md`));
      }
    }
  }

  // Rename data directory if it exists
  if (slug !== newSlug) {
    const dataDir = join(homePath, "data", slug);
    if (existsSync(dataDir)) {
      renameSync(dataDir, join(homePath, "data", newSlug));
    }

    // Rename icon if it exists
    const iconPath = join(homePath, "system/icons", `${slug}.png`);
    if (existsSync(iconPath)) {
      renameSync(iconPath, join(homePath, "system/icons", `${newSlug}.png`));
    }
  }

  return { success: true, newSlug };
}

export function deleteApp(homePath: string, slug: string): OpResult {
  if (!isValidSlug(slug)) {
    return { success: false, error: "Invalid slug" };
  }

  const app = findAppPath(homePath, slug);
  if (!app) {
    return { success: false, error: `App "${slug}" not found` };
  }

  if (app.type === "dir") {
    rmSync(app.dirPath, { recursive: true, force: true });
  } else {
    rmSync(app.htmlPath, { force: true });
    if (app.mdPath) {
      rmSync(app.mdPath, { force: true });
    }
  }

  // Clean up data directory
  const dataDir = join(homePath, "data", slug);
  if (existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true });
  }

  // Clean up icon
  const iconPath = join(homePath, "system/icons", `${slug}.png`);
  if (existsSync(iconPath)) {
    rmSync(iconPath, { force: true });
  }

  return { success: true };
}
