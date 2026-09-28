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

const root = process.cwd();
const SCRIPT = "scripts/test-collaboration-postgres.sh";
const REPORTER = "scripts/ci/collaboration-postgres-report.mjs";
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
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

interface FixtureTest {
  file: string;
  name: string;
  status: "passed" | "failed" | "skipped" | "pending" | "todo";
}

function vitestReport(fixtureRoot: string, tests: FixtureTest[]) {
  const files = [...new Set(tests.map((test) => test.file))];
  return {
    success: tests.every((test) => test.status !== "failed"),
    testResults: files.map((file) => ({
      name: join(fixtureRoot, file),
      status: tests.some((test) => test.file === file && test.status === "failed") ? "failed" : "passed",
      message: "",
      assertionResults: tests
        .filter((test) => test.file === file)
        .map((test) => ({ fullName: test.name, title: test.name, status: test.status, failureMessages: [] })),
    })),
  };
}

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) rmSync(fixtureRoot, { recursive: true, force: true });
});

/**
 * Copies the runner into a scratch repository whose `pnpm` is a stub that
 * writes a canned Vitest JSON report and exits with a chosen status.
 */
function createFixtureRepository(options: {
  testFiles: string[];
  report?: FixtureTest[];
  vitestExit?: number;
  vitestOutput?: string;
  quarantine?: string[];
}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "collaboration-postgres-ci-"));
  fixtureRoots.push(fixtureRoot);
  mkdirSync(join(fixtureRoot, "scripts/ci"), { recursive: true });
  mkdirSync(join(fixtureRoot, "bin"));
  copyFileSync(join(root, REPORTER), join(fixtureRoot, REPORTER));
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
  writeFileSync(join(fixtureRoot, "vitest-report.json"), JSON.stringify(vitestReport(fixtureRoot, options.report ?? [])));
  writeFileSync(join(fixtureRoot, "vitest-output.txt"), options.vitestOutput ?? "");
  writeFileSync(
    join(fixtureRoot, "bin/pnpm"),
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$@" > "$FIXTURE_ROOT/pnpm-args.txt"',
      'for arg in "$@"; do',
      '  case "$arg" in --outputFile.json=*) cp "$FIXTURE_ROOT/vitest-report.json" "${arg#--outputFile.json=}" ;; esac',
      "done",
      'cat "$FIXTURE_ROOT/vitest-output.txt"',
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
  return { fixtureRoot, env };
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
    const listed = runScript(root, ["--list"], { [VARIABLE]: undefined });

    expect(listed.status, listed.output).toBe(0);
    expect(expected.length).toBeGreaterThan(0);
    expect(listed.output.trim().split("\n").sort()).toEqual(expected);
  });

  it("runs the selection against a dedicated postgres:16 test database", () => {
    const job = readCiJobs()["collaboration-postgres"];

    expect(job).toBeDefined();
    expect([job.needs].flat()).toEqual(["changes"]);
    expect(job.if).toBe("needs.changes.outputs.should_run == 'true'");
    expect(job["timeout-minutes"]).toBe(20);
    expect(job.services?.postgres?.image).toBe("postgres:16");
    expect(job.services?.postgres?.options).toContain("--health-cmd pg_isready");
    const databaseUrl = new URL(job.env?.[VARIABLE] ?? "");
    expect(databaseUrl.pathname).toBe(`/${job.services?.postgres?.env?.POSTGRES_DB}`);
    expect(databaseUrl.pathname).toContain("test");
    const runs = (job.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(runs).toContain("pnpm install --frozen-lockfile");
    expect(runs).toContain(`bash ${SCRIPT}`);
  });

  it("registers the job in CI Results", () => {
    const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const results = readCiJobs()["ci-results"];
    const summarize = results.steps?.find((step) => step.name === "Summarize required CI jobs");

    expect(results.needs).toContain("collaboration-postgres");
    expect(summarize?.env?.COLLABORATION_POSTGRES_RESULT).toBe("${{ needs.collaboration-postgres.result }}");
    expect(summarize?.run).toContain('echo "| Collaboration PostgreSQL | $COLLABORATION_POSTGRES_RESULT |"');
    expect(summarize?.run).toMatch(/for result in [^;]*"\$COLLABORATION_POSTGRES_RESULT"[^;]*; do/);
    expect(workflow).toContain("name: Collaboration PostgreSQL");
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

  it("refuses an empty selection", () => {
    const { fixtureRoot, env } = createFixtureRepository({ testFiles: [] });
    mkdirSync(join(fixtureRoot, "tests"));

    const result = runScript(fixtureRoot, [], env);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(`No test files reference ${VARIABLE}`);
  });

  it("passes every selected file to one vitest run and succeeds when every test passes", () => {
    const { fixtureRoot, env } = createFixtureRepository({
      testFiles: [PLATFORM_FILE, GATEWAY_FILE],
      report: [
        { file: GATEWAY_FILE, name: "serializes grants", status: "passed" },
        { file: PLATFORM_FILE, name: "admits one upgrade", status: "passed" },
      ],
    });
    const summary = join(fixtureRoot, "summary.md");

    const result = runScript(fixtureRoot, [], { ...env, GITHUB_STEP_SUMMARY: summary });

    expect(result.status, result.output).toBe(0);
    const args = readFileSync(join(fixtureRoot, "pnpm-args.txt"), "utf8").trim().split("\n");
    expect(args.slice(0, 3)).toEqual(["exec", "vitest", "run"]);
    expect(args).toContain(GATEWAY_FILE);
    expect(args).toContain(PLATFORM_FILE);
    const markdown = readFileSync(summary, "utf8");
    expect(markdown).toContain("| Selected files | 2 |");
    expect(markdown).toContain("| Passed | 2 |");
    expect(markdown).toContain("| Quarantined | 0 |");
  });

  it("fails when a selected test is skipped", () => {
    const { fixtureRoot, env } = createFixtureRepository({
      testFiles: [GATEWAY_FILE],
      report: [
        { file: GATEWAY_FILE, name: "serializes grants", status: "passed" },
        { file: GATEWAY_FILE, name: "races on real Postgres", status: "skipped" },
      ],
    });

    const result = runScript(fixtureRoot, [], env);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(`skipped: ${GATEWAY_FILE} > races on real Postgres`);
  });

  it("fails when a selected file reports no tests", () => {
    const { fixtureRoot, env } = createFixtureRepository({
      testFiles: [GATEWAY_FILE, PLATFORM_FILE],
      report: [{ file: GATEWAY_FILE, name: "serializes grants", status: "passed" }],
    });

    const result = runScript(fixtureRoot, [], env);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(`not reported: ${PLATFORM_FILE}`);
  });

  it("fails when a test fails or vitest exits non-zero without a failing test", () => {
    const failing = createFixtureRepository({
      testFiles: [GATEWAY_FILE],
      report: [{ file: GATEWAY_FILE, name: "serializes grants", status: "failed" }],
      vitestExit: 1,
    });
    const failed = runScript(failing.fixtureRoot, [], failing.env);
    expect(failed.status).not.toBe(0);
    expect(failed.output).toContain(`failed: ${GATEWAY_FILE} > serializes grants`);

    const crashing = createFixtureRepository({
      testFiles: [GATEWAY_FILE],
      report: [{ file: GATEWAY_FILE, name: "serializes grants", status: "passed" }],
      vitestExit: 1,
    });
    const crashed = runScript(crashing.fixtureRoot, [], crashing.env);
    expect(crashed.status).not.toBe(0);
    expect(crashed.output).toContain("vitest exited with status 1");
  });

  it("tolerates and counts a quarantined failure but not an unhandled error beside it", () => {
    const quarantined = createFixtureRepository({
      testFiles: [GATEWAY_FILE],
      report: [
        { file: GATEWAY_FILE, name: "serializes grants", status: "passed" },
        { file: GATEWAY_FILE, name: "keeps one active run", status: "failed" },
      ],
      vitestExit: 1,
      quarantine: [`${GATEWAY_FILE}|keeps one active run|${ISSUE}`],
    });
    const summary = join(quarantined.fixtureRoot, "summary.md");
    const tolerated = runScript(quarantined.fixtureRoot, [], { ...quarantined.env, GITHUB_STEP_SUMMARY: summary });
    expect(tolerated.status, tolerated.output).toBe(0);
    expect(tolerated.output).toContain(`quarantined failure: ${GATEWAY_FILE} > keeps one active run (${ISSUE})`);
    const markdown = readFileSync(summary, "utf8");
    expect(markdown).toContain("| Quarantined | 1 |");
    expect(markdown).toContain(ISSUE);

    const unhandled = createFixtureRepository({
      testFiles: [GATEWAY_FILE],
      report: [{ file: GATEWAY_FILE, name: "keeps one active run", status: "failed" }],
      vitestExit: 1,
      vitestOutput: "Vitest caught 1 unhandled error during the test run.\n",
      quarantine: [`${GATEWAY_FILE}|keeps one active run|${ISSUE}`],
    });
    const rejected = runScript(unhandled.fixtureRoot, [], unhandled.env);
    expect(rejected.status).not.toBe(0);
    expect(rejected.output).toContain("unhandled error");
  });

  it("rejects quarantine entries without an issue link or a matching test", () => {
    const unlinked = createFixtureRepository({
      testFiles: [GATEWAY_FILE],
      report: [{ file: GATEWAY_FILE, name: "keeps one active run", status: "failed" }],
      vitestExit: 1,
      quarantine: [`${GATEWAY_FILE}|keeps one active run|TODO`],
    });
    const rejected = runScript(unlinked.fixtureRoot, [], unlinked.env);
    expect(rejected.status).not.toBe(0);
    expect(rejected.output).toContain("invalid quarantine entry");

    const stale = createFixtureRepository({
      testFiles: [GATEWAY_FILE],
      report: [{ file: GATEWAY_FILE, name: "serializes grants", status: "passed" }],
      quarantine: [`${GATEWAY_FILE}|renamed test|${ISSUE}`],
    });
    const unmatched = runScript(stale.fixtureRoot, [], stale.env);
    expect(unmatched.status).not.toBe(0);
    expect(unmatched.output).toContain(`quarantine entry matches no test: ${GATEWAY_FILE} > renamed test`);
  });
});
