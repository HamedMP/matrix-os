/* REQUIRED standalone Linux lane, excluded from default portable .test.ts runs.
 * node run.mjs --addon PATH --zellij PATH --producer PATH --evidence NEW_DIR
 * Missing prerequisites/module are failures, never skip/mock/empty success. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT_SHA, sha } from "./support.mjs";
import { happy, badReply, copiedWriter, initialExpiry, daemonExpiry, exitObservers, handoffLoss } from "./cases.mjs";

const option = name => { const at = process.argv.indexOf(name); assert.ok(at >= 0 && process.argv[at + 1], `required ${name}`); return resolve(process.argv[at + 1]); };
const addonPath = option("--addon"), zellijPath = option("--zellij"), producerPath = option("--producer"), evidence = option("--evidence");
await mkdir(evidence); // Fresh owned evidence directory; never overwrite previous acceptance.
const result = { scope: "keeper-local producer actual isolated component; not installed keeper/source/account", cases: [], cleanupPending: 0,
  sourceEnabled: false, accountQualified: false, protectedImageQualified: false, nativePolicyQualified: false,
  installedKeeperQualified: false, managerRootBindingQualified: false, canonicalRoutineQualified: false,
  physicalUnknownQualified: false, rightsQualification: false };
let native, create;
try {
  assert.equal(process.platform, "linux"); assert.notEqual(process.getuid(), 0); assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
  result.addonSha256 = sha(await readFile(addonPath)); result.zellijSha256 = sha(await readFile(zellijPath));
  assert.equal(result.zellijSha256, ROOT_SHA, "exact independently built Root108 artifact required");
  result.nativeSourceSha256 = sha(await readFile(new URL("../../../packages/gateway/native/terminal-writer.c", import.meta.url)));
  assert.equal(result.nativeSourceSha256, "5001a747a8860936d4d27ffeb3cc5fb1ca9c77f053787fb06eaf160dfd94adec");
  // Actual .node require, no substitute API or fake native implementation.
  native = createRequire(import.meta.url)(addonPath);
  for (const name of ["controlPair", "controlChildFd", "receive", "send", "close", "retainChild", "childAlive", "controlSendChildBirth"]) assert.equal(typeof native[name], "function", name);
  try {
    result.producerSha256 = sha(await readFile(producerPath));
    ({ createOwnedRootStartup: create } = await import(pathToFileURL(producerPath).href));
    assert.equal(typeof create, "function", "required createOwnedRootStartup API");
  } catch (error) {
    result.classification = error.code === "ENOENT" || error.code === "ERR_MODULE_NOT_FOUND" ? "APIabsence" : "producer-import-failure";
    throw error;
  }
  for (const [name, run] of [["real Root complete sequence plus one-use duplicate", happy], ["actual credentialled malformed reply before D", badReply],
    ["actual copied kernel writer with valid reply before D", copiedWriter],
    ["original expiry across unresolved initial validator", initialExpiry], ["actual prepared Root plus late D validator", daemonExpiry],
    ["one pending observer per actual running daemon", exitObservers],
    ["actual I loss after positive genuine birth handoff retains Unknown and D", handoffLoss]]) {
    console.log(JSON.stringify({ checkpoint: "start", name }));
    try {
      const observed = await run(create, native, zellijPath, evidence);
      result.cases.push({ name, ok: true, ...observed }); result.cleanupPending += observed.cleanupPending;
    } catch (error) {
      const cleanup = error.fixtureCleanup;
      result.cases.push({ name, ok: false, error: String(error.stack ?? error).slice(0, 4096), cleanup });
      result.cleanupPending += cleanup?.pending ?? 1;
    }
    console.log(JSON.stringify({ checkpoint: "complete", name, ok: result.cases.at(-1).ok }));
  }
} catch (error) { result.prerequisiteError = String(error.stack ?? error).slice(0, 4096); }
result.fixtures = [];
for (const name of ["run.mjs", "cases.mjs", "support.mjs", "actors.mjs", "exit-observers.mjs", "handoff-loss.mjs"]) result.fixtures.push({ name, sha256: sha(await readFile(new URL(name, import.meta.url))) });
result.ok = !result.prerequisiteError && result.cases.length === 7 && result.cases.every(c => c.ok) && result.cleanupPending === 0;
result.copiedWriterQualified = result.cases.some(c => c.ok && c.name === "actual copied kernel writer with valid reply before D");
result.postHandoffInitializerLossQualified = result.cases.some(c => c.ok && c.name === "actual I loss after positive genuine birth handoff retains Unknown and D");
result.pending = ["actual rights/correlation/digest native rejection and named faults", "other physical frame effects/Unknown/fence/lost-completion races",
  "failed retain/callback throw ownership", "source/control/currentness/image/namespace gates", "installed generation/keeper/harness/canonical account/routine/video"];
await writeFile(join(evidence, "owned-root-startup-result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
