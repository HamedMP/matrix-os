import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveWithinHome } from "./path-security.js";

export interface ProjectInfo {
  name: string;
  path: string;
  isGit: boolean;
  branch: string | null;
  dirtyCount: number;
  modified: string | null;
}

type GitExec = (
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ stdout: string }>;

const execGit: GitExec = async (args, options) => {
  const exec = promisify(execFile);
  const { stdout } = await exec("git", args, {
    cwd: options.cwd,
    encoding: "utf-8",
    timeout: options.timeout,
  });
  return { stdout };
};

function isIgnoredFsError(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code !== undefined &&
    ["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code!)
  );
}

function logUnexpectedProjectError(context: string, err: unknown): void {
  if (isIgnoredFsError(err)) {
    return;
  }
  console.warn(`[projects] ${context}:`, err instanceof Error ? err.message : err);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function inspectProject(
  entry: Dirent,
  resolvedRoot: string,
  rootParam: string,
  runGit: GitExec,
): Promise<ProjectInfo | null> {
  const fullPath = join(resolvedRoot, entry.name);
  const relPath = rootParam === "." ? entry.name : `${rootParam.replace(/\/+$/, "")}/${entry.name}`;
  let branch: string | null = null;
  let dirtyCount = 0;
  let isGit = false;
  let modified: string | null = null;

  try {
    const linkStat = await lstat(fullPath);
    if (linkStat.isSymbolicLink()) {
      return null;
    }
    if (!linkStat.isDirectory()) {
      return null;
    }
    modified = new Date(linkStat.mtimeMs).toISOString();
  } catch (err: unknown) {
    logUnexpectedProjectError(`Failed to inspect ${relPath}`, err);
    return null;
  }

  try {
    await stat(join(fullPath, ".git"));
    const { stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: fullPath,
      timeout: 2000,
    });
    branch = stdout.trim();
    isGit = true;
  } catch (err: unknown) {
    logUnexpectedProjectError(`Failed to read git branch for ${relPath}`, err);
    isGit = false;
  }

  if (isGit) {
    try {
      const { stdout } = await runGit(["status", "--porcelain"], {
        cwd: fullPath,
        timeout: 2000,
      });
      dirtyCount = stdout.split("\n").filter((line) => line.trim().length > 0).length;
    } catch (err: unknown) {
      logUnexpectedProjectError(`Failed to read git status for ${relPath}`, err);
    }
  }

  return {
    name: entry.name,
    path: relPath,
    isGit,
    branch,
    dirtyCount,
    modified,
  };
}

export async function listProjects(
  homePath: string,
  rootParam: string,
  options: { runGit?: GitExec; concurrency?: number } = {},
): Promise<{ ok: true; root: string; projects: ProjectInfo[] } | { ok: false; status: number; error: string }> {
  const normalizedRoot = rootParam.trim();
  if (normalizedRoot.length === 0 || normalizedRoot.length > 1024) {
    return { ok: false, status: 400, error: "Invalid root" };
  }

  const resolved = resolveWithinHome(homePath, normalizedRoot);
  if (!resolved) {
    return { ok: false, status: 400, error: "Invalid root" };
  }

  let entries: Dirent[];
  try {
    entries = await readdir(resolved, { withFileTypes: true, encoding: "utf8" });
  } catch (err: unknown) {
    logUnexpectedProjectError(`Failed to read root ${normalizedRoot}`, err);
    return { ok: true, root: normalizedRoot, projects: [] };
  }

  const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  const inspected = await mapWithConcurrency(
    dirs,
    options.concurrency ?? 8,
    (entry) => inspectProject(entry, resolved, normalizedRoot, options.runGit ?? execGit),
  );
  const projects = inspected.filter((project): project is ProjectInfo => project !== null);

  projects.sort((a, b) => {
    if (!a.modified || !b.modified) return a.name.localeCompare(b.name);
    return b.modified.localeCompare(a.modified);
  });

  return { ok: true, root: normalizedRoot, projects };
}
