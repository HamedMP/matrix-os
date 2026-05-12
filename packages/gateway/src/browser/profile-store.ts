import { mkdir, rename, rm, lstat, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, relative } from "node:path";

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
  return {
    stagingPath: join(stagingDir, `${Date.now()}-${safeName}.part`),
    finalPath: join(finalDir, safeName),
  };
}

export async function publishBrowserDownload(stagingPath: string, finalPath: string): Promise<void> {
  await mkdir(dirname(finalPath), { recursive: true });
  await rename(stagingPath, finalPath);
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
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) continue;
    if (now - stat.mtimeMs > opts.maxAgeMs) {
      await rm(path, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
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
    await publishBrowserDownload(paths.stagingPath, paths.finalPath);
    await opts.callbacks.complete({ id: record.id, completedPath: paths.finalPath });
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
