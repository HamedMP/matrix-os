import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nativeCodexConfigurationFingerprint } from "../../packages/gateway/src/coding-agents/native-codex-configuration-fingerprint.mjs";
import { createCodexControlClient } from "../../packages/gateway/src/coding-agents/codex-control-client.js";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";

async function records(path: string): Promise<any[]> {
  let value: string;
  try { value = await readFile(path, "utf8"); }
  catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return value.trim() ? value.trim().split("\n").map(line => JSON.parse(line)) : [];
}
async function waitFor(check: () => Promise<boolean>) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Synthetic native subscription browser wait expired");
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.kill("SIGTERM"); await closed;
}

async function rig(revokeOnClose: boolean) {
  const home = await mkdtemp("/tmp/mxb-na-");
  const trace = join(home, "trace.jsonl"), fake = join(home, "native.mjs");
  const account = { type: "chatgpt", email: "owner@example.test", id: "account-a" };
  const principal = createHash("sha256").update(JSON.stringify({ principal: account })).digest("hex");
  const row = { id: "codex_owner_openai_profile", harness: "codex", enabled: true,
    accessSourceId: "owner_openai_profile", selectedAccountId: "owner_codex",
    nativeAccountGeneration: principal, nativeAccountConsentRevision: 1,
    route: { kind: "fixed", providerId: "openai", modelId: "openai/gpt-5.6" } };
  const settings = join(home, "system/ai-providers/settings.json");
  await mkdir(join(home, "system/ai-providers"), { recursive: true });
  await writeFile(settings, JSON.stringify({ harnesses: [row] }));
  await writeFile(fake, `import {createInterface} from 'node:readline';
import {appendFile,readFile,writeFile} from 'node:fs/promises';
const trace=${JSON.stringify(trace)},log=async value=>appendFile(trace,JSON.stringify(value)+'\\n');
const prior=await readFile(trace,'utf8').catch(()=>''),generation=(prior.match(/"event":"spawn"/g)?.length??0)+1;
await log({event:'spawn',generation,pid:process.pid});
process.on('SIGTERM',async()=>{
 await log({event:'closed',generation});
 if(${revokeOnClose}&&generation===1)await writeFile(${JSON.stringify(settings)},${JSON.stringify(JSON.stringify({ harnesses: [{ ...row, enabled: false }] }))});
 process.exit(0);
});
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\\n');
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);await log({event:m.method,generation,params:m.params});
 if(m.method==='initialize')reply(m.id,{});
 else if(m.method==='config/read')reply(m.id,{config:{model_provider:'openai',openai_base_url:'',chatgpt_base_url:'https://chatgpt.com/backend-api/',cli_auth_credentials_store:'keyring'}});
 else if(m.method==='account/read')reply(m.id,{account:${JSON.stringify(account)}});
 else if(m.method==='thread/start'||m.method==='thread/resume')reply(m.id,{thread:{id:'native-subscription-browser-thread'},modelProvider:'openai'});
 else if(m.method==='mcpServerStatus/list')reply(m.id,{data:[{name:'matrix_shared_browser',runtimeStatus:'connected',tools:{shared_browser:{}}}]});
 else if(m.method==='turn/start'){
  reply(m.id,{turn:{id:'native-turn-'+generation}});
  process.stdout.write(JSON.stringify({method:'turn/completed',params:{turn:{id:'native-turn-'+generation,status:'completed',items:[]}}})+'\\n');
 }
}
`);
  const event = codexProviderEventPath(home, "sess_nba"), attemptId = randomUUID();
  const config = Buffer.from(JSON.stringify({ prompt: "First", approvalPolicy: "never", sandbox: "danger-full-access",
    writableRoots: [], browserAttemptId: attemptId, nativeSubscription: true, expectedNativePrincipal: principal,
    expectedNativeConsent: { revision: 1, harnessInstanceId: row.id, accountId: row.selectedAccountId,
      configurationFingerprint: nativeCodexConfigurationFingerprint(row) } })).toString("base64");
  const child = spawn(process.execPath, [join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs"),
    event, process.version.slice(1), process.execPath, fake, config], { cwd: home,
    env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), MATRIX_BACKGROUND_AGENT: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = ""; child.stdout?.resume(); child.stderr?.on("data", bytes => { diagnostics += bytes; });
  return { home, trace, event, attemptId, child, diagnostics: () => diagnostics };
}

it.each([false, true])("rechecks native browser renewal and settles an admitted turn (revoked=%s)", async revoked => {
  const f = await rig(revoked);
  const control = createCodexControlClient({ homePath: f.home, timeoutMs: 3000 });
  const lease = (attemptId: string) => ({ attemptId, token: "a".repeat(43), gatewayPort: 18765 });
  try {
    await control.prepareBrowser!({ sessionId: "sess_nba", browser: lease(f.attemptId), signal: AbortSignal.timeout(5000) });
    await waitFor(async () => (await records(f.event)).some(row => row.type === "turn.completed"));
    await control.submitTurn({ sessionId: "sess_nba", turnId: "turn_native_browser_second",
      prompt: "Second admitted turn", modelOptions: [], browser: lease(randomUUID()) });
    if (revoked) {
      await waitFor(async () => f.child.exitCode !== null || f.child.signalCode !== null);
      const trace = await records(f.trace), events = await records(f.event);
      expect(trace.filter(row => row.event === "turn/start")).toHaveLength(1);
      expect(trace.some(row => row.generation === 2 && row.event === "thread/resume")).toBe(false);
      expect(events.filter(row => ["turn.completed", "turn.failed", "turn.aborted"].includes(row.type))).toEqual([
        expect.objectContaining({ type: "turn.completed" }), expect.objectContaining({ type: "turn.failed" }),
      ]);
      expect(f.child.exitCode, f.diagnostics()).toBe(1);
    } else {
      await waitFor(async () => (await records(f.event)).filter(row => row.type === "turn.completed").length === 2);
      const trace = await records(f.trace);
      for (const generation of [1, 2]) {
        const rows = trace.filter(row => row.generation === generation);
        const thread = rows.find(row => ["thread/start", "thread/resume"].includes(row.event));
        for (const method of ["config/read", "account/read"]) {
          const index = rows.findIndex(row => row.event === method);
          expect(index).toBeGreaterThanOrEqual(0);
          expect(index).toBeLessThan(rows.indexOf(thread));
        }
        expect(thread.params.modelProvider).toBe("openai");
        expect(rows.some(row => row.event === "turn/start")).toBe(true);
      }
      expect(trace.find(row => row.event === "thread/resume").params.threadId).toBe("native-subscription-browser-thread");
      expect(trace.findIndex(row => row.event === "closed" && row.generation === 1))
        .toBeLessThan(trace.findIndex(row => row.event === "spawn" && row.generation === 2));
    }
  } catch (error) { throw new Error(`${String(error)} ${f.diagnostics()} ${JSON.stringify(await records(f.trace))}`); }
  finally { await stop(f.child); await rm(f.home, { recursive: true, force: true }); }
}, 15000);
