import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanUsageRoots } from "../../scripts/ai-usage/scan";
describe("computer usage scan", () => {
  it("uses the real file-reader/parser path, skips symlinks and reports missing roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-usage-"));
    try {
      await mkdir(join(root, "sessions"));
      const row = {
        type: "assistant",
        timestamp: "2026-11-09T12:00:00Z",
        sessionId: "s",
        message: {
          id: "m",
          model: "future",
          usage: { input_tokens: 2, output_tokens: 3 },
          content: "PRIVATE CONTENT",
        },
      };
      await writeFile(
        join(root, "sessions", "one.jsonl"),
        JSON.stringify(row) + "\n",
      );
      await symlink(
        join(root, "sessions", "one.jsonl"),
        join(root, "sessions", "mirror.jsonl"),
      );
      const result = await scanUsageRoots([
        join(root, "sessions"),
        join(root, "missing"),
      ]);
      expect(result.events).toHaveLength(1);
      expect(result.issues).toBe(2);
      expect(JSON.stringify(result)).not.toContain("PRIVATE CONTENT");
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
