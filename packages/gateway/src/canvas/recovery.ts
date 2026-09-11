import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CanvasIdSchema } from "./contracts.js";
import type { CanvasRecord } from "./repository.js";

export interface RecoveryDeps {
  tmpDir: string;
  now?: () => number;
}

export interface CleanupPolicy {
  ttlMs: number;
  maxFiles: number;
}

export async function materializeCanvasExport(record: CanvasRecord, deps: RecoveryDeps): Promise<string> {
  const now = deps.now?.() ?? Date.now();
  const canvasId = CanvasIdSchema.parse(record.id);
  const finalPath = join(deps.tmpDir, `canvas-${canvasId}-${now}.json`);
  const tempPath = `${finalPath}.tmp`;
  await mkdir(dirname(finalPath), { recursive: true });
  await writeFile(tempPath, JSON.stringify({ canvas: record, exportedAt: new Date(now).toISOString() }, null, 2), { flag: "wx" });
  await rename(tempPath, finalPath);
  return finalPath;
}

export function reconcileCanvasRecord(record: CanvasRecord, liveRefs: { terminalRefs?: Set<string>; projectIds?: Set<string>; reviewLoopIds?: Set<string> } = {}): CanvasRecord {
  const nodes = record.nodes.map((node) => {
    if (typeof node !== "object" || node === null) return node;
    const sourceRef = (node as { sourceRef?: { kind?: string; id?: string; terminalRef?: { workspaceId: string; tabId: string } } | null }).sourceRef;
    if (!sourceRef) return node;
    const missingTerminal =
      liveRefs.terminalRefs !== undefined &&
      sourceRef.kind === "terminal_tab" &&
      (!sourceRef.terminalRef ||
        !liveRefs.terminalRefs.has(`${sourceRef.terminalRef.workspaceId}:${sourceRef.terminalRef.tabId}`));
    const missingProject =
      liveRefs.projectIds !== undefined &&
      sourceRef.kind === "project" &&
      (!sourceRef.id || !liveRefs.projectIds.has(sourceRef.id));
    const missingReview =
      liveRefs.reviewLoopIds !== undefined &&
      sourceRef.kind === "review_loop" &&
      (!sourceRef.id || !liveRefs.reviewLoopIds.has(sourceRef.id));
    if (missingTerminal || missingProject || missingReview) {
      return { ...node, displayState: "recoverable", metadata: { ...(node as { metadata?: object }).metadata, recoveryReason: "missing_reference" } };
    }
    return node;
  });
  return { ...record, nodes };
}

export async function cleanupCanvasTempFiles(dir: string, policy: CleanupPolicy, now = Date.now()): Promise<number> {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.startsWith("canvas-")) continue;
    const path = join(dir, entry);
    const info = await lstat(path);
    if (info.isSymbolicLink()) continue;
    candidates.push({ path, mtimeMs: info.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let removed = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const expired = now - candidate.mtimeMs > policy.ttlMs;
    const overCount = index >= policy.maxFiles;
    if (expired || overCount) {
      await rm(candidate.path, { force: true, recursive: false });
      removed += 1;
    }
  }
  return removed;
}
