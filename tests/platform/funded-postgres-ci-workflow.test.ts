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

function executeSettlementStep(url: string | undefined, step = settlementStep) {
  const directory = mkdtempSync(join(tmpdir(), "matrix-funded-pg-ci-"));
  try {
    const argsPath = join(directory, "arguments");
    const pnpm = join(directory, "pnpm");
    writeFileSync(pnpm, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$WAIVER_CI_ARGUMENTS_PATH"\n');
    chmodSync(pnpm, 0o700);
    // Fail safely if a workflow regresses to the old prerequisite wrapper.
    const bun = join(directory, "bun");
    writeFileSync(bun, '#!/usr/bin/env bash\nprintf "Unexpected bun escaped the command stub\\n" >&2\nexit 73\n');
    chmodSync(bun, 0o700);
    const result = spawnSync("bash", ["-eu", "-c", step.run!], {
      encoding: "utf8", timeout: 5_000,
      env: { PATH: `${directory}:${process.env.PATH}`, MATRIX_TEST_POSTGRES_URL: url,
        WAIVER_CI_ARGUMENTS_PATH: argsPath },
    });
    return {
      status: result.status,
      args: existsSync(argsPath) ? readFileSync(argsPath, "utf8").trim().split("\n") : [],
      diagnostics: JSON.stringify({ error: result.error?.message, signal: result.signal, stderr: result.stderr }),
    };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("funded PostgreSQL CI coverage", () => {
  it("runs pooled custom Bot creation and rollback in the bounded disposable service step", () => {
    const step = job.steps.find(candidate => candidate.run?.includes("tests/gateway/bots/integration-grant-source-postgres.test.ts"))!;
    const result = executeSettlementStep(job.env.MATRIX_TEST_POSTGRES_URL, step);
    expect(result.status, result.diagnostics).toBe(0);
    expect(result.args).toEqual([
      "exec", "vitest", "run", "tests/gateway/bots/integration-grant-source-postgres.test.ts",
      "tests/gateway/bots/instantiation.test.ts", "--maxWorkers=1", "--no-file-parallelism",
    ]);
    const absentUrl = executeSettlementStep(undefined, step);
    expect(absentUrl, absentUrl.diagnostics).toMatchObject({ status: 1, args: [] });
  });
  it("executes waiver and private CLI regressions under the disposable PostgreSQL job", () => {
    const result = executeSettlementStep(job.env.MATRIX_TEST_POSTGRES_URL);
    expect(result.status, result.diagnostics).toBe(0);
    expect(result.args).toEqual([
      "exec", "vitest", "run", "tests/platform/ai-funded-usage-postgres.test.ts",
      "tests/platform/ai-funded-recovery-migration.test.ts",
      "tests/platform/ai-funded-usage-waiver.test.ts", "tests/platform/ai-funded-usage-waiver-cli.test.ts",
      "tests/platform/ai-funded-usage-waiver-locks-postgres.test.ts",
      "--maxWorkers=1", "--no-file-parallelism",
    ]);
  });
  it("fails before launching tests when the disposable database URL is absent", () => {
    const result = executeSettlementStep(undefined);
    expect(result, result.diagnostics).toMatchObject({ status: 1, args: [] });
  });
  it("keeps the existing scoped service credentials, trigger and ten-minute limit", () => {
    expect(job.needs).toBe("changes");
    expect(job.if).toBe("needs.changes.outputs.should_run == 'true'");
    expect(job["timeout-minutes"]).toBe(10);
    expect(job.services.postgres.image).toBe("public.ecr.aws/docker/library/postgres:16");
    expect(job.services.postgres.env).toEqual({ POSTGRES_USER: "matrix_test",
      POSTGRES_PASSWORD: "matrix_test", POSTGRES_DB: "matrix_test" });
    expect(job.env.MATRIX_TEST_POSTGRES_URL).toBe("postgresql://matrix_test:matrix_test@127.0.0.1:5432/matrix_test");
    expect(JSON.stringify(job.env)).not.toContain("secrets.");
  });
});
