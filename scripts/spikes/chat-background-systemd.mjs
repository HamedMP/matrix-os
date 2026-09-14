// Manual, credential-free Linux acceptance. Build gateway first, then run as its non-root user:
// node scripts/spikes/chat-background-systemd.mjs /absolute/path/to/gateway/dist/background-agent-runtime.js
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const modulePath = resolve(process.argv[2] ?? "packages/gateway/dist/background-agent-runtime.js");
const { createBackgroundAgentRuntime } = await import(pathToFileURL(modulePath).href);
const homePath = await mkdtemp(join(tmpdir(), "matrix-background-acceptance-"));
const run = promisify(execFile);
const refs = [];
const runtime = createBackgroundAgentRuntime({ homePath, maxJobs: 1 });
// A service lifetime cap also bounds cleanup if the acceptance driver itself is interrupted.
const childCode = `
const [modulePath, homePath, suffix] = process.argv.slice(1);
const {createBackgroundAgentRuntime} = await import(modulePath);
const runtime = createBackgroundAgentRuntime({homePath,maxJobs:1});
try {
  const ref = await runtime.start({sessionId:'sess_acceptance_'+suffix,launch:{
    command:process.execPath,args:['-e','process.stdin.resume();setTimeout(()=>process.exit(0),60000);'],cwd:homePath,env:{}
  }});
  console.log(JSON.stringify({ok:true,ref}));
} catch(error) { console.log(JSON.stringify({ok:false,error:error.name})); }
finally { await runtime.close(); }
`;
try {
  const outcomes = await Promise.all(["a", "b"].map(async (suffix) => {
    const result = await run(process.execPath, ["--input-type=module", "-e", childCode, modulePath, homePath, suffix], {
      timeout: 15_000, maxBuffer: 64 * 1024,
    });
    const outcome = JSON.parse(result.stdout);
    if (outcome.ref) refs.push(outcome.ref);
    return outcome;
  }));
  assert.equal(outcomes.filter(outcome => outcome.ok).length, 1);
  assert.equal(await runtime.isRunning(refs[0]), true, "job must survive the launching gateway process");
  await runtime.stop(refs[0]);
  assert.equal(await runtime.isRunning(refs[0]), false);
  console.log(JSON.stringify({ concurrentAdmission: "passed", supervisorRestart: "passed", exactStop: "passed" }));
} finally {
  for (const ref of refs) await runtime.stop(ref);
  await runtime.close();
  await rm(homePath, { recursive: true, force: true });
}
