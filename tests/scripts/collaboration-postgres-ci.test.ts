import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { collaborationPostgresFiles, runCollaborationPostgres } from "../../scripts/ci/collaboration-postgres.mjs";

const roots: string[] = [];
const anchors = ["tests/gateway/personal-sync-share-inventory-postgres.test.ts",
  "tests/platform/collaboration-cutover-postgres.test.ts", "tests/platform/organization-authority-postgres.test.ts"];
const factory = `createReal${"Collaboration"}TestDatabase`;
function put(root: string, file: string, source: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "collaboration-pg-ci-")); roots.push(root);
  for (const file of anchors) put(root, file, "export {};\n");
  put(root, "tests/gateway/collaboration-test-support.ts", `export function ${factory}() {}`);
  put(root, "tests/gateway/real.test.ts", `import { ${factory} } from './collaboration-test-support.js';`);
  manifest(root, [...anchors, "tests/gateway/real.test.ts"]);
  return root;
}
function manifest(root: string, files: string[]) {
  put(root, "scripts/ci/collaboration-postgres-files.json", JSON.stringify(files.sort()));
}
const env = { MATRIX_TEST_POSTGRES_URL: "postgresql://matrix_test:matrix_test@127.0.0.1:5432/matrix_test" };
function passingRunner(root: string) {
  return vi.fn((_command: string, args: string[]) => {
    const files = args.slice(3, args.indexOf("--maxWorkers=1"));
    const report = args.find(arg => arg.startsWith("--outputFile.json="))!.split("=")[1];
    writeFileSync(report, JSON.stringify({ success: true, numTotalTests: files.length, numPassedTests: files.length,
      numFailedTests: 0, numPendingTests: 0, testResults: files.map(file => ({ name: join(root, file),
        assertionResults: [{ fullName: file, status: "passed" }] })) }));
    return { status: 0 };
  });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("collaboration PostgreSQL CI inventory", () => {
  it("covers the complete registered PostgreSQL cohort", () => {
    const files = collaborationPostgresFiles(process.cwd());
    expect(files.length).toBeGreaterThanOrEqual(39);
    expect(files).toContain("tests/platform/collaboration-registration-recovery.test.ts");
    expect(files).toContain("tests/gateway/direct-resource-policy-postgres.test.ts");
    expect(files).toContain("tests/platform/platform-migration-revision-db.test.ts");
    expect(files).toEqual([...files].sort());
  });
  it("rejects a newly added real fixture consumer, including an aliased import", () => {
    const root = fixture();
    put(root, "tests/other/new.test.tsx", `import { ${factory} as database } from '../gateway/collaboration-test-support.js';`);
    expect(() => collaborationPostgresFiles(root)).toThrow("tests/other/new.test.tsx");
  });
  it("follows a real fixture wrapper without including pure PGlite consumers", () => {
    const root = fixture();
    put(root, "tests/helpers/real.ts", `export { ${factory} as database } from '../gateway/collaboration-test-support.js';`);
    put(root, "tests/gateway/wrapped.test.ts", "import { database } from '../helpers/real.js';");
    put(root, "tests/gateway/pure.test.ts", "import { createCollaborationTestDatabase } from './collaboration-test-support.js';");
    expect(() => collaborationPostgresFiles(root)).toThrow("tests/gateway/wrapped.test.ts");
    manifest(root, [...anchors, "tests/gateway/real.test.ts", "tests/gateway/wrapped.test.ts"]);
    expect(collaborationPostgresFiles(root)).not.toContain("tests/gateway/pure.test.ts");
  });
  it.each(["duplicate", "unsorted", "escape", "missing", "stale"])("rejects %s manifest entries", kind => {
    const root = fixture(); const files = JSON.parse(readFileSync(join(root, "scripts/ci/collaboration-postgres-files.json"), "utf8"));
    if (kind === "duplicate") files.push(files[0]);
    if (kind === "unsorted") files.reverse();
    if (kind === "escape") files.push("../outside.test.ts");
    if (kind === "missing") files.pop();
    if (kind === "stale") { put(root, "tests/gateway/stale.test.ts", "export {};"); files.push("tests/gateway/stale.test.ts"); files.sort(); }
    put(root, "scripts/ci/collaboration-postgres-files.json", JSON.stringify(files));
    expect(() => collaborationPostgresFiles(root)).toThrow();
  });
});

describe("collaboration PostgreSQL CI execution", () => {
  it("rejects an absent URL before launching a test", () => {
    const root = fixture(); const execute = passingRunner(root);
    expect(() => runCollaborationPostgres(root, {}, execute)).toThrow("MATRIX_TEST_POSTGRES_URL");
    expect(execute).not.toHaveBeenCalled();
  });
  it("runs the unchanged serialized 9-file batches and records every file/assertion", () => {
    const root = process.cwd(); const execute = passingRunner(root);
    const output = mkdtempSync(join(tmpdir(), "collaboration-pg-output-")); roots.push(output);
    expect(runCollaborationPostgres(root, env, execute, output)).toBe(0);
    const files = collaborationPostgresFiles(root);
    expect(execute).toHaveBeenCalledTimes(Math.ceil(files.length / 9));
    const selected = execute.mock.calls.flatMap(([, args]) => args.slice(3, args.indexOf("--maxWorkers=1")));
    expect(selected).toEqual(files);
    const batches = execute.mock.calls.map(([, args]) => args.slice(3, args.indexOf("--maxWorkers=1")));
    expect(batches.slice(0, -1).every(batch => batch.length === 9)).toBe(true);
    expect(batches.at(-1)?.length).toBe(files.length % 9 || 9);
    for (const [command, args] of execute.mock.calls) {
      expect(command).toBe("pnpm");
      expect(args.slice(0, 3)).toEqual(["exec", "vitest", "run"]);
      expect(args).toContain("--no-file-parallelism");
      expect(args).toContain("--reporter=json");
      expect(args.some(arg => /timeout|skip|passWithNoTests/.test(arg))).toBe(false);
    }
    const receipt = JSON.parse(readFileSync(join(output, "inventory.json"), "utf8"));
    expect(receipt).toMatchObject({ files: selected, verifiedPassedAssertions: files.length, qualified: true });
  });
  it("continues the remaining batches after a failed test process", () => {
    const root = fixture();
    const extra = Array.from({ length: 9 }, (_, i) => `tests/gateway/extra-${i}.test.ts`);
    for (const file of extra) put(root, file, `import { ${factory} } from './collaboration-test-support.js';`);
    manifest(root, [...anchors, "tests/gateway/real.test.ts", ...extra]);
    const pass = passingRunner(root);
    const execute = vi.fn((command: string, args: string[]) => {
      const result = pass(command, args); return pass.mock.calls.length === 1 ? { status: 1 } : result;
    });
    const output = join(root, "output");
    expect(runCollaborationPostgres(root, env, execute, output)).toBe(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(join(output, "inventory.json"), "utf8"))).toMatchObject({ qualified: false, batches: [{ exitCode: 1 }, { exitCode: 0 }] });
  });
  it("refuses a stale passing report instead of replaying it", () => {
    const root = fixture(), output = join(root, "output"), execute = passingRunner(root);
    expect(runCollaborationPostgres(root, env, execute, output)).toBe(0);
    execute.mockClear();
    expect(() => runCollaborationPostgres(root, env, execute, output)).toThrow("already exists");
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(["exit", "missing-report", "missing-file", "extra-file", "skip", "failed", "empty", "counts"])("fails closed on %s", mode => {
    const root = fixture(); const output = join(root, "output"); const pass = passingRunner(root);
    const execute = vi.fn((command: string, args: string[]) => {
      if (mode === "missing-report") return { status: 0 };
      const result = pass(command, args);
      const path = args.find(arg => arg.startsWith("--outputFile.json="))!.split("=")[1];
      const report = JSON.parse(readFileSync(path, "utf8"));
      if (mode === "missing-file") report.testResults.pop();
      if (mode === "extra-file") report.testResults.push({ name: join(root, "tests/extra.test.ts"), assertionResults: [{ status: "passed" }] });
      if (mode === "skip") report.testResults[0].assertionResults[0].status = "pending";
      if (mode === "failed") report.testResults[0].assertionResults[0].status = "failed";
      if (mode === "empty") report.testResults[0].assertionResults = [];
      if (mode === "counts") report.numTotalTests += 1;
      writeFileSync(path, JSON.stringify(report));
      return mode === "exit" ? { status: 1 } : result;
    });
    expect(runCollaborationPostgres(root, env, execute, output)).toBe(1);
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe("required collaboration PostgreSQL workflow", () => {
  it("runs Slack deletion races in the required account-deletion PostgreSQL selection", () => {
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
    expect(workflow.jobs["funded-postgres"].steps.some((step: { run?: string }) => step.run?.includes("tests/platform/account-deletion-*-postgres.test.ts"))).toBe(true);
    const selected = spawnSync("bash", ["-c", "printf '%s\\n' tests/platform/account-deletion-*-postgres.test.ts"], { encoding: "utf8", timeout: 2000, env: { PATH: process.env.PATH } });
    expect(selected.status, selected.stderr).toBe(0);
    expect(selected.stdout.trim().split("\n")).toContain("tests/platform/account-deletion-slack-postgres.test.ts");
  });

  it("retains required jobs, exact-source checkout and all commands within measured bounded qualification windows", () => {
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")); const job = workflow.jobs["funded-postgres"];
    expect(job.needs).toBe("changes"); expect(job["timeout-minutes"]).toBe(14);
    expect(job.if).not.toMatch(/dedicated|ci-backend/);
    expect(job.steps[0].with.ref).toBe("${{ needs.changes.outputs.source_sha }}");
    const fundedTestSteps = job.steps.filter((step: { run?: string }) => step.run?.includes("pnpm exec vitest run"));
    expect(new Set(fundedTestSteps.map((step: { run?: string }) => step.run)).size).toBe(fundedTestSteps.length);
    for (const suite of ["deployed-v9-schema-postgres", "routine-fencing-postgres", "routine-process-postgres"]) {
      expect(fundedTestSteps.filter((step: { run?: string }) => step.run?.includes(`tests/gateway/bots/${suite}.test.ts`))).toHaveLength(1);
    }
    expect(fundedTestSteps[5].run).toContain("tests/gateway/browser-approval-repository.test.ts --maxWorkers=1 --no-file-parallelism");
    expect(job.steps.find((step: { name?: string }) => step.name === "Build test prerequisites once").run).toBe("bun run test:prepare");
    const collaboration = workflow.jobs["collaboration-postgres"];
    expect(collaboration).toBeDefined();
    expect(collaboration.needs).toBe("changes");
    expect(collaboration.if).toBe(job.if);
    expect(collaboration["timeout-minutes"]).toBe(12);
    expect(collaboration.services).toEqual(job.services);
    expect(collaboration.env).toEqual(job.env);
    expect(collaboration.steps.slice(0, 6)).toEqual(job.steps.slice(0, 6));
    expect(job.steps.some((step: { name?: string }) => step.name === "Collaboration PostgreSQL qualification")).toBe(false);
    const step = collaboration.steps.find((step: { name?: string }) => step.name === "Collaboration PostgreSQL qualification");
    expect(step?.run).toBe("node scripts/ci/collaboration-postgres.mjs");
    expect(workflow.jobs["ci-results"].needs).toContain("funded-postgres");
    expect(workflow.jobs["ci-results"].needs).toContain("collaboration-postgres");
    expect(workflow.jobs["completion-handoff"].needs).toContain("collaboration-postgres");
    const artifact = collaboration.steps.find((step: { name?: string }) => step.name === "Upload collaboration PostgreSQL qualification");
    expect(artifact?.if).toBe("always()");
    expect(artifact?.with).toMatchObject({ path: "output/ci/collaboration-postgres/*.json", "if-no-files-found": "error", "retention-days": 7 });
  });
});


describe("required parallel PostgreSQL qualification", () => {
  it.each(["hosted", "linux"])("requires genuine collaboration success with %s qualification", provider => {
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
    const step = workflow.jobs["ci-results"].steps.find((step: { name?: string }) => step.name === "Summarize required CI jobs");
    const directory = mkdtempSync(join(tmpdir(), "collaboration-ci-gate-")); roots.push(directory);
    const env: Record<string, string> = { PATH: process.env.PATH!, GITHUB_STEP_SUMMARY: join(directory, "summary") };
    for (const key of Object.keys(step.env)) env[key] = "success";
    Object.assign(env, { CI_TRIGGER_REQUESTED: "true", SHOULD_RUN: "true", DEDICATED_ELIGIBLE: "true",
      DEDICATED_REQUIRED: "true", DEDICATED_MODE: "delegated", CI_BACKEND_PROVIDER: provider,
      INFRASTRUCTURE_FALLBACK: provider === "hosted" ? "true" : "false" });
    if (provider === "linux") for (const key of ["TYPECHECK_RESULT", "SHELL_PRODUCTION_BUILD_RESULT",
      "AGENT_SDK_COMPATIBILITY_RESULT", "UNIT_RESULT", "DOCS_CONTRACT_RESULT", "OS_VIEW_PARITY_RESULT", "E2E_RESULT"]) env[key] = "skipped";
    const run = (outcome: string) => spawnSync("bash", ["-c", step.run], {
      env: { ...env, COLLABORATION_POSTGRES_RESULT: outcome }, encoding: "utf8", timeout: 5000,
    });
    const positive = run("success"); expect(positive.status, positive.stderr).toBe(0);
    for (const outcome of ["failure", "cancelled", "skipped", "", "unknown"]) {
      const negative = run(outcome); expect(negative.status, `${outcome}: ${negative.stderr}`).toBe(1);
    }
  });
});
