import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import { parseCodexExecJsonLine } from "../../packages/gateway/src/coding-agents/codex-events.js";
import { createCodexControlClient } from "../../packages/gateway/src/coding-agents/codex-control-client.js";
import { invokeCodexCanonicalAction } from "../../packages/gateway/src/coding-agents/codex-canonical-tools.mjs";
const policy = { revision: "r1", actionMode: "safe_reads", workspaceScope: "owner", tools: ["matrix_list_apps"], delegation: false };
const inventory = [{ toolId: "matrix_list_apps", schemaRevision: "v1", description: "List apps", effect: "read", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];
async function lines(path: string): Promise<any[]> { try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; } }
it("fake child: isolates actual launch and bridges only exact dynamic calls while denying native approval/MCP/plugin/delegation requests", async () => {
  const dir = await mkdtemp("/tmp/mx-canonical-runner-"); const fake = join(dir, "provider.mjs"); const events = codexProviderEventPath(dir, "sess_canonical"); const requests = join(dir, "requests.jsonl");
  await writeFile(fake, `#!${process.execPath}\nimport {createInterface} from 'node:readline'; import {appendFile} from 'node:fs/promises';
    let hostEnabled=false;
    if(process.argv.includes('--version')) { console.log('codex-cli 0.156.1'); process.exit(0); }
    for await(const line of createInterface({input:process.stdin})) { const m=JSON.parse(line); await appendFile(${JSON.stringify(requests)}, JSON.stringify({m,cwd:process.cwd(),env:{HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME,NODE_OPTIONS:process.env.NODE_OPTIONS,OPENAI_API_KEY:process.env.OPENAI_API_KEY},argv:process.argv})+'\\n');
      if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
      else if(m.method==='config/read') console.log(JSON.stringify({id:m.id,result:{config:{mcp_servers:{},plugins:{}},layers:[]}}));
      else if(m.method==='thread/start') { hostEnabled=m.params.config?.['features.code_mode_host']===true && process.argv.includes('features.code_mode_host=true'); console.log(JSON.stringify({id:m.id,result:{thread:{id:'native1'}}})); }
      else if(m.method==='turn/start') { console.log(JSON.stringify({id:m.id,result:{turn:{id:'turn1'}}}));
        for(const [id,method] of [[11,'item/commandExecution/requestApproval'],[12,'item/fileChange/requestApproval'],[13,'mcpServer/elicitation/request'],[14,'plugin/install'],[15,'agent/spawn']]) console.log(JSON.stringify({id,method,params:{threadId:'native1',turnId:'turn1',itemId:'item1'}}));
        if(hostEnabled) console.log(JSON.stringify({id:42,method:'item/tool/call',params:{threadId:'native1',turnId:'turn1',callId:'call1',namespace:null,tool:'matrix_list_apps',arguments:{}}}));
      } else if(m.id===42 && m.result) console.log(JSON.stringify({method:'turn/completed',params:{turn:{id:'turn1',status:'completed'}}}));
    }`, { mode: 0o700 });
  const config = Buffer.from(JSON.stringify({ prompt: "List apps", approvalPolicy: "never", sandbox: "read-only", writableRoots: [], canonical: { executionPolicy: policy, inventory, identity: { owner: { type: "personal", ownerId: "u1" }, chatId: "chat_1", runId: "run_1" } } })).toString("base64");
  const child = spawn(process.execPath, [join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs"), events, "0.156.1", fake, config], { cwd: dir, env: { ...process.env, OPENAI_API_KEY: "fake-do-not-inherit" }, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", c => { stderr += c; });
  async function control(payload: unknown) { return new Promise<any>((resolve, reject) => { const socket = createConnection(events.replace(/\.jsonl$/, ".sock")); let data = ""; socket.setEncoding("utf8"); socket.setTimeout(2000, () => socket.destroy(new Error("timeout"))); socket.on("error", reject); socket.on("data", c => { data += c; }); socket.once("connect", () => socket.end(JSON.stringify(payload) + "\n")); socket.once("end", () => resolve(JSON.parse(data))); }); }
  try {
    await expect.poll(async () => ({ event: (await lines(events)).find(e => e.type === "matrix.codex.action.requested"), stderr }), { timeout: 3000 }).toMatchObject({ event: { toolId: "matrix_list_apps" }, stderr: "" });
    const records = await lines(requests); const start = records.find(r => r.m.method === "thread/start");
    expect(start.m.params).toMatchObject({ environments: [], ephemeral: true, dynamicTools: [{ name: "matrix_list_apps" }] });
    expect(start.m.params.config).toMatchObject({ "features.code_mode": false, "features.code_mode_host": true, "features.shell_tool": false, "features.plugins": false, "features.multi_agent": false });
    expect(start.cwd).not.toBe(dir); expect(start.env.OPENAI_API_KEY).toBeUndefined();
    expect(records.filter(r => [11,12,13,14,15].includes(r.m.id)).every(r => r.m.error)).toBe(true);
    expect(records.some(r => r.m.id === 42 && r.m.result)).toBe(false);
    const event = (await lines(events)).find(e => e.type === "matrix.codex.action.requested");
    const context = { threadId: "thread_canonical", now: () => new Date(), nextEventId: () => "evt_canonical" };
    expect(parseCodexExecJsonLine(JSON.stringify(event), context).canonicalActionRequest).toEqual(event);
    const startedTool = (await lines(events)).find(e => e.type === "matrix.codex.tool.started" && e.kind === "dynamic_tool");
    expect(parseCodexExecJsonLine(JSON.stringify(startedTool), context).events[0]).toMatchObject({ type: "tool.started", kind: "dynamic_tool" });
    expect(await control({ type: "turn", prompt: "escape", modelOptions: [], clientRequestId: "req_escape" })).toEqual({ ok: false });
    expect(await control({ type: "steer", prompt: "escape", clientRequestId: "req_escape_steer", executionPolicy: { ...policy, tools: ["exec_command"] } })).toEqual({ ok: false });
    expect(await control({ type: "approval", approvalId: "appr_codex_" + "0".repeat(32), decision: "approve_for_session", clientRequestId: "req_escape_approval" })).toEqual({ ok: false });
    const frame = { type: "canonical_tool_result", actionId: event.actionId, argumentDigest: event.argumentDigest, inventoryDigest: event.inventoryDigest, result: { success: true, contentItems: [{ type: "inputText", text: "Apps: Notes" }] } };
    expect(await control({ ...frame, argumentDigest: "0".repeat(64) })).toEqual({ ok: false });
    const client = createCodexControlClient({ homePath: dir });
    const invoke = vi.fn(async () => ({ apps: [{ app: "notes" }] }));
    await invokeCodexCanonicalAction(event, { owner: event.owner, chatId: event.chatId, runId: event.runId,
      executionPolicy: policy, inventory, actions: { invoke }, signal: new AbortController().signal },
      response => client.submitCanonicalToolResult({ sessionId: "sess_canonical", frame: response }));
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect.poll(async () => (await lines(requests)).find(r => r.m.id === 42 && r.m.result)?.m.result).toEqual({ success: true, contentItems: [{ type: "inputText", text: '{"apps":[{"app":"notes"}]}' }] });
    await expect.poll(async () => (await lines(events)).some(e => e.type === "turn.completed")).toBe(true);
    expect(await control(frame)).toEqual({ ok: false });
  } finally { const closed = new Promise(resolve => child.once("close", resolve)); child.kill("SIGTERM"); if (child.exitCode === null && child.signalCode === null) await closed; await rm(dir, { recursive: true, force: true }); }
});
