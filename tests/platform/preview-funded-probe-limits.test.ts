import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { loadFundedModelProbeLimits } from "../../packages/platform/src/ai-funded-model-probes.js";

const job = YAML.parse(readFileSync(".github/workflows/preview-platform.yml", "utf8")).jobs.preview;
const validation = job.steps.find((step: { name?: string }) => step.name === "Check preview configuration").run;
const deployment = job.steps.find((step: { name?: string }) => step.name === "Deploy zero-traffic tagged revision to preview service").run;
const daily = "MATRIX_FUNDED_AI_MODEL_PROBE_DAILY_LIMIT";
const minute = "MATRIX_FUNDED_AI_MODEL_PROBE_MINUTE_LIMIT";

function environment(enabled: boolean, limits: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH,
    GITHUB_OUTPUT: "/dev/null",
    CLOUD_RUN_PREVIEW_SERVICE: "matrix-platform-preview",
    CLOUD_RUN_SERVICE_ACCOUNT: "synthetic-preview-runner",
    MATRIX_CARD_TRIALS_ENABLED: "false", MATRIX_CARD_TRIAL_DAYS: "3",
    MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: String(enabled),
    MATRIX_FUNDED_AI_RUNTIME_ENABLED: String(enabled),
    MATRIX_FUNDED_AI_RELAY_URL: "https://synthetic-relay.example.test",
    ...limits,
  };
}
function validate(enabled: boolean, limits?: Record<string, string>) {
  return spawnSync("bash", ["-euc", validation], { env: environment(enabled, limits), encoding: "utf8", timeout: 5_000 });
}

function deployedArguments(enabled: boolean, limits: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "preview-funded-limits-"));
  const capture = join(directory, "arguments");
  try {
    // Execute the workflow's actual setup and deploy function. The stub captures
    // the external command; no Cloud Run, credentials, network or DB is used.
    const functionEnd = deployment.indexOf("\nservice_base_url=");
    expect(functionEnd).toBeGreaterThan(0);
    const script = `gcloud() { printf '%s\\0' "$@" > "$CAPTURE"; }\ndate() { printf '%s\\n' '2026-09-28T00:00:00.000Z'; }\n${deployment.slice(0, functionEnd)}\ndeploy_preview https://synthetic-preview.example.test`;
    const result = spawnSync("bash", ["-euc", script], { encoding: "utf8", timeout: 5_000, env: {
      ...environment(enabled, limits), CAPTURE: capture, CUSTOM_MCP_ENABLED: "false",
      GCP_PROJECT_ID: "synthetic-project", GCP_REGION: "synthetic-region", PR_NUMBER: "1947",
      IMAGE: "synthetic-image:603751f4885c", PREVIEW_PUBLIC_URL: "https://preview.example.test",
    } });
    expect(result.status, result.stderr).toBe(0);
    const args = readFileSync(capture, "utf8").split("\0");
    expect(args).toContain("--no-traffic");
    return args[args.indexOf("--set-env-vars") + 1];
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("preview funded readiness probe budgets", () => {
  it("sources explicit Preview environment limits with disabled zero defaults", () => {
    expect(job.environment).toBe("Preview");
    expect(job.env[daily]).toBe("${{ vars.MATRIX_FUNDED_AI_MODEL_PROBE_DAILY_LIMIT || '0' }}");
    expect(job.env[minute]).toBe("${{ vars.MATRIX_FUNDED_AI_MODEL_PROBE_MINUTE_LIMIT || '0' }}");
    expect(validate(false, { [daily]: "0", [minute]: "0" }).status).toBe(0);
    const bindings = deployedArguments(false, { [daily]: "0", [minute]: "0" });
    expect(bindings).toContain("MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED=false");
    expect(bindings).toContain("MATRIX_FUNDED_AI_RUNTIME_ENABLED=false");
    expect(bindings).not.toContain(`${daily}=`);
    expect(bindings).not.toContain(`${minute}=`);
    expect(loadFundedModelProbeLimits(Object.fromEntries(bindings.split("|").map(binding => binding.split("="))))).toBeUndefined();
  });

  it.each([
    {}, { [daily]: "1" }, { [minute]: "1" },
    { [daily]: "0", [minute]: "0" }, { [daily]: "-1", [minute]: "1" },
    { [daily]: "1.5", [minute]: "1" }, { [daily]: "10001", [minute]: "1" },
    { [daily]: "1000", [minute]: "101" }, { [daily]: "1", [minute]: "2" },
    { [daily]: "99999999999999999999999", [minute]: "1" },
  ])("rejects enabled unsupported quotas %j before deployment", (limits) => {
    const result = validate(true, limits);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/probe|PROBE/);
  });

  it.each([["1", "1"], ["37", "4"], ["10000", "100"]])(
    "accepts and forwards explicit daily %s / minute %s without widening them", (dayLimit, minuteLimit) => {
      const limits = { [daily]: dayLimit, [minute]: minuteLimit };
      const checked = validate(true, limits);
      expect(checked.status, checked.stderr).toBe(0);
      const bindings = deployedArguments(true, limits);
      expect(bindings.split("|")).toContain(`${daily}=${dayLimit}`);
      expect(bindings.split("|")).toContain(`${minute}=${minuteLimit}`);
      expect(loadFundedModelProbeLimits(Object.fromEntries(bindings.split("|").map(binding => binding.split("=")))))
        .toEqual({ dailyLimit: Number(dayLimit), minuteLimit: Number(minuteLimit) });
    },
  );
});
