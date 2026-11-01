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
    const bun = join(directory, "bun");
    // Fail safely if a workflow regresses to the old prerequisite wrapper.
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
      "tests/gateway/bots/instantiation.test.ts", "tests/gateway/bots/matrix-bot-personality.test.ts",
      "tests/gateway/bots/funded-inference-timeout.test.ts",
      "tests/platform/canonical-phase-catalog-readiness.test.ts",
      "tests/platform/canonical-funding-expiry-projection.test.ts",
      "tests/gateway/canonical-phase-discovery.test.ts",
      "tests/platform/canonical-phase-postgres-cleanup.test.ts",
      "tests/gateway/company-brain-owner-data.test.ts",
      "--maxWorkers=1", "--no-file-parallelism",
    ]);
    const absentUrl = executeSettlementStep(undefined, step);
    expect(absentUrl, absentUrl.diagnostics).toMatchObject({ status: 1, args: [] });
  });
  it("executes isolated pre-send races under the disposable PostgreSQL environment", () => {
    const step = job.steps.find(candidate => candidate.run?.includes("tests/gateway/bots/integration-grant-source-postgres.test.ts"))!;
    const result = executeSettlementStep(job.env.MATRIX_TEST_POSTGRES_URL, step);
    expect(result.status, result.diagnostics).toBe(0);
    expect(result.args).toEqual([
      "exec", "vitest", "run", "tests/gateway/bots/integration-grant-source-postgres.test.ts",
      "tests/gateway/bots/instantiation.test.ts", "tests/gateway/bots/matrix-bot-personality.test.ts",
      "tests/gateway/bots/funded-inference-timeout.test.ts",
      "tests/platform/canonical-phase-catalog-readiness.test.ts",
      "tests/platform/canonical-funding-expiry-projection.test.ts",
      "tests/gateway/canonical-phase-discovery.test.ts",
      "tests/platform/canonical-phase-postgres-cleanup.test.ts",
      "tests/gateway/company-brain-owner-data.test.ts",
      "--maxWorkers=1", "--no-file-parallelism",
    ]);
    const absentUrl = executeSettlementStep(undefined, step);
    expect(absentUrl, absentUrl.diagnostics).toMatchObject({ status: 1, args: [] });
  });
  it("executes waiver and private CLI regressions under the disposable PostgreSQL job", () => {
    const result = executeSettlementStep(job.env.MATRIX_TEST_POSTGRES_URL);
    expect(result.status, result.diagnostics).toBe(0);
    expect(result.args).toEqual([
      "exec", "vitest", "run", "tests/platform/ai-funded-usage-postgres.test.ts",
      "tests/platform/ai-funded-model-probes-postgres.test.ts",
      "tests/platform/ai-funded-recovery-migration.test.ts",
      "tests/platform/ai-funded-terminal-concurrency.test.ts",
      "tests/platform/ai-funded-usage-waiver.test.ts", "tests/platform/ai-funded-usage-waiver-cli.test.ts",
      "tests/platform/ai-funded-usage-waiver-locks-postgres.test.ts",
      "--maxWorkers=1", "--no-file-parallelism",
    ]);
  });
  it("fails before launching tests when the disposable database URL is absent", () => {
    const result = executeSettlementStep(undefined);
    expect(result, result.diagnostics).toMatchObject({ status: 1, args: [] });
  });
  it("prepares prerequisites once before every PostgreSQL lane and stops at a missing database URL", () => {
    const selected = job.steps.filter(step => step.name === "Build test prerequisites once"
      || step.run?.includes("pnpm exec vitest run"));
    const directory = mkdtempSync(join(tmpdir(), "matrix-funded-pg-order-"));
    try {
      const log = join(directory, "commands");
      for (const name of ["bun", "pnpm"]) {
        const executable = join(directory, name);
        writeFileSync(executable, `#!/usr/bin/env bash
printf '%s' '${name}' >> "$WAIVER_CI_COMMANDS_PATH"
printf ' %s' "$@" >> "$WAIVER_CI_COMMANDS_PATH"
printf '\\n' >> "$WAIVER_CI_COMMANDS_PATH"
`);
        chmodSync(executable, 0o700);
      }
      const execute = (url: string | undefined, processBuild = true) => {
        writeFileSync(log, "");
        const result = spawnSync("bash", ["-eu", "-c", selected.map(step => step.run).join("\n")], {
          encoding: "utf8", timeout: 5_000,
          env: { PATH: `${directory}:${process.env.PATH}`, MATRIX_TEST_POSTGRES_URL: url,
            WAIVER_CI_COMMANDS_PATH: log, MATRIX_ROUTINE_PROCESS_BUILD: processBuild ? join(directory, "fixture-process-build") : undefined },
        });
        return { ...result, commands: readFileSync(log, "utf8").trim().split("\n") };
      };
      const valid = execute(job.env.MATRIX_TEST_POSTGRES_URL);
      expect(valid.status, valid.stderr).toBe(0);
      expect(valid.commands.filter(command => command === "bun run test:prepare")).toHaveLength(1);
      expect(new Set(valid.commands).size).toBe(valid.commands.length);
      expect(valid.commands[0]).toBe("bun run test:prepare");
      expect(valid.commands.slice(1).every(command => command.startsWith("pnpm exec vitest run "))).toBe(true);
      expect(valid.commands[1]).toContain("tests/platform/ai-funded-model-probes-postgres.test.ts");
      expect(valid.commands[2]).toContain("tests/platform/customer-funded-paid-recovery-postgres.test.ts");
      expect(valid.commands[3]).toContain("tests/platform/account-deletion-");
      expect(valid.commands[4]).toContain("tests/gateway/bots/funded-inference-timeout.test.ts");
      expect(valid.commands[5]).toContain("tests/platform/preview-drive-postgres-concurrency.test.ts");
      expect(valid.commands[6]).toContain("tests/gateway/browser-approval-repository.test.ts");
      for (const suite of ["deployed-v9-schema-postgres", "routine-fencing-postgres", "routine-process-postgres"]) {
        expect(valid.commands.some(command => command.includes(`tests/gateway/bots/${suite}.test.ts`))).toBe(true);
      }
      const noBuild = execute(job.env.MATRIX_TEST_POSTGRES_URL, false);
      expect(noBuild.status).toBe(1);
      expect(noBuild.stderr).toContain("Exact-source process artifact required");
      expect(noBuild.commands.some(command => command.includes("routine-process-postgres.test.ts"))).toBe(false);
      const absent = execute(undefined);
      expect(absent.status).toBe(1);
      expect(absent.stderr).toContain("Disposable PostgreSQL test URL required");
      expect(absent.commands).toEqual(["bun run test:prepare"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("keeps scoped service credentials and trigger with a measured bounded PG qualification window", () => {
    expect(job.needs).toBe("changes");
    expect(job.if).toBe("always() && !cancelled() && needs.changes.result == 'success' && (needs.changes.outputs.should_run == 'true')");
    expect(job["timeout-minutes"]).toBe(14);
    expect(job.services.postgres.image).toBe("mirror.gcr.io/library/postgres:16");
    expect(job.services.postgres.env).toEqual({ POSTGRES_USER: "matrix_test",
      POSTGRES_PASSWORD: "matrix_test", POSTGRES_DB: "matrix_test" });
    expect(job.env.MATRIX_TEST_POSTGRES_URL).toBe("postgresql://matrix_test:matrix_test@127.0.0.1:5432/matrix_test");
    expect(JSON.stringify(job.env)).not.toContain("secrets.");
  });
});
