import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, appendFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { openLocalChatSource } from "../../packages/sync-client/src/import/local-chat-source.js";
const sourceId = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
const raw = [{ type: "user", sessionId: sourceId, uuid: "synthetic-user", message: { content: "Synthetic input" } },
  { type: "assistant", sessionId: sourceId, uuid: "synthetic-assistant", message: { id: "response", stop_reason: "end_turn", content: [{ type: "text", text: "Synthetic reply" }] } }]
  .map(value => JSON.stringify(value)).join("\n") + "\n";
describe("captured local transcript source", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "matrix-import-source-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  it("previews and reads a stable byte boundary while later records append", async () => {
    const path = join(dir, "selected.jsonl"); await writeFile(path, raw);
    const source = await openLocalChatSource(path);
    try {
      await appendFile(path, '{"later":"record"}\n');
      const preview = await source.preview("claude"); expect(preview.rawBytes).toBe(Buffer.byteLength(raw));
      expect(preview.sourceHash).toBe(createHash("sha256").update(raw).digest("hex"));
      expect(Buffer.from(await source.read(0, preview.rawBytes, new AbortController().signal)).toString()).toBe(raw);
    } finally { await source.close(); }
  });
  it("rejects symlinks and non-regular files before inspecting content", async () => {
    const path = join(dir, "selected.jsonl"); await writeFile(path, raw); const alias = join(dir, "alias.jsonl"); await symlink(path, alias);
    await expect(openLocalChatSource(alias)).rejects.toMatchObject({ code: "invalid" });
    await expect(openLocalChatSource(dir)).rejects.toMatchObject({ code: "invalid" });
  });
  it("fails reads when the captured boundary disappears and supports cancellation", async () => {
    const path = join(dir, "selected.jsonl"); await writeFile(path, raw); const source = await openLocalChatSource(path);
    try {
      await writeFile(path, "short"); await expect(source.read(0, Buffer.byteLength(raw), new AbortController().signal)).rejects.toMatchObject({ code: "source_changed" });
      const controller = new AbortController(); controller.abort(); await expect(source.read(0, 1, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    } finally { await source.close(); }
  });
});
