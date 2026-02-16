import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PluginOrigin } from "./types.js";

const SUSPICIOUS_PATTERNS = [
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bchild_process\b/,
  /\bexecSync\b/,
  /\bexecFile\b/,
  /\bspawnSync\b/,
  /\brequire\s*\(\s*['"]child_process['"]\s*\)/,
  /\bprocess\.env\b/,
  /\bfs\.(?:unlink|rmdir|rm)Sync\b/,
];

export interface ScanResult {
  suspicious: boolean;
  patterns: string[];
  file?: string;
}

export function scanPluginCode(pluginDir: string): ScanResult[] {
  const results: ScanResult[] = [];

  function scanDir(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git") continue;
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.endsWith(".ts") || entry.endsWith(".js") || entry.endsWith(".mjs")) {
          const content = readFileSync(fullPath, "utf-8");
          const found: string[] = [];
          for (const pattern of SUSPICIOUS_PATTERNS) {
            if (pattern.test(content)) {
              found.push(pattern.source);
            }
          }
          if (found.length > 0) {
            results.push({ suspicious: true, patterns: found, file: fullPath });
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  scanDir(pluginDir);
  return results;
}

export function checkOriginTrust(origin: PluginOrigin): { trusted: boolean; warnOnLoad: boolean } {
  switch (origin) {
    case "bundled":
      return { trusted: true, warnOnLoad: false };
    case "workspace":
      return { trusted: true, warnOnLoad: false };
    case "config":
      return { trusted: false, warnOnLoad: true };
  }
}

export function auditRegistration(pluginId: string, action: string, detail: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] [plugin-audit] ${pluginId}: ${action} -- ${detail}`;
}
