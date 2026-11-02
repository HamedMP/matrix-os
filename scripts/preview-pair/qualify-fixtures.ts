#!/usr/bin/env bun
import { constants } from "node:fs";
import { z } from "zod/v4";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readBuildSource } from "../release/build-source.mjs";
import { writeQualificationExport } from "./qualify.js";
export const PREVIEW_FIXTURE_FILES = [
  "tests/ui/project-sharing-relay-readiness.test.tsx",
  "tests/ui/project-sharing-owner-generation-postgres.test.tsx",
  "tests/gateway/collaboration-member-grant-e2e.test.ts",
  "tests/gateway/collaboration-project-sharing.test.ts",
  "tests/gateway/collaboration-project-inheritance.test.ts",
  "tests/gateway/shared-coding-execution.test.ts",
  "tests/desktop/create-project-sharing.test.tsx",
  "tests/desktop/work-rail-project-sharing.test.tsx",
] as const;
const unavailable = () => new Error("Fixture qualification is unavailable");
export function collectPreviewFixtureReport(root: string, raw: unknown) {
  const data = z.object({ success: z.literal(true), numTotalTests: z.number().int().nonnegative(),
    numPassedTests: z.number().int().nonnegative(), numPendingTests: z.literal(0), numFailedTests: z.literal(0),
    testResults: z.array(z.object({ name: z.string().max(2048), assertionResults: z.array(z.object({ status: z.literal("passed") })).min(1).max(2000) })).length(PREVIEW_FIXTURE_FILES.length) }).parse(raw);
  const expected = new Set<string>(PREVIEW_FIXTURE_FILES), seen = new Set<string>(); // eight static entries; disposed per report.
  let assertions = 0;
  for (const file of data.testResults) {
    if (!file || typeof file.name !== "string") throw unavailable();
    const name = relative(root, file.name).split("\\").join("/");
    if (!expected.has(name) || seen.has(name) || !Array.isArray(file.assertionResults) || !file.assertionResults.length
      || file.assertionResults.some(result => result.status !== "passed")) throw unavailable();
    seen.add(name); assertions += file.assertionResults.length;
  }
  if (data.numTotalTests !== assertions || data.numPassedTests !== assertions || data.numPendingTests !== 0 || data.numFailedTests !== 0) throw unavailable();
  return { boundary: "fixture" as const, files: PREVIEW_FIXTURE_FILES, assertions, productAcceptance: "not_run" as const };
}
/** Exact checkout, actual first-party client/relay/owner-route/UI test lane.
 * Its real Postgres dependency must be an explicitly selected disposable server.
 * Candidate tests receive no control, cloud, GitHub or provider credentials. */
export async function qualifyPreviewFixtures(options: { expectedSha: string; output: string; databaseUrl: string }) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const source = readBuildSource(root, options.expectedSha); if (!source) throw unavailable();
  const database = new URL(options.databaseUrl);
  if (!["postgres:", "postgresql:"].includes(database.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname)) throw unavailable();
  const temporary = await mkdtemp(join(tmpdir(), "matrix-preview-fixture-"));
  try {
    const report = join(temporary, "vitest.json"), env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: temporary,
      LANG: process.env.LANG, NODE_OPTIONS: "--max-old-space-size=768", MATRIX_TEST_POSTGRES_URL: options.databaseUrl };
    await promisify(execFile)("node", [join(root, "node_modules/vitest/vitest.mjs"), "run", ...PREVIEW_FIXTURE_FILES,
      "--maxWorkers=1", "--no-file-parallelism", "--reporter=json", `--outputFile=${report}`], { cwd: root, env, timeout: 30 * 60_000, maxBuffer: 1024 * 1024 });
    const file = await open(report, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: unknown;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw unavailable();
      const bytes = Buffer.alloc(8 * 1024 * 1024 + 1), read = await file.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > 8 * 1024 * 1024) throw unavailable();
      raw = JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8"));
    } finally { await file.close(); }
    const summary = collectPreviewFixtureReport(root, raw);
    const result = { schemaVersion: 1, sourceSha: source.commit, ...summary };
    await writeQualificationExport(options.output, result); return result;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
async function main() {
  const args = process.argv.slice(2); if (args[0] === "--") args.shift();
  const { values } = parseArgs({ args, options: { help: { type: "boolean" }, "expected-sha": { type: "string" }, output: { type: "string" } }, strict: true });
  if (values.help) { console.log("preview:pair:qualify:fixtures --expected-sha <full-clean-checkout-sha> --output <new-fixture-report.json>. Requires MATRIX_TEST_POSTGRES_URL for an explicitly selected disposable loopback Postgres. Runs retained first-party sharing/privacy/authorization tests; never counts as live pair acceptance."); return; }
  if (!values["expected-sha"] || !values.output || !process.env.MATRIX_TEST_POSTGRES_URL) throw unavailable();
  const result = await qualifyPreviewFixtures({ expectedSha: values["expected-sha"], output: values.output, databaseUrl: process.env.MATRIX_TEST_POSTGRES_URL });
  console.log(JSON.stringify({ assertions: result.assertions, boundary: result.boundary, productAcceptance: result.productAcceptance }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error: unknown) => {
  console.warn("[preview-pair] fixture qualification failed", error instanceof Error ? error.name : "UnknownError");
  console.error("Fixture qualification failed. Check the exact clean checkout, explicitly selected disposable Postgres, required tests and new output path. Live acceptance remains not_run."); process.exitCode = 1;
});
