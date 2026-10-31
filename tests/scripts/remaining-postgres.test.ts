import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { remainingPostgresInventory, runRemainingPostgres } from "../../scripts/ci/remaining-postgres.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const remaining = "tests/gateway/remaining.test.ts";
const legacy = "tests/gateway/legacy.test.ts";
const funded = "tests/platform/funded.test.ts";
const collaboration = "tests/gateway/collaboration.test.ts";
function fixture(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "matrix-remaining-postgres-")); roots.push(root);
  function write(file: string, source: string) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source); }
  write(".github/workflows/ci.yml", `jobs:\n  funded-postgres:\n    steps:\n      - run: pnpm exec vitest run ${funded}\n`);
  write("scripts/ci/collaboration-postgres-files.json", JSON.stringify([collaboration]));
  for (const file of [remaining, funded, collaboration]) write(file, "describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)('race', () => {});");
  for (const [file, source] of Object.entries(files)) write(file, source);
  return { root, write };
}
const env = { MATRIX_TEST_POSTGRES_URL: "postgresql://test:test@127.0.0.1:5432/matrix_test" };
function passingReport(root: string, files: string[]) {
  return { success: true, numTotalTests: files.length, numPassedTests: files.length, numFailedTests: 0, numPendingTests: 0,
    testResults: files.map(file => ({ name: join(root, file), assertionResults: [{ status: "passed" }] })) };
}
function executor(root: string, change: (report: ReturnType<typeof passingReport>) => void = () => {}) {
  return vi.fn((_command: string, args: string[]) => {
    const files = args.filter(arg => arg.endsWith(".test.ts"));
    const report = passingReport(root, files); change(report);
    const target = args.find(arg => arg.startsWith("--outputFile.json="))!.slice("--outputFile.json=".length);
    writeFileSync(target, JSON.stringify(report)); return { status: 0 };
  });
}

