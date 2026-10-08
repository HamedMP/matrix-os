import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";

it("preserves partial-answer lifecycle before later tools and terminal completion", async () => {
  const homePath = await mkdtemp("/tmp/codex-partial-answer-");
  const fakePath = join(homePath, "fake.mjs");
  const eventPath = codexProviderEventPath(homePath, "sess_partial_answer");
  await writeFile(fakePath, [
    "#!/usr/bin/env node",
    "import { createInterface } from 'node:readline';",
    "for await (const line of createInterface({ input: process.stdin })) {",
    " const request = JSON.parse(line);",
    " if (request.method === 'initialize') console.log(JSON.stringify({id:request.id,result:{userAgent:'fixture'}}));",
    " if (request.method === 'thread/start') console.log(JSON.stringify({id:request.id,result:{thread:{id:'fixture-thread'}}}));",
    " if (request.method === 'turn/start') {",
    "  console.log(JSON.stringify({id:request.id,result:{turn:{id:'fixture-turn',status:'inProgress',items:[]}}}));",
    "  for (const item of [{id:'partial',type:'agentMessage',text:'First result.',phase:'partial_answer'}, {id:'metadata',type:'subAgentActivity',agentPath:'/fixture/agent',agentThreadId:'fixture-agent',kind:'spawned',model:'fixture-model',reasoningEffort:'low'}, {id:'tool',type:'commandExecution',command:'pwd',status:'completed'}, {id:'final',type:'agentMessage',text:'Final result.',phase:'final_answer'}]) {",
    "   console.log(JSON.stringify({method:'item/started',params:{turnId:'fixture-turn',item}}));",
    "   console.log(JSON.stringify({method:'item/completed',params:{turnId:'fixture-turn',item}}));",
    "  }",
    "  console.log(JSON.stringify({method:'turn/completed',params:{turn:{id:'fixture-turn',rootTurnId:'fixture-root',status:'completed',items:[]}}}));",
    " }",
    "}",
  ].join("\n"));
  await chmod(fakePath, 0o700);
  const runner = join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs");
  const config = Buffer.from(JSON.stringify({prompt:"Fixture",approvalPolicy:"on-request",sandbox:"workspace-write",writableRoots:[homePath]})).toString("base64");
  const child = spawn(process.execPath, [runner, eventPath, process.version.slice(1), process.execPath, fakePath, config], { cwd: homePath, stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  try {
    const deadline = Date.now() + 5_000;
    let transcript = "";
    while (Date.now() < deadline) {
      transcript = await readFile(eventPath, "utf8").catch(() => "");
      if (transcript.includes('"type":"turn.completed"')) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const events = transcript.trim().split("\n").map((line) => JSON.parse(line));
    expect(events.filter((event) => event.type === "matrix.codex.assistant.delta").map((event) => event.delta)).toEqual(["First result.", "Final result."]);
    expect(events.filter((event) => event.type === "matrix.codex.assistant.completed")).toHaveLength(2);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(events.at(-1).type).toBe("turn.completed");
    const partialCompleted = events.findIndex((event) => event.type === "matrix.codex.assistant.completed");
    const toolStarted = events.findIndex((event) => event.type === "matrix.codex.tool.started");
    expect(partialCompleted).toBeLessThan(toolStarted);
    expect(transcript).not.toContain("fixture-agent");
  } finally {
    child.kill();
    await closed;
    await rm(homePath, { recursive: true, force: true });
  }
});
