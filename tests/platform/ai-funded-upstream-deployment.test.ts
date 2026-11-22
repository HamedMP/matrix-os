import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

type Step = { name?: string; run?: string };
type Job = { env: Record<string, string>; steps: Step[] };

const production = YAML.parse(readFileSync(".github/workflows/platform-cloud-run.yml", "utf8"))
  .jobs.deploy as Job;
const preview = YAML.parse(readFileSync(".github/workflows/preview-platform.yml", "utf8"))
  .jobs.preview as Job;
const helper = readFileSync("scripts/ci/platform-funded-upstream-env.sh", "utf8");

function deployment(job: Job): string {
  const name = job === preview
    ? "Deploy zero-traffic tagged revision to preview service"
    : "Deploy tagged revision";
  const script = job.steps.find((step) => step.name === name)?.run;
  expect(script, name).toBeTypeOf("string");
  return script!;
}

function step(job: Job, name: string): string {
  const script = job.steps.find((candidate) => candidate.name === name)?.run;
  expect(script, name).toBeTypeOf("string");
  return script!;
}

describe("funded upstream preference deployment", () => {
  it.each([
    ["production", production],
    ["Preview", preview],
  ])("keeps the %s cohort disabled unless its bounded environment configuration is explicit", (_name, job) => {
    expect(job.env.AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED)
      .toBe("${{ vars.AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED || 'false' }}");
    expect(job.env.AI_FUNDED_BEDROCK_MODEL_IDS)
      .toBe("${{ vars.AI_FUNDED_BEDROCK_MODEL_IDS }}");
    expect(job.env.AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH)
      .toBe("${{ vars.AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH }}");

    const script = deployment(job);
    const target = job === preview ? "preview" : "production";
    expect(script).toContain(`scripts/ci/platform-funded-upstream-env.sh env-bindings ${target}`);
    expect(script).toContain(`scripts/ci/platform-funded-upstream-env.sh secret-bindings ${target}`);
  });

  it("keeps owner IDs and selection proofs in environment-specific Secret Manager bindings", () => {
    expect(helper).toContain('if [[ "$target" == "preview" ]]; then suffix="-preview"; fi');
    expect(helper).toContain("AI_FUNDED_UPSTREAM_PREFERENCE_OWNER_IDS=ai-funded-upstream-preference-owner-ids%s:latest");
    expect(helper).toContain("AI_FUNDED_UPSTREAM_SELECTION_SECRET=ai-funded-upstream-selection-secret%s:latest");
    expect(helper).not.toMatch(/display.?name|x-forwarded|caller.?header/i);
  });

  it("fails deployment unless candidate revisions contain the exact bounded contract", () => {
    expect(step(production, "Verify deployed provisioning contract")).toContain(
      "platform-funded-upstream-env.sh verify-revision production",
    );
    expect(step(production, "Verify production provisioning contract")).toContain(
      "platform-funded-upstream-env.sh verify-revision production",
    );
    expect(deployment(preview)).toContain(
      "platform-funded-upstream-env.sh verify-revision preview",
    );
  });

  it("emits only bounded canonical configuration and separate Preview secret names", () => {
    const validThrough = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const environment = {
      PATH: process.env.PATH,
      MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "true",
      AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED: "true",
      AI_FUNDED_BEDROCK_MODEL_IDS: '["claude-sonnet-5"]',
      AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH: validThrough,
    };
    const run = (mode: string, target: string, extra: Record<string, string> = {}) =>
      spawnSync("bash", ["scripts/ci/platform-funded-upstream-env.sh", mode, target], {
        encoding: "utf8", timeout: 5_000, env: { ...environment, ...extra },
      });

    const bindings = run("env-bindings", "preview");
    expect(bindings.status, bindings.stderr).toBe(0);
    expect(bindings.stdout.split("|")).toEqual([
      "",
      "AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED=true",
      'AI_FUNDED_BEDROCK_MODEL_IDS=["claude-sonnet-5"]',
      `AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH=${validThrough}`,
    ]);
    expect(run("secret-bindings", "preview").stdout).toContain(
      "AI_FUNDED_UPSTREAM_PREFERENCE_OWNER_IDS=ai-funded-upstream-preference-owner-ids-preview:latest",
    );
    expect(run("secret-bindings", "production").stdout).toContain(
      "AI_FUNDED_UPSTREAM_SELECTION_SECRET=ai-funded-upstream-selection-secret:latest",
    );

    expect(run("env-bindings", "preview", { AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED: "false" }).stdout)
      .toBe("|AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED=false");
    expect(run("secret-bindings", "preview", { AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED: "false" }).stdout)
      .toBe("");

    const enabledRevision = JSON.stringify({
      spec: { containers: [{ env: [
        { name: "AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED", value: "true" },
        { name: "AI_FUNDED_BEDROCK_MODEL_IDS", value: '["claude-sonnet-5"]' },
        { name: "AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH", value: validThrough },
        { name: "AI_FUNDED_UPSTREAM_PREFERENCE_OWNER_IDS", valueFrom: { secretKeyRef: { name: "ai-funded-upstream-preference-owner-ids-preview", key: "latest" } } },
        { name: "AI_FUNDED_UPSTREAM_SELECTION_SECRET", valueFrom: { secretKeyRef: { name: "ai-funded-upstream-selection-secret-preview", key: "latest" } } },
      ] }] },
    });
    const verify = (target: string, revision: string, extra: Record<string, string> = {}) => spawnSync(
      "bash",
      ["-c", 'printf "%s" "$REVISION_JSON" | scripts/ci/platform-funded-upstream-env.sh verify-revision "$TARGET"'],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...environment, ...extra, REVISION_JSON: revision, TARGET: target },
      },
    );
    const verified = verify("preview", enabledRevision);
    expect(verified.status, verified.stderr).toBe(0);

    const wrongSecret = enabledRevision.replace(
      "ai-funded-upstream-selection-secret-preview",
      "ai-funded-upstream-selection-secret",
    );
    expect(verify("preview", wrongSecret).status).not.toBe(0);

    const disabledEnvironment = { ...environment, AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED: "false" };
    const disabledRevision = JSON.stringify({ spec: { containers: [{ env: [
      { name: "AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED", value: "false" },
    ] }] } });
    expect(verify("production", disabledRevision, disabledEnvironment).status).toBe(0);
    expect(verify("production", enabledRevision, disabledEnvironment).status).not.toBe(0);
  });

  it.each([
    ["invalid flag", { AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED: "yes" }],
    ["disabled control plane", { MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "false" }],
    ["empty models", { AI_FUNDED_BEDROCK_MODEL_IDS: "[]" }],
    ["duplicate models", { AI_FUNDED_BEDROCK_MODEL_IDS: '["claude-sonnet-5","claude-sonnet-5"]' }],
    ["delimiter injection", { AI_FUNDED_BEDROCK_MODEL_IDS: '["claude|sonnet"]' }],
    ["expired window", { AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH: "2026-01-01T00:00:00.000Z" }],
    ["oversized window", { AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH: new Date(Date.now() + 31 * 24 * 60 * 60_000).toISOString() }],
  ])("rejects %s before deployment", (_name, extra) => {
    const result = spawnSync("bash", ["scripts/ci/platform-funded-upstream-env.sh", "env-bindings", "preview"], {
      encoding: "utf8", timeout: 5_000, env: {
        PATH: process.env.PATH,
        MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "true",
        AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED: "true",
        AI_FUNDED_BEDROCK_MODEL_IDS: '["claude-sonnet-5"]',
        AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        ...extra,
      },
    });
    expect(result.status).not.toBe(0);
  });
});