describe("remaining real PostgreSQL qualification", () => {
  it("assigns every required suite without duplicating existing hosted lanes", () => {
    const { root } = fixture();
    const inventory = remainingPostgresInventory(root, [remaining]);
    expect(inventory.files).toEqual([remaining]);
    expect(inventory.requirements.map(row => row.file)).toEqual([collaboration, remaining, funded].sort());
  });

  it("rejects new unassigned environment consumers, but ignores comments and source-text contracts", () => {
    const { root, write } = fixture({ "tests/platform/contract.test.ts": 'expect(source).toContain("process.env.MATRIX_TEST_POSTGRES_URL"); // process.env.MATRIX_TEST_POSTGRES_URL' });
    expect(() => remainingPostgresInventory(root, [remaining])).not.toThrow();
    write("tests/gateway/new-race.test.ts", 'const url = process.env["MATRIX_TEST_POSTGRES_URL"];');
    expect(() => remainingPostgresInventory(root, [remaining])).toThrow(/unassigned.*new-race/i);
  });

  it("detects aliased real database factories and helper wrappers", () => {
    const { root, write } = fixture({
      "tests/gateway/helper.ts": 'import { createRealBotStateDatabase as create } from "./bots/bot-state-support.js"; export const setup = () => create();',
      "tests/gateway/indirect.test.ts": 'import { setup } from "./helper.js"; setup();',
    });
    expect(() => remainingPostgresInventory(root, [remaining])).toThrow(/unassigned.*indirect/i);
    write("tests/gateway/indirect.test.ts", 'import { setup } from "./helper.js"; setup();');
    expect(remainingPostgresInventory(root, [remaining, "tests/gateway/indirect.test.ts"].sort()).files).toHaveLength(2);
  });

  it("does not treat commented, echoed, or disabled workflow paths as hosted execution", () => {
    const { root, write } = fixture();
    for (const run of [`echo pnpm exec vitest run ${funded}`, `# pnpm exec vitest run ${funded}`]) {
      write(".github/workflows/ci.yml", `jobs:\n  funded-postgres:\n    steps:\n      - run: |\n          ${run}\n`);
      expect(() => remainingPostgresInventory(root, [remaining])).toThrow(/hosted selection|unassigned/i);
    }
    write(".github/workflows/ci.yml", `jobs:\n  funded-postgres:\n    steps:\n      - if: false\n        run: pnpm exec vitest run ${funded}\n`);
    expect(() => remainingPostgresInventory(root, [remaining])).toThrow(/hosted selection|unassigned/i);
  });

  it("does not promote users of the PGlite export on a mixed fixture module", () => {
    const { root } = fixture({
      "tests/gateway/bots/bot-state-support.ts": 'export const createRealBotStateDatabase = () => process.env.MATRIX_TEST_POSTGRES_URL; export const createBotStateDatabase = () => 1;',
      "tests/gateway/pglite.test.ts": 'import { createBotStateDatabase } from "./bots/bot-state-support.js"; createBotStateDatabase();',
    });
    expect(remainingPostgresInventory(root, [remaining]).requirements.map(row => row.file)).not.toContain("tests/gateway/pglite.test.ts");
  });

  it("rejects stale, duplicate, unsafe and multiply assigned remaining entries", () => {
    const { root } = fixture();
    for (const files of [[remaining, remaining], [remaining, "../escape.test.ts"], [remaining, "tests/missing.test.ts"], [funded, remaining].sort()]) {
      expect(() => remainingPostgresInventory(root, files)).toThrow();
    }
  });

  it("records preexisting funded/collaboration overlap without scheduling it again", () => {
    const { root, write } = fixture();
    write("scripts/ci/collaboration-postgres-files.json", JSON.stringify([collaboration, funded].sort()));
    expect(remainingPostgresInventory(root, [remaining]).existingHostedOverlaps).toEqual([funded]);
  });

  it("requires a disposable loopback PostgreSQL URL before spawning tests", () => {
    const { root } = fixture(); const execute = vi.fn();
    for (const url of [undefined, "", "postgresql://db.example/matrix_test", "postgresql://127.0.0.1/customer", "https://127.0.0.1/matrix_test", "postgresql://127.0.0.1/matrix_test?options=x"]) {
      expect(() => runRemainingPostgres(root, { MATRIX_TEST_POSTGRES_URL: url }, execute, join(root, "output"), [remaining])).toThrow();
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs actual selected files and maps the legacy Chat URL explicitly", () => {
    const { root } = fixture({ [legacy]: 'if (process.env.CHAT_TEST_DATABASE_URL) {}' });
    const execute = executor(root); const output = join(root, "output");
    expect(runRemainingPostgres(root, env, execute, output, [legacy, remaining].sort())).toBe(0);
    const [command, args, options] = execute.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(command).toBe("pnpm"); expect(args).toContain(legacy); expect(args).toContain(remaining);
    expect(options.env.CHAT_TEST_DATABASE_URL).toBe(env.MATRIX_TEST_POSTGRES_URL);
    expect(JSON.parse(readFileSync(join(output, "inventory.json"), "utf8"))).toMatchObject({ qualified: true, verifiedPassedAssertions: 2 });
  });

  it.each(["skip", "empty", "missing-file", "duplicate-file", "bad-totals"])("fails qualification for %s in an otherwise successful subprocess", mode => {
    const { root } = fixture();
    const execute = executor(root, report => {
      if (mode === "skip") report.testResults[0].assertionResults[0].status = "pending";
      if (mode === "empty") report.testResults[0].assertionResults = [];
      if (mode === "missing-file") report.testResults = [];
      if (mode === "duplicate-file") report.testResults.push(report.testResults[0]);
      if (mode === "bad-totals") report.numPassedTests = 0;
    });
    const output = join(root, "output");
    expect(runRemainingPostgres(root, env, execute, output, [remaining])).toBe(1);
    expect(JSON.parse(readFileSync(join(output, "inventory.json"), "utf8"))).toMatchObject({ qualified: false });
  });

  it("rejects stale passing reports and nonzero child exits", () => {
    const first = fixture(); const output = join(first.root, "output"); mkdirSync(output);
    writeFileSync(join(output, "batch-1.json"), JSON.stringify(passingReport(first.root, [remaining])));
    const execute = vi.fn();
    expect(() => runRemainingPostgres(first.root, env, execute, output, [remaining])).toThrow(/already exists/);
    expect(execute).not.toHaveBeenCalled();
    const second = fixture(); const writeReport = executor(second.root);
    const failed = (...args: unknown[]) => { writeReport(...args as Parameters<typeof writeReport>); return { status: 1 }; };
    expect(runRemainingPostgres(second.root, env, failed, join(second.root, "output"), [remaining])).toBe(1);
  });

  it("enforces one total deadline and records unexecuted batches as failed", () => {
    const files = Array.from({ length: 5 }, (_, index) => `tests/gateway/budget-${index}.test.ts`);
    const { root } = fixture({ [remaining]: "// no real database needed", ...Object.fromEntries(files.map(file => [file, "process.env.MATRIX_TEST_POSTGRES_URL;"])) });
    let clock = 0;
    const writeReport = executor(root);
    const execute = vi.fn((...args: Parameters<typeof writeReport>) => { const result = writeReport(...args); clock = 120_001; return result; });
    const output = join(root, "output");
    expect(runRemainingPostgres(root, env, execute, output, files, () => clock)).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const report = JSON.parse(readFileSync(join(output, "inventory.json"), "utf8"));
    expect(report.qualified).toBe(false);
    expect(report.batches[1].error).toMatch(/total.*budget/i);
  });
});

it("assigns the current checkout's real PostgreSQL suites to executable hosted lanes", () => {
  expect(() => remainingPostgresInventory(process.cwd())).not.toThrow();
});
