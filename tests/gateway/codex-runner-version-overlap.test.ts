import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";

async function readIfPresent(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); }
  catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

// The runner checks the Codex version concurrently with its other startup
// work, but never spawns the app-server before that check passes.
async function run(expectedVersion: string, exitsOnItsOwn = false) {
  const home = await mkdtemp("/tmp/mx-runner-version-");
  const fake = join(home, "native.mjs"), trace = join(home, "trace.jsonl");
  await writeFile(fake, String.raw`import {createInterface} from 'node:readline';
import {appendFile} from 'node:fs/promises';
if (process.argv.includes('--version')) { console.log('codex-cli 9.9.9'); process.exit(0); }
await appendFile(process.env.SYNTHETIC_TRACE, JSON.stringify({event:'spawn'})+'\n');
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\n');
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);
 if(m.method==='initialize')reply(m.id,{userAgent:'synthetic',platformFamily:'unix',platformOs:'linux',codexHome:'synthetic'});
 else if(m.method==='thread/start')reply(m.id,{thread:{id:'native-version-thread'}});
 else if(m.method==='turn/start'){reply(m.id,{turn:{id:'native-turn'}});process.stdout.write(JSON.stringify({method:'turn/completed',params:{turn:{id:'native-turn',status:'completed',items:[]}}})+'\n');}
}`);
  const shim = join(home, "codex");
  await writeFile(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`, { mode: 0o700 });
  const event = codexProviderEventPath(home, "sess_version");
  const config = Buffer.from(JSON.stringify({ prompt: "Synthetic", approvalPolicy: "never", sandbox: "danger-full-access", writableRoots: [] })).toString("base64");
  const child = spawn(process.execPath, [join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs"), event, expectedVersion, shim, config],
    { cwd: home, env: { ...process.env, SYNTHETIC_TRACE: trace, MATRIX_BACKGROUND_AGENT: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr?.on("data", chunk => { stderr += chunk; }); child.stdout?.resume();
  const closed = new Promise<number | null>(resolve => child.once("close", resolve));
  const settled = (async () => {
    for (let i = 0; i < 300; i++) {
      const text = await readIfPresent(event);
      if (/"type":"turn\.(completed|failed)"/.test(text)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  })();
  // A failed startup exits by itself; a healthy runner stays up between turns.
  await (exitsOnItsOwn ? Promise.race([closed, new Promise(resolve => setTimeout(resolve, 10_000))]) : Promise.race([closed, settled]));
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const code = await closed;
  const spawned = (await readIfPresent(trace)).trim().split("\n").filter(Boolean).length;
  const events = (await readIfPresent(event)).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { type: string });
  await rm(home, { recursive: true, force: true });
  return { code, spawned, events, stderr };
}

it("never spawns the app-server when the overlapped version check fails, and settles the turn as failed", async () => {
  const result = await run("0.0.1", true);
  expect(result.code).toBe(1);
  expect(result.spawned).toBe(0);
  expect(result.stderr).toContain("Codex provider version is not verified.");
  expect(result.events.some(event => event.type === "turn.failed"), `${result.stderr} ${JSON.stringify(result.events)}`).toBe(true);
}, 15_000);

it("starts the app-server once the version check passes", async () => {
  const result = await run("9.9.9");
  expect(result.spawned).toBe(1);
  expect(result.events.some(event => event.type === "turn.completed")).toBe(true);
}, 15_000);
