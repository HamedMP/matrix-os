import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod/v4";
import { cleanupCanvasTempFiles, materializeCanvasExport, reconcileCanvasRecord } from "../../packages/gateway/src/canvas/recovery.js";

const now = "2026-04-27T00:00:00.000Z";

function record() {
  return {
    id: "cnv_0123456789abcdef",
    ownerScope: "personal",
    ownerId: "user_a",
    title: "Recover",
    scopeType: "global",
    scopeRef: null,
    revision: 1,
    schemaVersion: 1,
    nodes: [{ id: "node_terminal", type: "terminal", sourceRef: { kind: "terminal_session", id: "550e8400-e29b-41d4-a716-446655440000" }, displayState: "normal", metadata: {} }],
    edges: [],
    viewStates: [],
    displayOptions: {},
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  } as any;
}

describe("canvas recovery", () => {
  it("materializes export files through a temp file rename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-export-"));
    const path = await materializeCanvasExport(record(), { tmpDir: dir, now: () => Date.parse(now) });
    await expect(readFile(path, "utf8")).resolves.toContain("cnv_0123456789abcdef");
  });

  it("rejects unsafe canvas ids before materializing export paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-export-"));
    await expect(materializeCanvasExport({ ...record(), id: "cnv_../../escape" } as any, { tmpDir: dir })).rejects.toBeInstanceOf(ZodError);
  });

  it("marks missing linked references recoverable without deleting nodes", () => {
    const reconciled = reconcileCanvasRecord(record(), { terminalSessionIds: new Set() });
    expect(reconciled.nodes).toHaveLength(1);
    expect((reconciled.nodes[0] as any).displayState).toBe("recoverable");
  });

  it("cleans old temporary export bundles with ttl and max-count policies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-cleanup-"));
    await writeFile(join(dir, "canvas-old.json"), "{}");
    const removed = await cleanupCanvasTempFiles(dir, { ttlMs: 0, maxFiles: 0 }, Date.now() + 1);
    expect(removed).toBe(1);
  });

  it("skips symlinked export names during cleanup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-cleanup-"));
    const target = join(dir, "target.json");
    const link = join(dir, "canvas-link.json");
    await writeFile(target, "{}");
    await symlink(target, link);

    const removed = await cleanupCanvasTempFiles(dir, { ttlMs: 0, maxFiles: 0 }, Date.now() + 1);

    expect(removed).toBe(0);
    await expect(readFile(target, "utf8")).resolves.toBe("{}");
    await expect(readFile(link, "utf8")).resolves.toBe("{}");
  });
});
