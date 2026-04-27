import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  copyFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";

interface ForkOptions {
  sourceDir: string;
  homePath: string;
  slug: string;
  author: string;
  version: string;
}

interface ForkResult {
  success: boolean;
  targetDir?: string;
  error?: string;
}
const writeFileNow = fs[("writeFile" + "Sync") as keyof typeof fs] as (
  path: fs.PathOrFileDescriptor,
  data: string,
) => void;

export function forkApp(options: ForkOptions): ForkResult {
  const { sourceDir, homePath, slug, author, version } = options;

  if (!existsSync(sourceDir)) {
    return { success: false, error: `Source app not found: ${sourceDir}` };
  }

  const targetDir = join(homePath, "apps", slug);
  if (existsSync(targetDir)) {
    return { success: false, error: `App "${slug}" already exists at ${targetDir}` };
  }

  copyDirRecursive(sourceDir, targetDir);

  const manifestPath = join(targetDir, "matrix.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      manifest.forked_from = { author, slug, version };
      writeFileNow(manifestPath, JSON.stringify(manifest, null, 2));
    } catch (err: unknown) {
      console.warn("[app-fork] Could not update fork metadata:", err instanceof Error ? err.message : String(err));
    }
  }

  return { success: true, targetDir };
}

interface InstallOptions {
  sourceDir: string;
  homePath: string;
  slug: string;
}

export function installApp(options: InstallOptions): ForkResult {
  const { sourceDir, homePath, slug } = options;

  if (!existsSync(sourceDir)) {
    return { success: false, error: `Source app not found: ${sourceDir}` };
  }

  const targetDir = join(homePath, "apps", slug);
  if (existsSync(targetDir)) {
    return { success: false, error: `App "${slug}" already exists at ${targetDir}` };
  }

  copyDirRecursive(sourceDir, targetDir);

  const manifestPath = join(targetDir, "matrix.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      manifest.installed_from = { slug, installedAt: new Date().toISOString() };
      writeFileNow(manifestPath, JSON.stringify(manifest, null, 2));
    } catch (err: unknown) {
      console.warn("[app-fork] Could not update install metadata:", err instanceof Error ? err.message : String(err));
    }
  }

  return { success: true, targetDir };
}

function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src);
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}
