import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { expect, it } from "vitest";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import { parseCodexExecJsonLine } from "../../packages/gateway/src/coding-agents/codex-events.js";

const elicitation = {
  id: 42, method: "mcpServer/elicitation/request",
  params: {
    threadId: "thread-mcp", turnId: "turn-mcp", serverName: "matrix-integrations",
    mode: "form", message: "Allow this integration operation?",
    requestedSchema: { type: "object", properties: {} },
    _meta: { codex_approval_kind: "tool", tool_params: { token: "sk-never-display-this" } },
  },
};

async function start(requests: unknown[], env: Record<string, string> = {}) {
  const dir = await mkdtemp("/tmp/mx-mcp-");
  const fake = join(dir, "provider.mjs");
  const events = codexProviderEventPath(dir, "sess_mcp");
  const responses = join(dir, "responses.jsonl");
  await writeFile(fake, `
    import {createInterface} from 'node:readline';
    import {appendFile} from 'node:fs/promises';
    let remaining=${requests.length};
    for await(const line of createInterface({input:process.stdin})) {
      const m=JSON.parse(line);
      if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
      else if(m.method==='thread/start') console.log(JSON.stringify({id:m.id,result:{thread:{id:'thread-mcp'}}}));
      else if(m.method==='turn/start') {
        console.log(JSON.stringify({id:m.id,result:{turn:{id:'turn-mcp'}}}));
        console.log(JSON.stringify({method:'item/started',params:{turnId:'turn-mcp',item:{id:'tool-1',type:'mcpToolCall',status:'inProgress'}}}));
        for(const r of ${JSON.stringify(requests)}) console.log(JSON.stringify(r));
      } else if(m.id!==undefined && !m.method) {
        await appendFile(${JSON.stringify(responses)}, JSON.stringify(m)+'\\n');
        if(--remaining===0) {
          console.log(JSON.stringify({method:'item/completed',params:{turnId:'turn-mcp',item:{id:'tool-1',type:'mcpToolCall',status:'completed'}}}));
          console.log(JSON.stringify({method:'turn/completed',params:{turn:{id:'turn-mcp',status:'completed'}}}));
        }
      }
    }
  `);
  const config = Buffer.from(JSON.stringify({ prompt: "Check inventory", approvalPolicy: "on-request", sandbox: "workspace-write", writableRoots: [dir] })).toString("base64");
  const child = spawn(process.execPath, [join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs"), events, process.version.slice(1), process.execPath, fake, config], {
    cwd: dir, env: { ...process.env, ...env }, stdio: ["pipe", "ignore", "pipe"],
  });
  child.stderr.resume();
  return {
    events, responses,
    async control(payload: unknown) {
      return new Promise<unknown>((resolve, reject) => {
        const socket = createConnection(events.replace(/\.jsonl$/, ".sock"));
        let data = "";
        socket.setEncoding("utf8");
        socket.setTimeout(2000, () => socket.destroy(new Error("control timeout")));
        socket.once("connect", () => socket.end(JSON.stringify(payload) + "\n"));
        socket.on("data", chunk => { data += chunk; });
        socket.once("error", reject);
        socket.once("close", () => { if (data) resolve(JSON.parse(data)); });
      });
    },
    async close() {
      const closed = new Promise(resolve => child.once("close", resolve));
      child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null) await closed;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function lines(path: string): Promise<any[]> {
  try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

it("surfaces native MCP confirmation and returns one correlated approval before continuing", async () => {
  const runtime = await start([elicitation]);
  try {
    await expect.poll(async () => (await lines(runtime.events)).find(e => e.type === "matrix.codex.approval.requested"), { timeout: 2000 }).toBeDefined();
    const approval = (await lines(runtime.events)).find(e => e.type === "matrix.codex.approval.requested");
    expect(approval.allowedDecisions).toEqual(["approve", "decline", "cancel"]);
    expect(parseCodexExecJsonLine(JSON.stringify(approval), {
      threadId: "thread_mcp", now: () => new Date("2026-09-08T00:00:00.000Z"), nextEventId: () => "evt_mcp",
    }).events.some(e => e.type === "approval.requested")).toBe(true);
    expect(JSON.stringify(approval)).not.toContain("sk-never");
    expect(await lines(runtime.responses)).toEqual([]);
    const control = { type: "approval", approvalId: approval.approvalId, decision: "approve", clientRequestId: "req_mcp_1" };
    expect(await runtime.control(control)).toEqual({ ok: true });
    expect(await runtime.control(control)).toEqual({ ok: true, replayed: true });
    await expect.poll(() => lines(runtime.responses)).toEqual([{ id: 42, result: { action: "accept", content: {} } }]);
    await expect.poll(async () => (await lines(runtime.events)).some(e => e.type === "turn.completed")).toBe(true);
  } finally { await runtime.close(); }
});

it("does not publish credentials embedded in an elicitation message", async () => {
  const runtime = await start([{ ...elicitation, params: { ...elicitation.params, message: "authorization: private-value-123" } }]);
  try {
    await expect.poll(async () => (await lines(runtime.events)).find(e => e.type === "matrix.codex.approval.requested")).toBeDefined();
    expect(await readFile(runtime.events, "utf8")).not.toContain("private-value-123");
  } finally { await runtime.close(); }
});

it.each(["decline", "cancel"])("settles an MCP confirmation with %s without granting access", async decision => {
  const runtime = await start([elicitation]);
  try {
    await expect.poll(async () => (await lines(runtime.events)).find(e => e.type === "matrix.codex.approval.requested")).toBeDefined();
    const approval = (await lines(runtime.events)).find(e => e.type === "matrix.codex.approval.requested");
    expect(await runtime.control({ type: "approval", approvalId: approval.approvalId, decision: "approve_for_session", clientRequestId: "req_bad_grant" })).toEqual({ ok: false });
    expect(await runtime.control({ type: "approval", approvalId: approval.approvalId, decision, clientRequestId: "req_decline" })).toEqual({ ok: true });
    await expect.poll(() => lines(runtime.responses)).toEqual([{ id: 42, result: { action: decision, content: null } }]);
  } finally { await runtime.close(); }
});

it("does not charge an MCP approval wait against the tool deadline", async () => {
  const runtime = await start([elicitation], { MATRIX_CODEX_TOOL_DEADLINE_MS: "150" });
  try {
    await expect.poll(async () => (await lines(runtime.events)).find(e => e.type === "matrix.codex.approval.requested")).toBeDefined();
    const approval = (await lines(runtime.events)).find(e => e.type === "matrix.codex.approval.requested");
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((await lines(runtime.events)).some(e => e.type === "turn.failed")).toBe(false);
    expect(await runtime.control({ type: "approval", approvalId: approval.approvalId, decision: "approve", clientRequestId: "req_waited" })).toEqual({ ok: true });
    await expect.poll(async () => (await lines(runtime.events)).some(e => e.type === "turn.completed")).toBe(true);
  } finally { await runtime.close(); }
});

it("cancels outstanding MCP confirmation on interruption and rejects a late decision", async () => {
  const runtime = await start([elicitation, { method: "turn/completed", params: { turn: { id: "turn-mcp", status: "interrupted" } } }]);
  try {
    await expect.poll(() => lines(runtime.responses)).toEqual([{ id: 42, result: { action: "cancel", content: null } }]);
    const approval = (await lines(runtime.events)).find(e => e.type === "matrix.codex.approval.requested");
    expect(await runtime.control({ type: "approval", approvalId: approval.approvalId, decision: "approve", clientRequestId: "req_late" })).toEqual({ ok: false });
  } finally { await runtime.close(); }
});

it.each([
  { ...elicitation.params, mode: "url", url: "https://example.com/authorize", elicitationId: "auth-1" },
  { ...elicitation.params, requestedSchema: { type: "object", properties: { password: { type: "string" } }, required: ["password"] } },
])("cancels unsupported MCP forms instead of granting empty consent or hanging", async params => {
  const runtime = await start([{ ...elicitation, params }]);
  try {
    await expect.poll(() => lines(runtime.responses)).toEqual([{ id: 42, result: { action: "cancel", content: null } }]);
    expect((await lines(runtime.events)).some(e => e.type === "matrix.codex.approval.requested")).toBe(false);
  } finally { await runtime.close(); }
});

it.each([
  [{ ...elicitation, params: { ...elicitation.params, turnId: "old-turn" } }, -32000],
  [{ ...elicitation, params: { ...elicitation.params, threadId: "foreign-thread" } }, -32000],
  [{ ...elicitation, method: "item/unknown/request" }, -32601],
  [{ ...elicitation, params: { ...elicitation.params, message: null } }, -32601],
] as const)("answers stale and unsupported server requests with a correlated error", async (request, code) => {
  const runtime = await start([request]);
  try {
    await expect.poll(() => lines(runtime.responses)).toEqual([{ id: 42, error: { code, message: "This request is unavailable." } }]);
    expect((await lines(runtime.events)).some(e => e.type === "matrix.codex.approval.requested")).toBe(false);
  } finally { await runtime.close(); }
});
