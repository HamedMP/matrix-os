import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verifyRoutineArtifact } from "../../../scripts/testing/preflight-routine-acceptance.mjs";
const hash = s => createHash("sha256").update(s).digest("hex");
const HEAD = "1".repeat(40);
async function fixture(run) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "routine-preflight-")));
  const root = join(dir, "root"), build = join(dir, "build");
  await mkdir(root); await mkdir(build);
  await writeFile(join(root, "pnpm-lock.yaml"), "lock");
  await writeFile(join(root, "source.ts"), "original-source");
  await writeFile(join(build, "bot-worker.mjs"), "original-worker");
  await writeFile(join(build, "routine-process.mjs"), "original-worker");
  const manifest = { head: HEAD, root, lockSha256: hash("lock"), artifacts: [{ file: "bot-worker.mjs", sha256: hash("original-worker"),
    sources: [{ path: "source.ts", realPath: join(root, "source.ts"), sha256: hash("original-source") }] }] };
  manifest.artifacts.push({...manifest.artifacts[0],file:"routine-process.mjs"});
  await writeFile(join(build, "build.json"), JSON.stringify(manifest));
  try { await run({ root, build, manifest }); } finally { await rm(dir, { recursive: true, force: true }); }
}
test("accepts exact recorded source/artifact/lock bytes without claiming live qualification", () => fixture(async ({root,build}) => {
  const result = await verifyRoutineArtifact(root, build, HEAD);
  assert.equal(result.ok, true); assert.equal(result.liveQualified, false); assert.equal(result.inputCount, 2);
}));
test("rejects stale head and changed lock even when artifact bytes still match", () => fixture(async ({root,build}) => {
  await writeFile(join(root,"pnpm-lock.yaml"),"different-lock");
  const result = await verifyRoutineArtifact(root,build,"2".repeat(40));
  assert.equal(result.ok,false); assert.deepEqual(result.failures.sort(),["build_head_mismatch","lock_mismatch"]);
}));
test("rejects changed source and worker bytes", () => fixture(async ({root,build}) => {
  await writeFile(join(root,"source.ts"),"fault"); await writeFile(join(build,"bot-worker.mjs"),"fault");
  const result = await verifyRoutineArtifact(root,build,HEAD);
  assert.equal(result.ok,false); assert.ok(result.failures.includes("artifact_mismatch:bot-worker.mjs"));
  assert.ok(result.failures.includes("source_mismatch:source.ts"));
}));
test("empty artifact/source collections cannot qualify", () => fixture(async ({root,build,manifest}) => {
  manifest.artifacts[0].sources=[];
  await writeFile(join(build,"build.json"),JSON.stringify(manifest));
  assert.equal((await verifyRoutineArtifact(root,build,HEAD)).ok,false);
  manifest.artifacts=[]; await writeFile(join(build,"build.json"),JSON.stringify(manifest));
  assert.equal((await verifyRoutineArtifact(root,build,HEAD)).ok,false);
}));

test("both required artifacts must be present exactly once", () => fixture(async ({root,build,manifest}) => {
  manifest.artifacts.pop();await writeFile(join(build,"build.json"),JSON.stringify(manifest));
  assert.equal((await verifyRoutineArtifact(root,build,HEAD)).ok,false);
  manifest.artifacts.push({...manifest.artifacts[0]});await writeFile(join(build,"build.json"),JSON.stringify(manifest));
  assert.equal((await verifyRoutineArtifact(root,build,HEAD)).ok,false);
}));
