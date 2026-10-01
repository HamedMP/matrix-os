import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  COLLABORATION_POSTGRES_LIMITS,
  summarizeCollaborationPostgresRun,
} from "../../scripts/ci/collaboration-postgres-report.mjs";

const root = process.cwd();
const SCRIPT = "scripts/test-collaboration-postgres.sh";
const JUDGE = "scripts/ci/collaboration-postgres-report.mjs";
const REPORTER = "scripts/ci/collaboration-postgres-vitest-reporter.mjs";
// Built from parts so this contract test does not select itself.
const VARIABLE = ["MATRIX", "TEST", "POSTGRES", "URL"].join("_");
const TEST_URL = "postgres://postgres:postgres@127.0.0.1:5432/matrix_collaboration_test";

interface WorkflowStep {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}

interface WorkflowJob {
  name?: string;
  if?: string;
  needs?: string[] | string;
  "timeout-minutes"?: number;
  strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] } };
  env?: Record<string, string>;
  services?: Record<string, { image?: string; env?: Record<string, string>; options?: string }>;
  steps?: WorkflowStep[];
}

function readCiJobs(): Record<string, WorkflowJob> {
  const workflow = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, WorkflowJob>;
  };
  return workflow.jobs;
}

function testFilesReferencingVariable(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...testFilesReferencingVariable(path));
    } else if (/\.test\.tsx?$/.test(entry.name) && readFileSync(path, "utf8").includes(VARIABLE)) {
      found.push(relative(root, path));
    }
  }
  return found;
}

function runScript(cwd: string, args: string[], env: Record<string, string | undefined>) {
  const result = spawnSync("bash", [join(cwd, SCRIPT), ...args], {
    cwd,
    env: { ...process.env, GITHUB_STEP_SUMMARY: undefined, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, stdout: result.stdout };
}

function listed(output: string): string[] {
  return output.trim().split("\n").filter(Boolean);
}

interface FixtureTest {
  file: string;
  name: string;
  state: "passed" | "failed" | "skipped" | "pending";
}

interface FixtureReport {
  tests?: FixtureTest[];
  suiteErrors?: Record<string, string[]>;
  unhandledErrors?: string[];
}

/** The shape scripts/ci/collaboration-postgres-vitest-reporter.mjs writes. */
function collaborationReport({ tests = [], suiteErrors = {}, unhandledErrors = [] }: FixtureReport) {
  const files = [...tests.map((test) => test.file), ...Object.keys(suiteErrors)]
    .filter((file, index, all) => all.indexOf(file) === index);
  return {
    unhandledErrors,
    modules: files.map((file) => ({
      file,
      errors: suiteErrors[file] ?? [],
      tests: tests.filter((test) => test.file === file).map(({ name, state }) => ({ name, state })),
    })),
  };
}

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) rmSync(fixtureRoot, { recursive: true, force: true });
});

function createScratchDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "collaboration-postgres-ci-"));
  fixtureRoots.push(directory);
  return directory;
}

/**
 * Copies the runner into a scratch repository whose `pnpm` is a stub that
 * writes a canned collaboration report and exits with a chosen status.
 */
