import {
  existsSync, cpSync, mkdirSync, readdirSync, statSync,
  readFileSync, writeFileSync, appendFileSync,
} from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

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

export interface SyncReport {
  added: string[];
  updated: string[];
  skipped: string[];
}

export function ensureHome(homePath: string = DEFAULT_HOME): SyncReport & { homePath: string } {
  if (existsSync(homePath)) {
    const report = syncTemplate(homePath);
    return { ...report, homePath };
  }

  mkdirSync(homePath, { recursive: true });
  cpSync(TEMPLATE_DIR, homePath, { recursive: true });

  initGit(homePath);

  return { homePath, added: [], updated: [], skipped: [] };
}

const EXCLUDED_NAMES = new Set([".gitkeep", ".DS_Store", ".template-manifest.json"]);
const EXCLUDED_DIRS = new Set(["node_modules", ".cache", "tmp"]);

export function generateTemplateManifest(templateDir: string): Record<string, string> {
  const manifest: Record<string, string> = {};

  function walk(dir: string, prefix: string) {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (EXCLUDED_NAMES.has(entry)) continue;
      if (EXCLUDED_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);
      const relPath = prefix ? `${prefix}/${entry}` : entry;
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath, relPath);
      } else {
        const content = readFileSync(fullPath);
        const hash = createHash("sha256").update(content).digest("hex");
        manifest[relPath] = hash;
      }
    }
  }

  walk(templateDir, "");
  return manifest;
}

function hashFile(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export function smartSyncTemplate(
  homePath: string,
  templateDir: string,
): SyncReport {
  const report: SyncReport = { added: [], updated: [], skipped: [] };
  const logLines: string[] = [];
  const now = new Date().toISOString();

  logLines.push(`[${now}] Template sync started`);

  // Load template manifest
  const templateManifestPath = join(templateDir, ".template-manifest.json");
  if (!existsSync(templateManifestPath)) {
    logLines.push(`[${now}] No template manifest found, skipping sync`);
    logLines.push(`[${now}] Template sync completed: 0 updated, 0 added, 0 skipped`);
    writeSyncLog(homePath, logLines);
    return report;
  }

  const templateManifest: Record<string, string> = JSON.parse(
    readFileSync(templateManifestPath, "utf-8"),
  );

  // Load installed manifest (what was last synced to user's home)
  const installedManifestPath = join(homePath, ".template-manifest.json");
  let installedManifest: Record<string, string> = {};
  if (existsSync(installedManifestPath)) {
    installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf-8"));
  }

  for (const [relPath, templateHash] of Object.entries(templateManifest)) {
    const homeFilePath = join(homePath, relPath);
    const templateFilePath = join(templateDir, relPath);

    if (!existsSync(homeFilePath)) {
      // File doesn't exist in home -> ADD it
      const dir = dirname(homeFilePath);
      mkdirSync(dir, { recursive: true });
      cpSync(templateFilePath, homeFilePath);
      installedManifest[relPath] = templateHash;
      report.added.push(relPath);
      logLines.push(`[${now}] Added: ${relPath}`);
    } else {
      const userHash = hashFile(homeFilePath);
      const installedHash = installedManifest[relPath];

      if (installedHash === undefined) {
        // File exists in home but not tracked in installed manifest.
        // If user's content matches template, just track it; otherwise skip (conservative).
        if (userHash === templateHash) {
          installedManifest[relPath] = templateHash;
          // No action needed, content is identical
        } else {
          report.skipped.push(relPath);
          logLines.push(`[${now}] Skipped: ${relPath} (customized by user)`);
        }
      } else if (userHash === installedHash) {
        // User hasn't touched it -> UPDATE from template
        if (templateHash !== installedHash) {
          cpSync(templateFilePath, homeFilePath);
          installedManifest[relPath] = templateHash;
          report.updated.push(relPath);
          logLines.push(`[${now}] Updated: ${relPath}`);
        }
        // If templateHash === installedHash, file is already current, nothing to do
      } else {
        // User customized the file -> SKIP
        report.skipped.push(relPath);
        logLines.push(`[${now}] Skipped: ${relPath} (customized by user)`);
      }
    }
  }

  // Write updated installed manifest
  writeFileSync(installedManifestPath, JSON.stringify(installedManifest, null, 2));

  const summary = `${report.updated.length} updated, ${report.added.length} added, ${report.skipped.length} skipped`;
  logLines.push(`[${now}] Template sync completed: ${summary}`);

  writeSyncLog(homePath, logLines);

  return report;
}

function writeSyncLog(homePath: string, lines: string[]) {
  const logDir = join(homePath, "system", "logs");
  mkdirSync(logDir, { recursive: true });

  const logPath = join(logDir, "template-sync.log");
  const content = lines.join("\n") + "\n";
  appendFileSync(logPath, content);
}

function syncTemplate(homePath: string): SyncReport {
  if (!existsSync(TEMPLATE_DIR)) {
    return { added: [], updated: [], skipped: [] };
  }

  const report = smartSyncTemplate(homePath, TEMPLATE_DIR);

  const totalChanges = report.added.length + report.updated.length;
  if (totalChanges > 0) {
    const msg = `OS update: ${report.updated.length} files updated, ${report.added.length} new, ${report.skipped.length} skipped (customized)`;
    gitCommit(homePath, msg);
  }

  return report;
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
