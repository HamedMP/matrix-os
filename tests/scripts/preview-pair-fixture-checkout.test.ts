import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PREVIEW_FIXTURE_FILES, qualifyPreviewFixtureCheckout } from "../../scripts/preview-pair/qualify-fixtures.js";

it.each(["unchanged", "dirty", "switched"])("binds a receipt to an actually %s checkout after its child exits", async fault => {
  const root = await mkdtemp(join(tmpdir(), "eng418-fixture-source-")), output = join(root, "receipt.json");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    await writeFile(join(root, ".gitignore"), "node_modules/\nreceipt.json\n");
    await writeFile(join(root, "tracked.txt"), "first");
    git("init", "--quiet"); git("add", ".");
    const commit = () => git("-c", "user.name=Preview fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
    commit(); await writeFile(join(root, "tracked.txt"), "second"); git("add", "."); commit();
    const expectedSha = git("rev-parse", "HEAD"), module = join(root, "node_modules/vitest"); await mkdir(module, { recursive: true });
    // Synthetic Vitest response only: the failure boundary stays real Git,
    // real source edits/checkout, actual child execution and receipt publication.
    // This is not the actual first-party collaboration qualification lane.
    const report = { success: true, numTotalTests: PREVIEW_FIXTURE_FILES.length, numPassedTests: PREVIEW_FIXTURE_FILES.length,
      numPendingTests: 0, numFailedTests: 0, testResults: PREVIEW_FIXTURE_FILES.map(name => ({ name: join(root, name), assertionResults: [{ status: "passed" }] })) };
    await writeFile(join(module, "vitest.mjs"), `import {writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const output=process.argv.find(value=>value.startsWith('--outputFile=')).slice('--outputFile='.length);
await writeFile(output,${JSON.stringify(JSON.stringify(report))});
${fault === "dirty" ? "await writeFile('tracked.txt','changed during tests');" : fault === "switched" ? "execFileSync('git',['checkout','--quiet','HEAD~1']);" : ""}
`);
    const run = qualifyPreviewFixtureCheckout(root, { expectedSha, output, databaseUrl: "postgresql://127.0.0.1:1/disposable-fixture" });
    if (fault === "unchanged") {
      expect(await run).toMatchObject({ sourceSha: expectedSha, productAcceptance: "not_run" });
      expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ sourceSha: expectedSha, boundary: "fixture" });
    } else {
      await expect(run).rejects.toThrow();
      await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
