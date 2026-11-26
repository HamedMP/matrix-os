import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createCodexControlClient } from "../../packages/gateway/src/coding-agents/codex-control-client.js";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
const tools = ["terminal_list", "terminal_read", "terminal_send", "terminal_interrupt"];
type Trace = {
  event: string;
  pid?: number;
  token?: string | null;
  coreGrant?: string | null;
  params?: { threadId?: string; config: Record<string, { enabled_tools?: string[]; enabled?: boolean }> };
};
async function rows(path: string): Promise<Trace[]> {
  try {
    const text = await readFile(path, "utf8");
    return text.trim()
      ? text
          .trim()
          .split("\n")
          .map((row) => JSON.parse(row))
      : [];
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
async function waitFor(check: () => Promise<boolean>) {
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw Error("Native test wait expired");
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  child.kill("SIGTERM");
  await closed;
}
it.each(["healthy", "catalog_failed", "catalog_extra", "browser_and_terminal"])(
  "native runner binds private MCP, checks catalog before inference and rotates per run (%s)",
  async (mode) => {
    const bad = mode === "catalog_failed" || mode === "catalog_extra",
      combined = mode === "browser_and_terminal";
    const home = await mkdtemp("/tmp/mx-terminal-mcp-"),
      trace = join(home, "trace.jsonl"),
      fake = join(home, "native.mjs");
    await writeFile(
      fake,
      String.raw`import {createInterface} from 'node:readline';import {appendFile} from 'node:fs/promises';
const log=async value=>appendFile(process.env.SYNTHETIC_TRACE,JSON.stringify(value)+'\n');
await log({event:'spawn',pid:process.pid,token:process.env.MATRIX_HERDR_RUN_TOKEN??null,coreGrant:process.env.MATRIX_AGENT_INTEGRATIONS_TOKEN??null});
process.on('SIGTERM',async()=>{await log({event:'closed',pid:process.pid});process.exit(0);});
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\n');
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);
if(m.method==='initialize')reply(m.id,{userAgent:'synthetic',platformFamily:'unix',platformOs:'linux',codexHome:'synthetic'});
else if(m.method==='thread/start'||m.method==='thread/resume'){await log({event:m.method,pid:process.pid,params:m.params});reply(m.id,{thread:{id:'native-terminal-thread'}});}
else if(m.method==='mcpServerStatus/list'){await log({event:'catalog',pid:process.pid});reply(m.id,{data:[m.params.serverName==='matrix_shared_browser'?{name:'matrix_shared_browser',runtimeStatus:'connected',tools:{shared_browser:{}}}:{name:'matrix-herdr',runtimeStatus:process.env.SYNTHETIC_BAD?'failed':'connected',tools:Object.fromEntries(['terminal_list','terminal_read','terminal_send','terminal_interrupt',...(process.env.SYNTHETIC_EXTRA?['call_service']:[])].map(t=>[t,{}]))}]});}
else if(m.method==='turn/start'){await log({event:'turn',pid:process.pid});reply(m.id,{turn:{id:'native-turn-'+process.pid}});process.stdout.write(JSON.stringify({method:'turn/completed',params:{turn:{id:'native-turn-'+process.pid,status:'completed',items:[]}}})+'\n');}}
`,
    );
    const attemptId = randomUUID(),
      event = codexProviderEventPath(home, "sess_terminal_native"),
      lease = {
        attemptId,
        token: "a".repeat(64),
        gatewayPort: 4000,
        launcher: "/opt/matrix/bin/matrix-integrations-mcp" as const,
      };
    const config = Buffer.from(
      JSON.stringify({
        prompt: "Synthetic",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        writableRoots: [],
        matrixMcpAttemptId: attemptId,
        ...(combined ? { browserAttemptId: attemptId } : {}),
      }),
    ).toString("base64");
    const child = spawn(
      process.execPath,
      [
        join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs"),
        event,
        process.version.slice(1),
        process.execPath,
        fake,
        config,
      ],
      {
        cwd: home,
        env: {
          ...process.env,
          SYNTHETIC_TRACE: trace,
          ...(mode === "catalog_failed" ? { SYNTHETIC_BAD: "1" } : {}),
          ...(mode === "catalog_extra" ? { SYNTHETIC_EXTRA: "1" } : {}),
          MATRIX_BACKGROUND_AGENT: "1",
          MATRIX_AGENT_INTEGRATIONS_TOKEN: "synthetic-core-grant",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let diagnostics = "";
    child.stderr?.on("data", (chunk) => {
      diagnostics += chunk;
    });
    child.stdout?.resume();
    try {
      const control = createCodexControlClient({ homePath: home });
      if (bad) {
        await expect(
          control.prepareMatrixMcp!({
            sessionId: "sess_terminal_native",
            matrixMcp: lease,
            signal: AbortSignal.timeout(5000),
          }),
        ).rejects.toThrow();
        await waitFor(async () => child.exitCode !== null || child.signalCode !== null);
        const events = await rows(trace);
        expect(events.some((row) => row.event === "turn")).toBe(false);
        expect(
          events.some((row) => row.event === "closed" && row.pid === events.find((row) => row.event === "spawn")?.pid),
        ).toBe(true);
        return;
      }
      await Promise.all([
        control.prepareMatrixMcp!({
          sessionId: "sess_terminal_native",
          matrixMcp: lease,
          signal: AbortSignal.timeout(5000),
        }),
        ...(combined
          ? [
              control.prepareBrowser!({
                sessionId: "sess_terminal_native",
                browser: { attemptId, token: "c".repeat(43), gatewayPort: 4000 },
                signal: AbortSignal.timeout(5000),
              }),
            ]
          : []),
      ]);
      await waitFor(async () => (await rows(trace)).some((row) => row.event === "turn"));
      await control.submitTurn({
        sessionId: "sess_terminal_native",
        turnId: "turn_second",
        prompt: "Second",
        modelOptions: [],
        matrixMcp: { ...lease, attemptId: randomUUID(), token: "b".repeat(64) },
      });
      await waitFor(async () => (await rows(trace)).filter((row) => row.event === "turn").length === 2);
      await control.submitTurn({
        sessionId: "sess_terminal_native",
        turnId: "turn_restricted",
        prompt: "Restricted",
        modelOptions: [],
        matrixMcp: null,
      });
      await waitFor(async () => (await rows(trace)).filter((row) => row.event === "turn").length === 3);
      const records = await rows(trace),
        spawns = records.filter((row) => row.event === "spawn"),
        threads = records.filter((row) => row.event === "thread/start" || row.event === "thread/resume");
      expect(spawns.map((row) => row.token)).toEqual(["a".repeat(64), "b".repeat(64), null]);
      expect(spawns.every((row) => row.coreGrant === "synthetic-core-grant")).toBe(true);
      expect(threads.map((row) => row.event)).toEqual(["thread/start", "thread/resume", "thread/resume"]);
      expect(threads[1].params!.threadId).toBe("native-terminal-thread");
      expect(threads[0].params!.config["mcp_servers.matrix-herdr"].enabled_tools).toEqual(tools);
      expect(threads[2].params!.config["mcp_servers.matrix-herdr"].enabled).toBe(false);
      expect(records.filter((row) => row.event === "catalog" || row.event === "turn").map((row) => row.event)).toEqual(
        combined
          ? ["catalog", "catalog", "turn", "catalog", "turn", "turn"]
          : ["catalog", "turn", "catalog", "turn", "turn"],
      );
      const persisted =
        JSON.stringify(threads) + (await readFile(event, "utf8")) + Buffer.from(config, "base64").toString();
      expect(persisted).not.toContain(lease.token);
      expect(persisted).not.toContain("b".repeat(64));
    } catch (error) {
      throw Error(String(error) + " " + diagnostics);
    } finally {
      await stop(child);
      await rm(home, { recursive: true, force: true });
    }
  },
  15000,
);
