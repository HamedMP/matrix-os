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
it("continues when one discovered transcript cannot be read",async()=>{
 const {chmod}=await import("node:fs/promises");
 const root=await mkdtemp(join(tmpdir(),"usage-unreadable-"));
 try{
  const row=JSON.stringify({type:"assistant",timestamp:"2026-11-09T12:00:00Z",sessionId:"s",message:{id:"m",model:"unknown",usage:{input_tokens:2,output_tokens:3}}})+"\n";
  await writeFile(join(root,"good.jsonl"),row);await writeFile(join(root,"unreadable.jsonl"),row);await chmod(join(root,"unreadable.jsonl"),0);
  const result=await scanUsageRoots([root]);expect(result.events).toHaveLength(1);expect(result.issues).toBe(1);
 }finally{await rm(root,{recursive:true});}
});
