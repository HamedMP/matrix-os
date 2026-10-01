import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { expect, it } from "vitest";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import { parseCodexExecJsonLine } from "../../packages/gateway/src/coding-agents/codex-events.js";

async function waitUntil<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Approval evidence timed out");
}
function control(path: string, payload: unknown) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let text = "";
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error("Control timed out")); }, 2000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(JSON.stringify(payload) + "\n"));
    socket.on("data", chunk => { text += chunk; });
    socket.once("error", reject);
    socket.once("close", () => { clearTimeout(timeout); resolve(JSON.parse(text)); });
  });
}
function exited(child: ChildProcess) { return new Promise(resolve => child.once("close", resolve)); }

it("journals actionable command and matching file patch details and routes unchanged native decisions", async () => {
  const home = await mkdtemp("/tmp/codex-approval-display-");
  const fake = join(home, "fake.mjs");
  const responses = join(home, "responses.jsonl");
  const path = codexProviderEventPath(home, "sess_approval_details");
  await writeFile(fake, `import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const home = ${JSON.stringify(home)};
const emit = value => console.log(JSON.stringify(value));
const base = { threadId: 'native-thread', turnId: 'native-turn' };
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === 'initialize') emit({ id: m.id, result: { userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux', codexHome: '/private/codex' } });
  else if (m.method === 'thread/start') emit({ id: m.id, result: { thread: { id: base.threadId }, modelProvider: 'openai', cwd: home, approvalPolicy: 'on-request', sandbox: {} } });
  else if (m.method === 'turn/start') {
    emit({ id: m.id, result: { turn: { id: base.turnId } } });
    emit({ id: 41, method: 'item/commandExecution/requestApproval', params: { ...base, itemId: 'command-item', command: 'API_TOKEN=fixture-credential pnpm run build', cwd: home, reason: 'Build project', availableDecisions: ['accept', 'decline'] } });
  } else if (m.id === 41) {
    await appendFile(${JSON.stringify(responses)}, JSON.stringify(m) + '\\n');
    emit({ method: 'item/started', params: { ...base, item: { id: 'file-item', type: 'fileChange', changes: [{ path: home + '/src/App.tsx', kind: { type: 'update', move_path: home + '/src/Main.tsx' }, diff: '- old title\\n+ new title' }] } } });
    emit({ id: 42, method: 'item/fileChange/requestApproval', params: { ...base, itemId: 'file-item', reason: 'Update app title', grantRoot: home, availableDecisions: ['accept', 'decline'] } });
  } else if (m.id === 42) {
    await appendFile(${JSON.stringify(responses)}, JSON.stringify(m) + '\\n');
    emit({ method: 'item/started', params: { ...base, turnId: 'other-turn', item: { id: 'missing-file-item', type: 'fileChange', changes: [{ path: home + '/src/Wrong.tsx', kind: { type: 'update', move_path: null }, diff: '+ must never be borrowed' }] } } });
    emit({ id: 43, method: 'item/fileChange/requestApproval', params: { ...base, itemId: 'missing-file-item', availableDecisions: ['accept', 'decline'] } });
  } else if (m.id === 43) {
    await appendFile(${JSON.stringify(responses)}, JSON.stringify(m) + '\\n');
    emit({ method: 'turn/completed', params: { turn: { id: base.turnId, status: 'completed' } } });
    process.exit(0);
  }
}`);
  const config = Buffer.from(JSON.stringify({ prompt: "Review proposed actions", approvalPolicy: "on-request", sandbox: "workspace-write", writableRoots: [home] })).toString("base64");
  const child = spawn(process.execPath, [join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs"), path,
    process.version.slice(1), process.execPath, fake, config], { cwd: home, stdio: ["ignore", "pipe", "pipe"] });
  const completion = exited(child);
  try {
    const approvals = [];
    for (const [index, decision] of (["approve", "decline", "decline"] as const).entries()) {
      const record = await waitUntil(async () => {
        const records = (await readFile(path, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
        return records.filter(event => event.type === "matrix.codex.approval.requested")[index];
      });
      approvals.push(record);
      expect(await control(path.replace(/\.jsonl$/, ".sock"), { type: "approval", approvalId: record.approvalId, decision, clientRequestId: `req_review_${index}` })).toEqual({ ok: true });
    }
    expect(await completion).toBe(0);
    expect(approvals[0]).toMatchObject({ preview: { body: expect.stringContaining("API_TOKEN=[redacted] pnpm run build") } });
    expect(approvals[1]).toMatchObject({ preview: { body: expect.stringContaining("update: src/App.tsx\nMove to: src/Main.tsx\nPatch:\n- old title\n+ new title") } });
    expect(approvals[2]).toMatchObject({ preview: { body: "Files and patch unavailable: not supplied by the agent.", truncated: false } });
    const projected = approvals.flatMap(record => parseCodexExecJsonLine(JSON.stringify(record), {
      threadId: "thread_review", nextEventId: () => "evt_review", now: () => new Date("2026-10-01T00:00:00Z") }).events);
    expect(projected[0]).toMatchObject({ type: "approval.requested", approval: { preview: approvals[0].preview } });
    expect(JSON.stringify(projected)).not.toContain("fixture-credential");
    expect(JSON.stringify(projected)).not.toContain(home);
    expect(JSON.stringify(projected)).not.toContain("must never be borrowed");
    expect((await readFile(responses, "utf8")).trim().split("\n").map(line => JSON.parse(line))).toEqual([
      { id: 41, result: { decision: "accept" } }, { id: 42, result: { decision: "decline" } }, { id: 43, result: { decision: "decline" } },
    ]);
  } finally { child.kill("SIGTERM"); await rm(home, { recursive: true, force: true }); }
}, 10000);
