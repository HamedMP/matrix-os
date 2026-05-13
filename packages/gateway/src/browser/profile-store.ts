import { mkdir, rm, lstat, readdir, link } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";

export function resolveWithinHome(homePath: string, ...segments: string[]): string {
  const base = resolve(homePath);
  const target = resolve(base, ...segments);
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("invalid_path");
  }
  return target;
}

export function sanitizeBrowserFilename(filename: string): string {
  const clean = basename(filename).replace(/[^\w. -]/g, "_").slice(0, 180).trim();
  if (!clean || clean === "." || clean === "..") {
    return "download";
  }
  return clean;
}

export async function createBrowserDownloadPaths(homePath: string, filename: string): Promise<{
  stagingPath: string;
  finalPath: string;
}> {
  const safeName = sanitizeBrowserFilename(filename);
  const stagingDir = resolveWithinHome(homePath, "system", "browser", "downloads", "staging");
  const finalDir = resolveWithinHome(homePath, "files", "downloads");
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  await mkdir(finalDir, { recursive: true, mode: 0o755 });
  const nonce = randomUUID().replaceAll("-", "");
  return {
    stagingPath: join(stagingDir, `${Date.now()}-${nonce}-${safeName}.part`),
    finalPath: await uniqueBrowserDownloadPath(finalDir, safeName),
  };
}

export async function publishBrowserDownload(stagingPath: string, finalPath: string): Promise<string> {
  const finalDir = dirname(finalPath);
  const safeName = basename(finalPath);
  await mkdir(finalDir, { recursive: true });
  let candidate = finalPath;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      await link(stagingPath, candidate);
      await rm(stagingPath, { force: true });
      return candidate;
    } catch (error: unknown) {
      if (!isNodeErrorCode(error, "EEXIST")) throw error;
      candidate = await uniqueBrowserDownloadPath(finalDir, safeName);
    }
  }
  throw new Error("download_path_exhausted");
}

export async function deleteBrowserDownloadArtifacts(homePath: string, paths: {
  stagingPath?: string | null;
  finalPath?: string | null;
}): Promise<void> {
  for (const candidate of [paths.stagingPath, paths.finalPath]) {
    if (!candidate) continue;
    resolveWithinHome(homePath, relative(resolve(homePath), resolve(candidate)));
    await rm(candidate, { force: true });
  }
}

export async function sweepBrowserTempFiles(dir: string, opts: { maxAgeMs: number; now?: number }): Promise<number> {
  const now = opts.now ?? Date.now();
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return 0;
    }
    console.warn("[browser/profile-store] temp sweep failed to read directory:", error instanceof Error ? error.message : String(error));
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(path);
    } catch (error: unknown) {
      if (isNodeErrorCode(error, "ENOENT")) continue;
      console.warn("[browser/profile-store] temp sweep failed to stat entry:", error instanceof Error ? error.message : String(error));
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (now - stat.mtimeMs > opts.maxAgeMs) {
      await rm(path, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

async function uniqueBrowserDownloadPath(finalDir: string, safeName: string): Promise<string> {
  const extension = extname(safeName);
  const stem = extension ? safeName.slice(0, -extension.length) : safeName;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const name = attempt === 0 ? safeName : `${stem} (${attempt})${extension}`;
    const candidate = join(finalDir, name);
    try {
      await lstat(candidate);
    } catch (error: unknown) {
      if (isNodeErrorCode(error, "ENOENT")) return candidate;
      throw error;
    }
  }
  throw new Error("download_path_exhausted");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

export interface BrowserDownloadLike {
  suggestedFilename(): string;
  saveAs(path: string): Promise<void>;
  failure?(): Promise<string | null>;
  delete?(): Promise<void>;
}

export interface BrowserDownloadHookPage {
  on(event: "download", handler: (download: BrowserDownloadLike) => void): void;
}

export interface BrowserDownloadHookCallbacks {
  create(input: {
    filename: string;
    stagedPath: string;
    finalPath: string;
  }): Promise<{ id: string }>;
  complete(input: { id: string; completedPath: string }): Promise<void>;
  fail(input: { id: string }): Promise<void>;
}

export function installBrowserDownloadHooks(
  page: BrowserDownloadHookPage,
  opts: {
    homePath: string;
    callbacks: BrowserDownloadHookCallbacks;
  },
): void {
  page.on("download", (download) => {
    void handleBrowserDownload(download, opts).catch((error: unknown) => {
      console.warn(
        "[browser/profile-store] download hook failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  });
}

async function handleBrowserDownload(
  download: BrowserDownloadLike,
  opts: {
    homePath: string;
    callbacks: BrowserDownloadHookCallbacks;
  },
): Promise<void> {
  const filename = sanitizeBrowserFilename(download.suggestedFilename());
  const paths = await createBrowserDownloadPaths(opts.homePath, filename);
  const record = await opts.callbacks.create({
    filename,
    stagedPath: paths.stagingPath,
    finalPath: paths.finalPath,
  });

  try {
    await download.saveAs(paths.stagingPath);
    const failure = download.failure ? await download.failure() : null;
    if (failure) {
      await rm(paths.stagingPath, { force: true });
      await opts.callbacks.fail({ id: record.id });
      return;
    }
    const completedPath = await publishBrowserDownload(paths.stagingPath, paths.finalPath);
    await opts.callbacks.complete({ id: record.id, completedPath });
  } catch (error: unknown) {
    await rm(paths.stagingPath, { force: true }).catch((rmError: unknown) => {
      console.warn(
        "[browser/profile-store] failed to remove staged download:",
        rmError instanceof Error ? rmError.message : String(rmError),
      );
    });
    await opts.callbacks.fail({ id: record.id });
    if (download.delete) {
      await download.delete().catch((deleteError: unknown) => {
        console.warn(
          "[browser/profile-store] failed to delete Chromium download:",
          deleteError instanceof Error ? deleteError.message : String(deleteError),
        );
      });
    }
    throw error;
  }
}
