import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const script = join(process.cwd(), "scripts/require-existing-preview-service.sh");
const workflow = parse(readFileSync(".github/workflows/preview-platform.yml", "utf8"));
const steps = workflow.jobs.preview.steps as Array<{ name?: string; uses?: string; run?: string; if?: string }>;

function execute(metadata: unknown, exitCode = 0, configured = true, deploy = false) {
  const directory = mkdtempSync(join(tmpdir(), "matrix-preview-service-"));
  try {
    const args = join(directory, "args");
    const gcloud = join(directory, "gcloud");
    writeFileSync(gcloud, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" >> "$GUARD_ARGS"\nif [ "$1 $2" = "run deploy" ]; then exit 1; fi\nprintf "%s" "$GUARD_METADATA"\nexit "$GUARD_EXIT"\n');
    chmodSync(gcloud, 0o700);
    const date = join(directory, "date");
    writeFileSync(date, '#!/usr/bin/env bash\nprintf "2030-01-01T00:00:00.000Z\\n"\n');
    chmodSync(date, 0o700);
    const command = deploy ? ["-eu", "-c", steps.find(step => step.name === "Deploy zero-traffic tagged revision to preview service")!.run!] : [script];
    // Ignore host startup files while preserving the workflow's strict -eu body.
    const result = spawnSync("bash", ["--noprofile", "--norc", ...command], {
      encoding: "utf8", timeout: 5_000,
      env: { PATH: `${directory}:${process.env.PATH}`, GUARD_ARGS: args,
        GUARD_METADATA: JSON.stringify(metadata), GUARD_EXIT: String(exitCode),
        GCP_PROJECT_ID: "test-project", GCP_REGION: "test-region",
        REQUIRE_EXISTING_SERVICE: "true", MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "false",
        MATRIX_FUNDED_AI_RUNTIME_ENABLED: "false", MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "test-key",
        CUSTOM_MCP_ENABLED: "false", IMAGE: "synthetic-image:test", PR_NUMBER: "2450",
        CLOUD_RUN_SERVICE_ACCOUNT: "synthetic-runner@example.test",
        MATRIX_CARD_TRIALS_ENABLED: "true", MATRIX_CARD_TRIAL_DAYS: "3",
        CLOUD_RUN_PREVIEW_SERVICE: configured ? "matrix-platform-preview" : undefined },
    });
    return { status: result.status, stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      args: existsSync(args) ? readFileSync(args, "utf8").trim().split("\n") : [] };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const valid = { metadata: { name: "matrix-platform-preview" },
  status: { url: "https://matrix-platform-preview-example.a.run.app" } };

describe("existing Preview service guard", () => {
  it("reads only configured service metadata and returns its validated HTTPS origin", () => {
    const result = execute(valid);
    expect(result).toEqual({ status: 0, stdout: valid.status.url, stderr: "", args: [
      "run", "services", "describe", "matrix-platform-preview", "--project", "test-project",
      "--region", "test-region", "--format=json(metadata.name,status.url)", "--quiet",
    ] });
  });
  it.each([
    [{}, 0], [valid, 1], [{ ...valid, metadata: { name: "production" } }, 0],
    [{ ...valid, status: { url: "http://matrix-platform-preview-example.a.run.app" } }, 0],
    [{ ...valid, status: { url: `${valid.status.url}/path` } }, 0],
    [{ ...valid, status: { url: "https://app.matrix-os.com" } }, 0],
  ])("fails closed for missing, failed or invalid metadata (%j, %i)", (metadata, exitCode) => {
    expect(execute(metadata, exitCode)).toMatchObject({ status: 1, stdout: "" });
  });
  it("does not run gcloud when the configured service is absent", () => {
    expect(execute(valid, 0, false)).toMatchObject({ status: 1, stdout: "", args: [] });
  });
  it.each([0, 1])("refuses deploy and bootstrap after a fresh unavailable service read (%i)", exitCode => {
    const result = execute({}, exitCode, true, true);
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(result.args.slice(0, 3)).toEqual(["run", "services", "describe"]);
    expect(result.args).not.toContain("deploy");
    expect(result.stderr).toMatch(/Existing preview service (could not be verified|metadata is invalid)/);
  });
  it("reaches the stubbed deployment with valid metadata and complete deployment configuration", () => {
    const result = execute(valid, 0, true, true);
    expect(result.args).toContain("deploy");
    expect(result.args).toContain("--no-traffic");
    expect(result.stderr).not.toContain("unbound variable");
    expect(result.stderr).not.toContain("Existing preview service");
  });
  it("fails configuration before disabling the guarded workflow on an absent service", () => {
    const check = steps.find(step => step.name === "Check preview configuration")!.run!;
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eu", "-c", check], {
      encoding: "utf8", timeout: 5_000,
      env: { PATH: process.env.PATH, REQUIRE_EXISTING_SERVICE: "true" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("An existing preview service must be configured");
    expect(result.stdout).not.toContain("configured=false");
  });
  it("keeps opt-in off and checks after OIDC before builds, and again before bootstrap", () => {
    expect(workflow.on.workflow_dispatch.inputs.require_existing_service).toMatchObject({ type: "boolean", default: false });
    expect(workflow.jobs.preview.env.REQUIRE_EXISTING_SERVICE)
      .toBe("${{ inputs.require_existing_service && 'true' || 'false' }}");
    const guardIndex = steps.findIndex(step => step.name === "Require existing preview service");
    expect(guardIndex).toBeGreaterThan(steps.findIndex(step => step.uses === "google-github-actions/auth@v3"));
    expect(guardIndex).toBeLessThan(steps.findIndex(step => step.name === "Build platform image"));
    expect(steps[guardIndex]).toMatchObject({
      if: "steps.config.outputs.configured == 'true' && env.REQUIRE_EXISTING_SERVICE == 'true'",
      run: expect.stringContaining("bash scripts/require-existing-preview-service.sh"),
    });
    const deploy = steps.find(step => step.name === "Deploy zero-traffic tagged revision to preview service")!.run!;
    expect(deploy).toMatch(/if \[ "\$\{REQUIRE_EXISTING_SERVICE:-false\}" = "true" \]; then\n\s+service_base_url="\$\(bash scripts\/require-existing-preview-service\.sh\)"/);
    expect(deploy.indexOf("bash scripts/require-existing-preview-service.sh"))
      .toBeLessThan(deploy.indexOf('deploy_preview "$BOOTSTRAP_API_ORIGIN"'));
    expect(deploy).toContain("--no-traffic");
  });
});
