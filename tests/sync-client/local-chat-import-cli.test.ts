import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const sourceId = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
describe("local Chat CLI dry-run", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "matrix-import-cli-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  it("previews Claude history without credentials, network, or publishing", async () => {
    const path = join(dir, "claude.jsonl"); await writeFile(path, JSON.stringify({ type: "user", sessionId: sourceId, uuid: "u", message: { content: "Synthetic selected prompt" } }) + "\n");
    const result = await exec(process.execPath, ["--import", "tsx", "packages/sync-client/src/cli/index.ts", "chats", "import", "claude", path, "--json"], { timeout: 15_000 });
    const body = JSON.parse(result.stdout); expect(body).toMatchObject({ ok: true, data: { applied: false, preview: { harness: "claude", sourceId, counts: { humanInputs: 1 } } } });
    expect(body.data.preview.sourceHash).toMatch(/^[a-f0-9]{64}$/); expect(body.data).not.toHaveProperty("chatId");
  });
  it("discovers local session metadata without authentication or message text", async () => {
    const root=join(dir,"codex"); await (await import("node:fs/promises")).mkdir(join(root,"sessions"),{recursive:true});
    await writeFile(join(root,"sessions","one.jsonl"),JSON.stringify({type:"session_meta",payload:{id:sourceId,cwd:"/recorded/repo"}})+"\n"+JSON.stringify({type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"PRIVATE MESSAGE"}]}})+"\n");
    const result=await exec(process.execPath,["--import","tsx","packages/sync-client/src/cli/index.ts","chats","discover","--json"],{timeout:15000,env:{...process.env,CODEX_HOME:root,CLAUDE_CONFIG_DIR:join(dir,"missing")}});
    expect(JSON.parse(result.stdout)).toMatchObject({ok:true,data:{files:[{sourceId,association:"unresolved"}]}});expect(result.stdout).not.toContain("PRIVATE MESSAGE");
  });
});
