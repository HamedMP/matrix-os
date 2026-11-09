/** Read-only POC: bun scripts/ai-usage/scan.ts [explicit-root ...] > /private/path/usage.json
 * Metrics only; no network, credentials or transcript text. Set umask 077 before redirecting.
 */
import { createReadStream } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  MAX_USAGE_EVENTS,
  MAX_USAGE_FILES,
  MAX_USAGE_FILE_BYTES,
  mergeUsageEvents,
  readUsageSource,
  type UsageEvent,
} from "./index";
export function usageRoots(
  home: string,
  config: { codexRoot?: string; claudeRoot?: string } = {},
) {
  const codex = config.codexRoot ?? join(home, ".codex"),
    claude = config.claudeRoot ?? join(home, ".claude");
  return [
    join(claude, "projects"),
    join(codex, "sessions"),
    join(codex, "archived_sessions"),
  ];
}
export async function scanUsageRoots(
  roots: string[],
  signal: AbortSignal = AbortSignal.timeout(60_000),
) {
  const events: UsageEvent[] = [],
    files: Array<{ path: string; modified: number }> = [];
  let issues = 0,
    entries = 0,
    totalBytes = 0;
  async function walk(path: string, depth = 0): Promise<void> {
    signal.throwIfAborted();
    if (depth > 10 || entries >= 20_000 || files.length >= 20_000) {
      issues++;
      return;
    }
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        issues++;
        return;
      }
      if (stat.isDirectory()) {
        const dir = await opendir(path);
        for await (const entry of dir) {
          entries++;
          if (entries > 20_000 || files.length >= 20_000) {
            issues++;
            break;
          }
          if (entry.isSymbolicLink()) {
            issues++;
            continue;
          }
          if (entry.isDirectory() || entry.name.endsWith(".jsonl"))
            await walk(join(path, entry.name), depth + 1);
        }
      } else if (stat.isFile() && path.endsWith(".jsonl"))
        files.push({ path, modified: stat.mtimeMs });
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["ENOENT", "EACCES", "ENOTDIR"].includes(String(error.code))
      ) {
        issues++;
        return;
      }
      throw error;
    }
  }
  // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential roots preserve one filesystem traversal budget
  for (const root of roots) await walk(resolve(root));
  files.sort((a, b) => b.modified - a.modified);
  if (files.length > MAX_USAGE_FILES) issues++;
  for (const { path: file } of files.slice(0, MAX_USAGE_FILES)) {
    signal.throwIfAborted();
    const stat = await lstat(file);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size > MAX_USAGE_FILE_BYTES
    ) {
      issues++;
      continue;
    }
    totalBytes += stat.size;
    if (totalBytes > 256 * 1024 * 1024) {
      issues++;
      break;
    }
    // Source hashes are fallback identities only; native session/request identities deduplicate copies.
    const source = createHash("sha256").update(file).digest("hex");
    const stream = createReadStream(file, { signal });
    try {
      const result = await readUsageSource(stream, source, signal);
      const remaining = MAX_USAGE_EVENTS - events.length;
      events.push(...result.events.slice(0, remaining));
      if (result.events.length > remaining) issues++;
      issues += result.issues;
    } finally {
      stream.destroy();
    }
    if (events.length >= MAX_USAGE_EVENTS) {
      issues++;
      break;
    }
  }
  const merged = mergeUsageEvents(events);
  return {
    version: 1 as const,
    events: merged.events,
    issues: issues + merged.conflicts,
  };
}
