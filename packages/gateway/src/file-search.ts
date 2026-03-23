import { readdir, stat, open } from "node:fs/promises";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { resolveWithinHome } from "./path-security.js";
import { isBinaryFile } from "./file-utils.js";

const SKIP_DIRS = new Set([".git", ".trash", "node_modules", ".next"]);
const MAX_CONTENT_SIZE = 1024 * 1024; // 1MB

interface SearchMatch {
  line?: number;
  text: string;
  type: "name" | "content";
}

interface SearchResultEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  matches: SearchMatch[];
}

interface SearchOptions {
  q: string;
  path?: string;
  content?: boolean;
  limit?: number;
}

interface SearchResult {
  query: string;
  results: SearchResultEntry[];
  truncated: boolean;
}

export async function fileSearch(
  homePath: string,
  options: SearchOptions,
): Promise<SearchResult> {
  const { q, path: searchPath = "", content = false, limit = 100 } = options;
  const effectiveLimit = Math.min(limit, 500);
  const results: SearchResultEntry[] = [];
  const queryLower = q.toLowerCase();

  const startDir = resolveWithinHome(homePath, searchPath);
  if (!startDir) return { query: q, results: [], truncated: false };

  let truncated = false;

  async function walk(dirPath: string): Promise<void> {
    if (truncated) return;

    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;

      const fullPath = join(dirPath, entry.name);
      const relPath = relative(homePath, fullPath);

      const matches: SearchMatch[] = [];

      if (entry.name.toLowerCase().includes(queryLower)) {
        matches.push({ text: entry.name, type: "name" });
      }

      if (entry.isDirectory()) {
        if (matches.length > 0) {
          results.push({
            path: relPath,
            name: entry.name,
            type: "directory",
            matches,
          });
          if (results.length >= effectiveLimit) {
            truncated = true;
            return;
          }
        }
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (content && !isBinaryFile(entry.name)) {
          try {
            const stats = await stat(fullPath);
            if (stats.size <= MAX_CONTENT_SIZE) {
              const contentMatches = await searchFileContent(
                fullPath,
                queryLower,
              );
              matches.push(...contentMatches);
            }
          } catch {
            // skip unreadable files
          }
        }

        if (matches.length > 0) {
          results.push({
            path: relPath,
            name: entry.name,
            type: "file",
            matches,
          });
          if (results.length >= effectiveLimit) {
            truncated = true;
            return;
          }
        }
      }
    }
  }

  await walk(startDir);
  return { query: q, results, truncated };
}

async function searchFileContent(
  filePath: string,
  queryLower: string,
): Promise<SearchMatch[]> {
  const matches: SearchMatch[] = [];
  const fileHandle = await open(filePath, "r");
  try {
    const stream = fileHandle.createReadStream({ encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNum = 0;
    for await (const line of rl) {
      lineNum++;
      if (line.toLowerCase().includes(queryLower)) {
        matches.push({
          line: lineNum,
          text: line.trimStart(),
          type: "content",
        });
        if (matches.length >= 5) break;
      }
    }
  } finally {
    await fileHandle.close();
  }
  return matches;
}