function createFixtureRepository(options: FixtureReport & {
  testFiles: string[];
  vitestExit?: number;
  quarantine?: string[];
}) {
  const fixtureRoot = createScratchDirectory();
  mkdirSync(join(fixtureRoot, "scripts/ci"), { recursive: true });
  mkdirSync(join(fixtureRoot, "bin"));
  copyFileSync(join(root, JUDGE), join(fixtureRoot, JUDGE));
  let script = readFileSync(join(root, SCRIPT), "utf8");
  if (options.quarantine) {
    const block = /^QUARANTINE=\(\n[\s\S]*?^\)$/m;
    expect(script).toMatch(block);
    script = script.replace(block, `QUARANTINE=(\n${options.quarantine.map((entry) => `  "${entry}"`).join("\n")}\n)`);
  }
  writeFileSync(join(fixtureRoot, SCRIPT), script);
  for (const file of options.testFiles) {
    mkdirSync(join(fixtureRoot, file, ".."), { recursive: true });
    writeFileSync(join(fixtureRoot, file), `const url = process.env.${VARIABLE};\n`);
  }
  writeFileSync(join(fixtureRoot, "canned-report.json"), JSON.stringify(collaborationReport(options)));
  writeFileSync(
    join(fixtureRoot, "bin/pnpm"),
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$@" > "$FIXTURE_ROOT/pnpm-args.txt"',
      'cp "$FIXTURE_ROOT/canned-report.json" "$COLLABORATION_POSTGRES_REPORT"',
      `exit ${options.vitestExit ?? 0}`,
      "",
    ].join("\n"),
  );
  chmodSync(join(fixtureRoot, "bin/pnpm"), 0o755);
  const env = {
    FIXTURE_ROOT: fixtureRoot,
    PATH: `${join(fixtureRoot, "bin")}:${process.env.PATH}`,
    [VARIABLE]: TEST_URL,
  };
  const vitestArgs = () => listed(readFileSync(join(fixtureRoot, "pnpm-args.txt"), "utf8"));
  return { fixtureRoot, env, vitestArgs };
}

const GATEWAY_FILE = "tests/gateway/races-postgres.test.ts";
const PLATFORM_FILE = "tests/platform/races-postgres.test.ts";
const ISSUE = "https://github.com/HamedMP/matrix-os/issues/1";

