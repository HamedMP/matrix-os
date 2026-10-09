import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  copyFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import { hasReservedAppIdentity, isReservedAppSlug, RESERVED_APP_INSTALL_ERROR } from "./app-runtime/reserved-apps.js";

const MAX_INSTALL_MANIFEST_BYTES = 64 * 1024;
const INVALID_INSTALL_MANIFEST = "Source manifest must be a regular file of 64 KiB or smaller.";

function readInstallManifest(sourceDir: string): { ok: true; manifest?: unknown } | { ok: false; error: string } {
  const path = join(sourceDir, "matrix.json");
  let descriptor: number | undefined;
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.size > MAX_INSTALL_MANIFEST_BYTES) return { ok: false, error: INVALID_INSTALL_MANIFEST };
    // Reject symlinks at open too, and avoid blocking if a regular file is
    // replaced by a FIFO between lstat and open. Inspect the opened file itself.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_INSTALL_MANIFEST_BYTES) return { ok: false, error: INVALID_INSTALL_MANIFEST };
    // A concurrent writer cannot turn this bounded inspection into an
    // unbounded readFileSync allocation after the size check.
    const bytes = Buffer.alloc(MAX_INSTALL_MANIFEST_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > MAX_INSTALL_MANIFEST_BYTES) return { ok: false, error: INVALID_INSTALL_MANIFEST };
    try {
      return { ok: true, manifest: JSON.parse(bytes.subarray(0, length).toString("utf8")) };
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      // Preserve existing malformed-JSON copy behavior only for bounded,
      // regular files, which cannot be indexed as a privileged identity.
      console.warn("[app-fork] Source manifest is not valid JSON.");
      return { ok: true };
    }
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { ok: true };
    console.warn("[app-fork] Could not inspect source manifest:", error);
    return { ok: false, error: INVALID_INSTALL_MANIFEST };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function installIdentityError(sourceDir: string, slug: string): string | undefined {
  // Restrict this copy API to an app slug, so path traversal cannot target the
  // bundled directory or one of its assets through a normalized alias.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(slug)) return "Invalid app slug.";
  if (isReservedAppSlug(slug)) return RESERVED_APP_INSTALL_ERROR;
  const source = readInstallManifest(sourceDir);
  if (!source.ok) return source.error;
  if (hasReservedAppIdentity(source.manifest)) return RESERVED_APP_INSTALL_ERROR;
}

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
const writeFileNow = fs.writeFileSync as (
  path: fs.PathOrFileDescriptor,
  data: string,
) => void;

export function forkApp(options: ForkOptions): ForkResult {
  const { sourceDir, homePath, slug, author, version } = options;

  if (!existsSync(sourceDir)) {
    return { success: false, error: `Source app not found: ${sourceDir}` };
  }

  const identityError = installIdentityError(sourceDir, slug);
  if (identityError) return { success: false, error: identityError };

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

  const identityError = installIdentityError(sourceDir, slug);
  if (identityError) return { success: false, error: identityError };

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
