import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";

describe("Codex 0.169 notification compatibility", () => {
  it.each(["completed", "failed"])("preserves %s outcomes without treating moderation metadata as authority", async status => {
    const home = await mkdtemp("/tmp/codex-0169-runtime-");
    const provider = join(home, "provider.mjs");
    const events = codexProviderEventPath(home, "sess_codex_0169_1");
    await writeFile(provider, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const emit = value => console.log(JSON.stringify(value));
for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  const m = JSON.parse(line);
  if(m.method === 'initialize') emit({id:m.id,result:{userAgent:'fixture',platformFamily:'unix',platformOs:'linux',codexHome:'/private/codex'}});
  if(m.method === 'thread/start') emit({id:m.id,result:{thread:{id:'native-thread-0169'},modelProvider:'openai',cwd:'/private/project',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{}}});
  if(m.method === 'turn/start') {
    emit({id:m.id,result:{turn:{id:'native-turn-0169'}}});
    const item = {id:'native-answer-0169',type:'agentMessage',phase:'final_answer',text:'Safe provider answer.',moderation:{moderated:true,display:{action:'future_presentation_action',cyberTrustedAccess:true,checkTrustedContacts:true}}};
    emit({method:'item/started',params:{threadId:'native-thread-0169',turnId:'native-turn-0169',item}});
    emit({method:'item/completed',params:{threadId:'native-thread-0169',turnId:'native-turn-0169',item,contentTokenCount:8}});
    emit({method:'turn/completed',params:{threadId:'native-thread-0169',turn:{id:'native-turn-0169',status:${JSON.stringify(status)},items:[item],error:${status === "failed" ? "{message:'private inference hook detail',codexErrorInfo:'inferenceHookDenied',additionalDetails:null}" : "null"}}}});
    process.exit(0);
  }
}
`);
    await chmod(provider, 0o700);
    const config = Buffer.from(JSON.stringify({ prompt: "Compatibility fixture", approvalPolicy: "on-request", sandbox: "workspace-write", writableRoots: [home] })).toString("base64");
    const runner = join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs");
    const child = spawn(process.execPath, [runner, events, process.version.slice(1), process.execPath, provider, config], {cwd:home,stdio:["ignore","pipe","pipe"]});
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
      expect(transcript).toContainEqual(expect.objectContaining({type:status === "completed" ? "turn.completed" : "turn.failed"}));
      expect(raw).toContain("Safe provider answer.");
      expect(raw).not.toMatch(/future_presentation_action|cyberTrustedAccess|checkTrustedContacts|private inference hook detail/);
      expect(transcript.some(event => event.type === "matrix.codex.approval.requested")).toBe(false);
    } finally {
      clearTimeout(timeout);
      child.kill("SIGTERM");
      await rm(home, {recursive:true,force:true});
    }
  });
});
