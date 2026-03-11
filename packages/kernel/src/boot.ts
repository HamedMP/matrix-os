import { existsSync, cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_HOME = join(
  process.env.HOME ?? process.env.USERPROFILE ?? ".",
  "matrixos",
);

const TEMPLATE_DIR = resolve(
  import.meta.dirname ?? ".",
  "..",
  "..",
  "..",
  "home",
);

export function ensureHome(homePath: string = DEFAULT_HOME): string {
  if (existsSync(homePath)) {
    syncTemplate(homePath);
    return homePath;
  }

  mkdirSync(homePath, { recursive: true });
  cpSync(TEMPLATE_DIR, homePath, { recursive: true });

  initGit(homePath);

  return homePath;
}

/**
 * Sync new template files into an existing home directory.
 * Only adds files that don't already exist - never overwrites user data.
 */
function syncTemplate(homePath: string): void {
  if (!existsSync(TEMPLATE_DIR)) return;

  let added = 0;
  copyMissing(TEMPLATE_DIR, homePath);

  if (added > 0) {
    gitCommit(homePath, `OS update: added ${added} new file${added > 1 ? "s" : ""}`);
  }

  function copyMissing(src: string, dest: string): void {
    if (!existsSync(src)) return;

    const entries = readdirSync(src);
    for (const entry of entries) {
      const srcPath = join(src, entry);
      const destPath = join(dest, entry);
      const stat = statSync(srcPath);

      if (stat.isDirectory()) {
        if (!existsSync(destPath)) {
          cpSync(srcPath, destPath, { recursive: true });
          const fileCount = countFiles(srcPath);
          added += fileCount;
        } else {
          copyMissing(srcPath, destPath);
        }
      } else if (!existsSync(destPath)) {
        mkdirSync(dest, { recursive: true });
        cpSync(srcPath, destPath);
        added++;
      }
    }
  }
}

function countFiles(dir: string): number {
  let count = 0;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const p = join(dir, entry);
    const stat = statSync(p);
    if (stat.isDirectory()) {
      count += countFiles(p);
    } else {
      count++;
    }
  }
  return count;
}

function initGit(dir: string) {
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", [
      "commit",
      "-m",
      "Matrix OS: initial state",
    ], { cwd: dir, stdio: "ignore" });
  } catch {
    // Git not available -- not critical for operation
  }
}

function gitCommit(dir: string, message: string) {
  try {
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: dir, stdio: "ignore" });
  } catch {
    // diff --cached exits 1 when there are staged changes = commit needed
    try {
      execFileSync("git", ["commit", "-m", message], { cwd: dir, stdio: "ignore" });
    } catch {
      // Git not available or nothing to commit
    }
  }
}
