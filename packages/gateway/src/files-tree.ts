import { readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { resolveWithinHome } from "./path-security.js";

export interface FileTreeEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  gitStatus: string | null;
  changedCount?: number;
}

interface GitStatusCache {
  map: Map<string, string>;
  timestamp: number;
  gitRoot: string;
}

let cache: GitStatusCache | null = null;
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

function getGitStatusMap(dirPath: string): Map<string, string> | null {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    return cache.map;
  }

  try {
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dirPath,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    const output = execFileSync("git", ["status", "--porcelain"], {
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

    cache = { map, timestamp: Date.now(), gitRoot };
    return map;
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

export function listDirectory(
  homePath: string,
  requestedPath: string,
): FileTreeEntry[] | null {
  const resolved = resolveWithinHome(homePath, requestedPath);
  if (!resolved) return null;

  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(resolved, { withFileTypes: true });
  } catch {
    return null;
  }

  const gitMap = getGitStatusMap(resolved);

  let gitRoot = "";
  if (gitMap && cache) {
    gitRoot = cache.gitRoot;
  }

  const dirs: FileTreeEntry[] = [];
  const files: FileTreeEntry[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const fullPath = join(resolved, entry.name);

    if (entry.isDirectory()) {
      const changedCount = gitMap
        ? countChangedFiles(gitMap, gitRoot, fullPath)
        : 0;
      dirs.push({
        name: entry.name,
        type: "directory",
        gitStatus: null,
        changedCount,
      });
    } else if (entry.isFile()) {
      let gitStatus: string | null = null;
      if (gitMap) {
        const relPath = relative(gitRoot, fullPath);
        gitStatus = gitMap.get(relPath) ?? null;
      }

      let size = 0;
      try {
        size = statSync(fullPath).size;
      } catch {
        // ignore
      }

      files.push({
        name: entry.name,
        type: "file",
        size,
        gitStatus,
      });
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  return [...dirs, ...files];
}

export function clearGitStatusCache(): void {
  cache = null;
}
