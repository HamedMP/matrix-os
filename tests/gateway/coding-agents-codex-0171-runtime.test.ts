import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";

// Exercises the production app-server runner with the payload shapes that changed in
// Codex 0.170.0 (display union) and 0.171.0 (MCP registration scope, bioPolicy).
describe("Codex 0.170-0.171 notification compatibility", () => {
  it.each(["completed", "failed"])("preserves %s outcomes without treating display or scope metadata as authority", async status => {
    const home = await mkdtemp("/tmp/codex-0171-runtime-");
    const provider = join(home, "provider.mjs");
    const events = codexProviderEventPath(home, "sess_codex_0171_1");
    await writeFile(provider, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const emit = value => console.log(JSON.stringify(value));
const ids = {threadId:'native-thread-0171',turnId:'native-turn-0171'};
for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  const m = JSON.parse(line);
  if(m.method === 'initialize') emit({id:m.id,result:{userAgent:'fixture',platformFamily:'unix',platformOs:'linux',codexHome:'/private/codex'}});
  if(m.method === 'thread/start') emit({id:m.id,result:{thread:{id:'native-thread-0171'},modelProvider:'openai',cwd:'/private/project',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{}}});
  if(m.method === 'turn/start') {
    emit({id:m.id,result:{turn:{id:'native-turn-0171'}}});
    const tool = {id:'native-tool-0171',type:'mcpToolCall',server:'fixture',tool:'lookup',arguments:{},status:'completed',environmentId:'private-registration-scope'};
    emit({method:'item/started',params:{...ids,item:tool}});
    emit({method:'item/completed',params:{...ids,item:tool}});
    const item = {id:'native-answer-0171',type:'agentMessage',phase:'final_answer',text:'Safe provider answer.',moderation:{moderated:true,display:{version:1,mode:'block',reason:{kind:'cyber',trustedAccess:true}}}};
    emit({method:'item/started',params:{...ids,item}});
    emit({method:'item/completed',params:{...ids,item,contentTokenCount:8}});
    emit({method:'turn/completed',params:{threadId:'native-thread-0171',turn:{id:'native-turn-0171',status:${JSON.stringify(status)},items:[tool,item],error:${status === "failed" ? "{message:'private bio policy detail',codexErrorInfo:'bioPolicy',additionalDetails:null}" : "null"}}}});
    process.exit(0);
  }
}
`);
    await chmod(provider, 0o700);
    const config = Buffer.from(JSON.stringify({ prompt: "Compatibility fixture", approvalPolicy: "on-request", sandbox: "workspace-write", writableRoots: [home] })).toString("base64");
    const runner = join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs");
    const child = spawn(process.execPath, [runner, events, process.version.slice(1), process.execPath, provider, config], { cwd: home, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-4000); });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 8_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(code, stderr).toBe(status === "completed" ? 0 : 1);
      const raw = await readFile(events, "utf8");
      expect(raw, stderr).not.toBe("");
      const transcript = raw.trim().split("\n").map(line => JSON.parse(line));
      expect(transcript).toContainEqual(expect.objectContaining({ type: status === "completed" ? "turn.completed" : "turn.failed" }));
      expect(raw).toContain("Safe provider answer.");
      expect(raw).toContain("Use fixture.lookup");
      expect(raw).not.toMatch(/trustedAccess|private-registration-scope|environmentId|private bio policy detail/);
      expect(transcript.some(event => event.type === "matrix.codex.approval.requested")).toBe(false);
    } finally {
      clearTimeout(timeout);
      child.kill("SIGTERM");
      await rm(home, { recursive: true, force: true });
    }
  });
});
