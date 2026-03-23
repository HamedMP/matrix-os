import { readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, relative, extname } from "node:path";
import { promisify } from "node:util";
import { resolveWithinHome } from "./path-security.js";
import { getMimeType } from "./file-utils.js";

const execFileAsync = promisify(execFile);

export interface FileTreeEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  gitStatus: string | null;
  changedCount?: number;
  modified?: string;
  created?: string;
  mime?: string;
  children?: number;
}

interface GitStatusCache {
  map: Map<string, string>;
  timestamp: number;
  gitRoot: string;
}

const MAX_CACHE_ENTRIES = 20;
const cacheMap = new Map<string, GitStatusCache>();
const CACHE_TTL_MS = 2000;

function parseGitStatusCode(code: string): string {
  const xy = code.trim();
  if (xy === "??") return "untracked";
  if (xy.startsWith("A") || xy.endsWith("A")) return "added";
  if (xy.startsWith("D") || xy.endsWith("D")) return "deleted";
  if (xy.startsWith("R") || xy.endsWith("R")) return "renamed";
  if (xy.startsWith("M") || xy.endsWith("M")) return "modified";
  return "modified";
}

async function getGitStatusMap(dirPath: string): Promise<{ map: Map<string, string>; gitRoot: string } | null> {
  try {
    const { stdout: gitRootRaw } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dirPath,
      encoding: "utf-8",
      timeout: 5000,
    });
    const gitRoot = gitRootRaw.trim();

    const cached = cacheMap.get(gitRoot);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return { map: cached.map, gitRoot: cached.gitRoot };
    }

    const { stdout: output } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: gitRoot,
      encoding: "utf-8",
      timeout: 5000,
    });

    const map = new Map<string, string>();
    for (const line of output.split("\n")) {
      if (line.length < 4) continue;
      const statusCode = line.slice(0, 2);
      const filePath = line.slice(3).split(" -> ").pop()!;
      map.set(filePath, parseGitStatusCode(statusCode));
    }

    if (cacheMap.size >= MAX_CACHE_ENTRIES) {
      const oldest = cacheMap.keys().next().value;
      if (oldest) cacheMap.delete(oldest);
    }
    cacheMap.set(gitRoot, { map, timestamp: Date.now(), gitRoot });
    return { map, gitRoot };
  } catch {
    return null;
  }
}

function countChangedFiles(
  gitMap: Map<string, string>,
  gitRoot: string,
  dirAbsPath: string,
): number {
  const dirRel = relative(gitRoot, dirAbsPath);
  const prefix = dirRel ? dirRel + "/" : "";
  let count = 0;
  for (const [path] of gitMap) {
    if (path.startsWith(prefix)) count++;
  }
  return count;
}

export async function listDirectory(
  homePath: string,
  requestedPath: string,
): Promise<FileTreeEntry[] | null> {
  const resolved = resolveWithinHome(homePath, requestedPath);
  if (!resolved) return null;

  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(resolved, { withFileTypes: true });
  } catch {
    return null;
  }

  const gitResult = await getGitStatusMap(resolved);
  const gitMap = gitResult?.map ?? null;
  const gitRoot = gitResult?.gitRoot ?? "";

  const dirs: FileTreeEntry[] = [];
  const files: FileTreeEntry[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const fullPath = join(resolved, entry.name);

    if (entry.isDirectory()) {
      const changedCount = gitMap
        ? countChangedFiles(gitMap, gitRoot, fullPath)
        : 0;

      let modified: string | undefined;
      let children: number | undefined;
      try {
        const dirStat = await stat(fullPath);
        modified = new Date(dirStat.mtimeMs).toISOString();
        const childEntries = await readdir(fullPath);
        children = childEntries.filter((c) => !c.startsWith(".")).length;
      } catch {
        // ignore
      }

      dirs.push({
        name: entry.name,
        type: "directory",
        gitStatus: null,
        changedCount,
        modified,
        children,
      });
    } else if (entry.isFile()) {
      let gitStatus: string | null = null;
      if (gitMap) {
        const relPath = relative(gitRoot, fullPath);
        gitStatus = gitMap.get(relPath) ?? null;
      }

      let size = 0;
      let modified: string | undefined;
      let created: string | undefined;
      try {
        const fileStat = await stat(fullPath);
        size = fileStat.size;
        modified = new Date(fileStat.mtimeMs).toISOString();
        created = new Date(fileStat.birthtimeMs).toISOString();
      } catch {
        // ignore
      }

      files.push({
        name: entry.name,
        type: "file",
        size,
        gitStatus,
        modified,
        created,
        mime: getMimeType(extname(entry.name)),
      });
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  return [...dirs, ...files];
}

export function clearGitStatusCache(): void {
  cacheMap.clear();
}
