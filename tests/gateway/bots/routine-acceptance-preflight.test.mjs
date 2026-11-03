import { parse as parseYaml } from "yaml";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verifyRoutineArtifact } from "../../../scripts/testing/preflight-routine-acceptance.mjs";
import { collectRoutineCompilerInputs } from "../../../scripts/testing/routine-compiler-inputs.mjs";
const hash = s => createHash("sha256").update(s).digest("hex");
const HEAD = "1".repeat(40);
async function fixture(run) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "routine-preflight-")));
  const root = join(dir, "root"), build = join(dir, "build");
  await mkdir(root); await mkdir(build);
  await writeFile(join(root, "pnpm-lock.yaml"), "lock");
  await writeFile(join(root, "source.ts"), "original-source");
  await writeFile(join(root,"tsconfig.json"), JSON.stringify({ compilerOptions: { target:"ES2022", module:"NodeNext", moduleResolution:"NodeNext" } }));
  for (const name of ["kernel","observability"]) {
    const directory = join(root,"packages",name); await mkdir(directory,{recursive:true});
    await writeFile(join(directory,"tsconfig.json"),JSON.stringify({extends:"../../tsconfig.json",include:["../../*.ts"]}));
  }
  await writeFile(join(build, "bot-worker.mjs"), "original-worker");
  await writeFile(join(build, "routine-process.mjs"), "original-worker");
  const manifest = { head: HEAD, root, compilerInputs: await collectRoutineCompilerInputs(root), lockSha256: hash("lock"), artifacts: [{ file: "bot-worker.mjs", sha256: hash("original-worker"),
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

test("rejects changed compiler input behind an unchanged compiled workspace export", () => fixture(async ({root,build,manifest}) => {
  const source = join(root,"compiler-source.ts");
  await writeFile(source,"compiler-input-original");
  manifest.compilerInputs = await collectRoutineCompilerInputs(root);
  await writeFile(join(build,"build.json"),JSON.stringify(manifest));
  assert.equal((await verifyRoutineArtifact(root,build,HEAD)).ok,true);
  await writeFile(source,"compiler-input-changed-without-rebuilding-dist");
  const result = await verifyRoutineArtifact(root,build,HEAD);
  assert.equal(result.ok,false); assert.ok(result.failures.includes("compiler_source_mismatch:compiler-source.ts"));
}));

test("compiler inventory includes source behind dist exports and extended configuration", async () => {
  const { collectRoutineCompilerInputs } = await import("../../../scripts/testing/routine-compiler-inputs.mjs");
  const inputs = await collectRoutineCompilerInputs(process.cwd());
  const paths = inputs.map(input => input.path);
  assert.ok(paths.includes("packages/observability/src/events.ts"));
  assert.ok(paths.includes("packages/kernel/src/index.ts"));
  assert.ok(paths.includes("tsconfig.json"));
  assert.ok(inputs.every(input => /^[a-f0-9]{64}$/.test(input.sha256)));
});

test("hosted CI executes both required node-test acceptance suites", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = parseYaml(await readFile(".github/workflows/ci.yml", "utf8"));
  const commands = workflow.jobs["funded-postgres"].steps.filter(step => step.if !== false)
    .flatMap(step => [...String(step.run ?? "").matchAll(/(?:^|\n)\s*node --test ([^\n#]+)/g)].map(match => match[1].trim().split(/\s+/)));
  for (const file of ["tests/gateway/bots/routine-acceptance-preflight.test.mjs", "tests/gateway/bots/routine-acceptance-capture.test.mjs"]) assert.ok(commands.some(args => args.includes(file)), `Missing actual node:test CI command: ${file}`);
});

test("rejects a newly included compiler source even when every recorded byte is unchanged", () => fixture(async ({root,build}) => {
  assert.equal((await verifyRoutineArtifact(root,build,HEAD)).ok,true);
  await writeFile(join(root,"new-included-source.ts"),"export const added = true;");
  const result = await verifyRoutineArtifact(root,build,HEAD);
  assert.equal(result.ok,false);
  assert.ok(result.failures.includes("compiler_inventory_mismatch"));
}));
