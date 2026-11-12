import { expect, it, vi } from "vitest";
import { mkdtemp, writeFile, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageInput } from "../../packages/gateway/src/ai-usage/history-input";
it("seeks directly to the committed plaintext offset", async () => {
 const root = await mkdtemp(join(tmpdir(), "usage-seek-"));
 const file = join(root, "session.jsonl");
 await writeFile(file, "x".repeat(100));
 const handle = await open(file, "r");
 try {
  const read = vi.spyOn(handle, "read");
  const chunks = [];
  for await (const chunk of usageInput(handle, file, 100, 80)) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).length).toBe(20);
  expect(read.mock.calls[0][3]).toBe(80);
 } finally { await handle.close(); await rm(root, {recursive:true}); }
});