describe("real-PostgreSQL collaboration suites in CI", () => {
  it(`selects every test file that references ${VARIABLE}`, () => {
    const expected = [
      ...testFilesReferencingVariable(join(root, "tests")),
      ...testFilesReferencingVariable(join(root, "packages")),
    ].sort();
    const all = runScript(root, ["--list"], { [VARIABLE]: undefined });
    const first = runScript(root, ["--list", "--shard", "1/2"], { [VARIABLE]: undefined });
    const second = runScript(root, ["--list", "--shard", "2/2"], { [VARIABLE]: undefined });

    expect(all.status, all.output).toBe(0);
    expect(expected.length).toBeGreaterThan(0);
    expect(listed(all.stdout).sort()).toEqual(expected);
    expect(listed(first.stdout).length).toBeGreaterThan(0);
    expect(listed(second.stdout).length).toBeGreaterThan(0);
    expect([...listed(first.stdout), ...listed(second.stdout)].sort()).toEqual(expected);
  });

  it("runs the selection in two shards against a dedicated postgres:16 test database", () => {
    const job = readCiJobs()["collaboration-postgres"];

    expect(job).toBeDefined();
    expect([job.needs].flat()).toEqual(["changes"]);
    expect(job.if).toBe("needs.changes.outputs.should_run == 'true'");
    expect(job["timeout-minutes"]).toBe(20);
    expect(job.strategy?.["fail-fast"]).toBe(false);
    expect(job.strategy?.matrix?.shard).toEqual([1, 2]);
    expect(job.services?.postgres?.image).toBe("postgres:16");
    expect(job.services?.postgres?.options).toContain("--health-cmd pg_isready");
    const databaseUrl = new URL(job.env?.[VARIABLE] ?? "");
    expect(databaseUrl.pathname).toBe(`/${job.services?.postgres?.env?.POSTGRES_DB}`);
    expect(databaseUrl.pathname).toContain("test");
    const runs = (job.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(runs).toContain("pnpm install --frozen-lockfile");
    expect(runs).toContain(`bash ${SCRIPT} --shard \${{ matrix.shard }}/2`);
  });

  it("registers the job in CI Results", () => {
    const results = readCiJobs()["ci-results"];
    const summarize = results.steps?.find((step) => step.name === "Summarize required CI jobs");

    expect(results.needs).toContain("collaboration-postgres");
    expect(summarize?.env?.COLLABORATION_POSTGRES_RESULT).toBe("${{ needs.collaboration-postgres.result }}");
    expect(summarize?.run).toContain('echo "| Collaboration PostgreSQL | $COLLABORATION_POSTGRES_RESULT |"');
    expect(summarize?.run).toMatch(/for result in [^;]*"\$COLLABORATION_POSTGRES_RESULT"[^;]*; do/);
  });

  it("refuses to run without a dedicated test database", () => {
    const { fixtureRoot, env } = createFixtureRepository({ testFiles: [GATEWAY_FILE] });

    const missing = runScript(fixtureRoot, [], { ...env, [VARIABLE]: undefined });
    expect(missing.status).not.toBe(0);
    expect(missing.output).toContain(`${VARIABLE} is required`);

    const shared = runScript(fixtureRoot, [], {
      ...env,
      [VARIABLE]: "postgres://postgres:postgres@127.0.0.1:5432/platform",
    });
    expect(shared.status).not.toBe(0);
    expect(shared.output).toContain("must name a dedicated test database");
    expect(shared.output).not.toContain("postgres:postgres@");
  });

  it("refuses an empty selection, an empty shard and a malformed shard", () => {
    const empty = createFixtureRepository({ testFiles: [] });
    mkdirSync(join(empty.fixtureRoot, "tests"));
    const none = runScript(empty.fixtureRoot, [], empty.env);
    expect(none.status).not.toBe(0);
    expect(none.output).toContain(`No test files reference ${VARIABLE}`);

    const single = createFixtureRepository({ testFiles: [GATEWAY_FILE] });
    const idle = runScript(single.fixtureRoot, ["--shard", "2/2"], single.env);
    expect(idle.status).not.toBe(0);
    expect(idle.output).toContain("Shard 2/2 selects no test files");

    for (const shard of ["0/2", "3/2", "two"]) {
      const malformed = runScript(single.fixtureRoot, ["--shard", shard], single.env);
      expect(malformed.status).toBe(2);
      expect(malformed.output).toContain("--shard expects <index>/<count>");
    }
  });

  it("runs every file of its shard in one vitest run and succeeds when every test passes", () => {
    const { fixtureRoot, env, vitestArgs } = createFixtureRepository({
      testFiles: [PLATFORM_FILE, GATEWAY_FILE],
      tests: [
        { file: GATEWAY_FILE, name: "grants > serializes accepts", state: "passed" },
        { file: PLATFORM_FILE, name: "admits one upgrade", state: "passed" },
      ],
    });
    const summary = join(fixtureRoot, "summary.md");

    const result = runScript(fixtureRoot, [], { ...env, GITHUB_STEP_SUMMARY: summary });

    expect(result.status, result.output).toBe(0);
    expect(vitestArgs().slice(0, 3)).toEqual(["exec", "vitest", "run"]);
    expect(vitestArgs()).toContain(`--reporter=./${REPORTER}`);
    expect(vitestArgs()).toContain(GATEWAY_FILE);
    expect(vitestArgs()).toContain(PLATFORM_FILE);
    const markdown = readFileSync(summary, "utf8");
    expect(markdown).toContain("| Selected files | 2 |");
    expect(markdown).toContain("| Passed | 2 |");
    expect(markdown).toContain("| Failed (including quarantined) | 0 |");
    expect(markdown).toContain("| Quarantined | 0 |");

    const sharded = createFixtureRepository({
      testFiles: [PLATFORM_FILE, GATEWAY_FILE],
      tests: [{ file: PLATFORM_FILE, name: "admits one upgrade", state: "passed" }],
      quarantine: [`${GATEWAY_FILE}|grants > serializes accepts|${ISSUE}`],
    });
    const second = runScript(sharded.fixtureRoot, ["--shard", "2/2"], sharded.env);
    expect(second.status, second.output).toBe(0);
    expect(sharded.vitestArgs()).toContain(PLATFORM_FILE);
    expect(sharded.vitestArgs()).not.toContain(GATEWAY_FILE);
  });

  it("fails on a skipped test, an unreported file, a failed test or an unexplained exit", () => {
    const skipping = createFixtureRepository({
      testFiles: [GATEWAY_FILE, PLATFORM_FILE],
      tests: [
        { file: GATEWAY_FILE, name: "grants > serializes accepts", state: "passed" },
        { file: GATEWAY_FILE, name: "races on real Postgres", state: "skipped" },
      ],
    });
    const skipped = runScript(skipping.fixtureRoot, [], skipping.env);
    expect(skipped.status).not.toBe(0);
    expect(skipped.output).toContain(`skipped: ${GATEWAY_FILE} > races on real Postgres`);
    expect(skipped.output).toContain(`not reported: ${PLATFORM_FILE}`);

    const failing = createFixtureRepository({
      testFiles: [GATEWAY_FILE],
      tests: [{ file: GATEWAY_FILE, name: "grants > serializes accepts", state: "failed" }],
      vitestExit: 1,
    });
    const failed = runScript(failing.fixtureRoot, [], failing.env);
    expect(failed.status).not.toBe(0);
    expect(failed.output).toContain(`failed: ${GATEWAY_FILE} > grants > serializes accepts`);

    const crashing = createFixtureRepository({
      testFiles: [GATEWAY_FILE],
      tests: [{ file: GATEWAY_FILE, name: "grants > serializes accepts", state: "passed" }],
      vitestExit: 1,
    });
    const crashed = runScript(crashing.fixtureRoot, [], crashing.env);
    expect(crashed.status).not.toBe(0);
    expect(crashed.output).toContain("vitest exited with status 1 without a failing test");
  });

  it("tolerates and counts a quarantined failure but not a suite or unhandled error beside it", () => {
    const quarantine = [`${GATEWAY_FILE}|chat > keeps one active run|${ISSUE}`];
    const tests: FixtureTest[] = [
      { file: GATEWAY_FILE, name: "grants > serializes accepts", state: "passed" },
      { file: GATEWAY_FILE, name: "chat > keeps one active run", state: "failed" },
    ];
    const quarantined = createFixtureRepository({ testFiles: [GATEWAY_FILE], tests, vitestExit: 1, quarantine });
    const summary = join(quarantined.fixtureRoot, "summary.md");
    const tolerated = runScript(quarantined.fixtureRoot, [], { ...quarantined.env, GITHUB_STEP_SUMMARY: summary });
    expect(tolerated.status, tolerated.output).toBe(0);
    expect(tolerated.output).toContain(`quarantined failure: ${GATEWAY_FILE} > chat > keeps one active run (${ISSUE})`);
    const markdown = readFileSync(summary, "utf8");
    expect(markdown).toContain("| Failed (including quarantined) | 1 |");
    expect(markdown).toContain("| Quarantined | 1 |");
    expect(markdown).toContain(ISSUE);

    const hook = createFixtureRepository({
      testFiles: [GATEWAY_FILE],
      tests,
      suiteErrors: { [GATEWAY_FILE]: ["chat: afterAll cleanup failed"] },
      vitestExit: 1,
      quarantine,
    });
    const hookFailure = runScript(hook.fixtureRoot, [], hook.env);
    expect(hookFailure.status).not.toBe(0);
    expect(hookFailure.output).toContain(`suite error: ${GATEWAY_FILE}: chat: afterAll cleanup failed`);

    const unhandled = createFixtureRepository({
      testFiles: [GATEWAY_FILE],
      tests,
      unhandledErrors: ["late rejection"],
      vitestExit: 1,
      quarantine,
    });
    const unhandledFailure = runScript(unhandled.fixtureRoot, [], unhandled.env);
    expect(unhandledFailure.status).not.toBe(0);
    expect(unhandledFailure.output).toContain("unhandled error: late rejection");
  });

  it("rejects quarantine entries without an issue link, a selected file or a matching test", () => {
    const tests: FixtureTest[] = [{ file: GATEWAY_FILE, name: "grants > serializes accepts", state: "passed" }];
    const cases = [
      { entry: `${GATEWAY_FILE}|grants > serializes accepts|TODO`, message: "invalid quarantine entry" },
      { entry: `tests/gateway/deleted.test.ts|gone|${ISSUE}`, message: "quarantine entry names an unselected file" },
      { entry: `${GATEWAY_FILE}|renamed test|${ISSUE}`, message: `quarantine entry matches no test: ${GATEWAY_FILE} > renamed test` },
    ];
    for (const { entry, message } of cases) {
      const fixture = createFixtureRepository({ testFiles: [GATEWAY_FILE], tests, quarantine: [entry] });
      const result = runScript(fixture.fixtureRoot, [], fixture.env);
      expect(result.status, entry).not.toBe(0);
      expect(result.output).toContain(message);
    }
  });

  it("fails closed instead of judging inputs beyond its caps", () => {
    const { selectedFiles, quarantineEntries, reportedTests } = COLLABORATION_POSTGRES_LIMITS;
    const selection = [GATEWAY_FILE];
    const passing = { unhandledErrors: [], modules: [{ file: GATEWAY_FILE, errors: [], tests: [{ name: "passes", state: "passed" }] }] };
    const judge = (overrides: Record<string, unknown>) => summarizeCollaborationPostgresRun({
      report: passing,
      selection,
      quarantine: { entries: [], errors: [] },
      vitestStatus: 0,
      ...overrides,
    });

    expect(judge({}).ok).toBe(true);
    const files = Array.from({ length: selectedFiles + 1 }, (_, index) => `tests/gateway/suite-${index}.test.ts`);
    expect(judge({ allSelected: files }).errors).toEqual([`selection exceeds ${selectedFiles} files`]);
    const entries = Array.from({ length: quarantineEntries + 1 }, (_, index) => ({ file: GATEWAY_FILE, name: `test ${index}`, issue: ISSUE }));
    expect(judge({ quarantine: { entries, errors: [] } }).errors).toEqual([`quarantine exceeds ${quarantineEntries} entries`]);
    const tests = Array.from({ length: reportedTests + 1 }, (_, index) => ({ name: `test ${index}`, state: "passed" }));
    const oversized = { unhandledErrors: [], modules: [{ file: GATEWAY_FILE, errors: [], tests }] };
    expect(judge({ report: oversized }).errors).toEqual([`report exceeds ${reportedTests} tests`]);
  });

  it("reports module, suite-hook and unhandled errors from a real vitest run", () => {
    const fixtureRoot = createScratchDirectory();
    mkdirSync(join(fixtureRoot, "tests"));
    writeFileSync(join(fixtureRoot, "vitest.config.mjs"), 'export default { test: { globals: true, include: ["tests/*.test.mjs"] } };\n');
    writeFileSync(join(fixtureRoot, "tests/a.test.mjs"), [
      'describe("outer", () => {',
      '  it("passes", () => {});',
      '  it("fails", () => { throw new Error("boom"); });',
      '  it.skip("skipped", () => {});',
      '  describe("inner", () => {',
      '    afterAll(() => { throw new Error("after all broke"); });',
      '    it("inner passes", () => {});',
      "  });",
      "});",
      "",
    ].join("\n"));
    writeFileSync(join(fixtureRoot, "tests/b.test.mjs"), 'throw new Error("import broke");\n');
    writeFileSync(join(fixtureRoot, "tests/c.test.mjs"), [
      'it("leaks", () => { setTimeout(() => { throw new Error("late unhandled"); }, 1); });',
      'it("waits", async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });',
      "",
    ].join("\n"));
    const reportPath = join(fixtureRoot, "report.json");

    const result = spawnSync(
      join(root, "node_modules/.bin/vitest"),
      ["run", "--root", fixtureRoot, "--config", join(fixtureRoot, "vitest.config.mjs"), `--reporter=${join(root, REPORTER)}`],
      { cwd: root, env: { ...process.env, COLLABORATION_POSTGRES_REPORT: reportPath }, encoding: "utf8", timeout: 60_000 },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(report.unhandledErrors).toEqual(["late unhandled"]);
    const byFile = Object.fromEntries(report.modules.map((module: { file: string }) => [module.file, module]));
    expect(byFile["tests/a.test.mjs"]).toEqual({
      file: "tests/a.test.mjs",
      errors: ["outer > inner: after all broke"],
      tests: [
        { name: "outer > passes", state: "passed" },
        { name: "outer > fails", state: "failed" },
        { name: "outer > skipped", state: "skipped" },
        { name: "outer > inner > inner passes", state: "passed" },
      ],
    });
    expect(byFile["tests/b.test.mjs"]).toEqual({ file: "tests/b.test.mjs", errors: ["import broke"], tests: [] });
    expect(byFile["tests/c.test.mjs"].tests).toEqual([
      { name: "leaks", state: "passed" },
      { name: "waits", state: "passed" },
    ]);
  });
});
