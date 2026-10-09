import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type PostgreSqlJob = {
  needs: string; if: string; "timeout-minutes": number;
  env: Record<string, string>;
  services: { postgres: { image: string; env: Record<string, string> } };
  steps: Array<{ name?: string; run?: string }>;
};
const job = (parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
  jobs: { "funded-postgres": PostgreSqlJob };
}).jobs["funded-postgres"];
const settlementStep = job.steps.find((step) => step.name === "Verify funded settlement on PostgreSQL")!;

function executeSettlementStep(url: string | undefined) {
  const directory = mkdtempSync(join(tmpdir(), "matrix-funded-pg-ci-"));
  try {
    const argsPath = join(directory, "arguments");
    const bun = join(directory, "bun");
    writeFileSync(bun, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$WAIVER_CI_ARGUMENTS_PATH"\n');
    chmodSync(bun, 0o700);
    const result = spawnSync("bash", ["-eu", "-c", settlementStep.run!], {
      encoding: "utf8", timeout: 5_000,
      env: { PATH: `${directory}:${process.env.PATH}`, MATRIX_TEST_POSTGRES_URL: url,
        WAIVER_CI_ARGUMENTS_PATH: argsPath },
    });
    return { status: result.status, args: existsSync(argsPath) ? readFileSync(argsPath, "utf8").trim().split("\n") : [] };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("funded PostgreSQL CI coverage", () => {
  it("executes waiver and private CLI regressions under the disposable PostgreSQL job", () => {
    const result = executeSettlementStep(job.env.MATRIX_TEST_POSTGRES_URL);
    expect(result.status).toBe(0);
    expect(result.args).toEqual(expect.arrayContaining([
      "run", "test", "--", "tests/platform/ai-funded-usage-postgres.test.ts",
      "tests/platform/ai-funded-recovery-migration.test.ts",
      "tests/platform/ai-funded-usage-waiver.test.ts", "tests/platform/ai-funded-usage-waiver-cli.test.ts",
      "tests/platform/ai-funded-usage-waiver-locks-postgres.test.ts",
      "--maxWorkers=1", "--no-file-parallelism",
    ]));
  });
  it("fails before launching tests when the disposable database URL is absent", () => {
    expect(executeSettlementStep(undefined)).toMatchObject({ status: 1, args: [] });
  });
  it("keeps the existing scoped service credentials, trigger and ten-minute limit", () => {
    expect(job.needs).toBe("changes");
    expect(job.if).toBe("needs.changes.outputs.should_run == 'true'");
    expect(job["timeout-minutes"]).toBe(10);
    expect(job.services.postgres.image).toBe("postgres:16");
    expect(job.services.postgres.env).toEqual({ POSTGRES_USER: "matrix_test",
      POSTGRES_PASSWORD: "matrix_test", POSTGRES_DB: "matrix_test" });
    expect(job.env.MATRIX_TEST_POSTGRES_URL).toBe("postgresql://matrix_test:matrix_test@127.0.0.1:5432/matrix_test");
    expect(JSON.stringify(job.env)).not.toContain("secrets.");
  });
});
