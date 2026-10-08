import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

function workflow() {
  return parse(readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, { if?: string; services?: Record<string, { image: string; env: Record<string, string> }>;
      env?: Record<string, string>; needs?: string[]; steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }> }>;
  };
}
describe("funded settlement real PostgreSQL CI", () => {
  it("runs independent-pool settlement tests against a disposable service with a required local URL", () => {
    const job = workflow().jobs["funded-postgres"];
    expect(job).toBeDefined();
    expect(job?.services?.postgres?.image).toBe("postgres:16");
    expect(job?.env?.MATRIX_TEST_POSTGRES_URL).toBe("postgresql://matrix_test:matrix_test@127.0.0.1:5432/matrix_test");
    const command = job?.steps?.find(step => step.name === "Verify funded settlement on PostgreSQL")?.run;
    expect(command).toContain('${MATRIX_TEST_POSTGRES_URL:?');
    expect(command).toContain("tests/platform/ai-funded-usage-postgres.test.ts");
    expect(command).toContain("tests/platform/ai-funded-recovery-migration.test.ts");
    expect(command).toContain("--maxWorkers=1");
    expect(workflow().jobs["ci-results"]?.needs).toContain("funded-postgres");
  });
  it.each(["failure", "cancelled", "skipped"])("blocks the aggregate for source changes if Postgres is %s", result => {
    const step = workflow().jobs["ci-results"]!.steps!.find(step => step.name === "Summarize required CI jobs")!;
    const dir = mkdtempSync(join(tmpdir(), "funded-ci-gate-"));
    try {
      const env = { ...process.env, GITHUB_STEP_SUMMARY: join(dir, "summary.md"), SHOULD_RUN: "true" };
      for (const name of Object.keys(step.env!)) Object.assign(env, { [name]: name === "SHOULD_RUN" ? "true" : "success" });
      Object.assign(env, { FUNDED_POSTGRES_RESULT: result });
      expect(spawnSync("bash", ["-c", step.run!], { env, encoding: "utf8", timeout: 5_000 }).status).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
