import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function run(mode: string) {
  const home = await mkdtemp("/tmp/mx-resume-");
  const eventPath = join(home, "events.jsonl");
  const tracePath = join(home, "trace.jsonl");
  const fakePath = join(home, "fake.mjs");
  await writeFile(fakePath, `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = value => new Promise(resolve => process.stdout.write(JSON.stringify(value)+'\\n', resolve));
for await (const line of createInterface({input:process.stdin})) {
  const m = JSON.parse(line);
  appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(m)+'\\n');
  if (m.method === 'initialize') await send({id:m.id,result:{}});
  if (m.method === 'thread/resume') {
    if (${JSON.stringify(mode)} === 'malformed') { process.stdout.write('{private-invalid-json\\n'); continue; }
    const size = ${JSON.stringify(mode)} === 'oversized' ? 17*1024*1024
      : ${JSON.stringify(mode)} === 'respects' && m.params.excludeTurns ? 0 : 3*1024*1024;
    await send({id:m.id,result:{thread:{id:m.params.threadId,turns:[{items:[{result:'A'.repeat(size)}]}]}}});
  }
  if (m.method === 'turn/start') {
    await send({id:m.id,result:{turn:{id:'turn-resumed'}}});
    await send({method:'item/agentMessage/delta',params:{turnId:'turn-resumed',itemId:'answer',delta:'Context preserved.'}});
    await send({method:'turn/completed',params:{turn:{id:'turn-resumed',status:'completed',items:[]}}});
    process.exit(0);
  }
}`);
  const config = Buffer.from(JSON.stringify({ prompt: "Continue.", providerThreadId: "native-persisted",
    approvalPolicy: "never", sandbox: "read-only", writableRoots: [home] })).toString("base64");
  const child = spawn(process.execPath, [join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs"),
    eventPath, process.version.slice(1), process.execPath, fakePath, config], { cwd: home, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    const events = await readFile(eventPath, "utf8");
    const requests = (await readFile(tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    return { code, events, requests, stderr };
  } finally { clearTimeout(deadline); child.kill("SIGTERM"); await rm(home, { recursive: true, force: true }); }
}

describe("Codex resume transport", () => {
  it.each(["respects", "ignores"])("resumes image history when provider %s excludeTurns", async (mode) => {
    const result = await run(mode);
    expect(result.code).toBe(0);
    expect(result.requests.find((m) => m.method === "thread/resume").params).toMatchObject({threadId: "native-persisted", excludeTurns: true});
    expect(result.requests.filter((m) => m.method === "turn/start")).toHaveLength(1);
    expect(result.events).toContain("Context preserved.");
    expect(result.events).toContain('"type":"turn.completed"');
    expect(result.events).not.toContain("AAAA");
  }, 8_000);

  it.each(["oversized", "malformed"])("fails promptly with safe diagnostics for %s responses", async (mode) => {
    const result = await run(mode);
    expect(result.code).toBe(1);
    expect(result.requests.some((m) => m.method === "turn/start")).toBe(false);
    expect(result.events).toContain('"type":"turn.failed"');
    expect(result.stderr).toContain("coding_transport_failed");
    expect(result.stderr).toContain(mode);
    expect(result.stderr).toContain("thread/resume");
    expect(result.stderr).not.toContain("private-invalid-json");
    expect(result.stderr.length).toBeLessThan(1000);
  }, 8_000);
});
