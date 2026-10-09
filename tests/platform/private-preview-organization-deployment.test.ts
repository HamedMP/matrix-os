import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const helper = resolve("scripts/ci/platform-private-preview-env.mjs");
const workflow = readFileSync(resolve(".github/workflows/platform-cloud-run.yml"), "utf8");
const directories: string[] = [];
const organization = "org_OfflineTestFixture";
const setting = "MATRIX_INTERNAL_CLERK_ORG_ID";

function run(mode: string, value?: string, fixture: unknown = { spec: { containers: [{ env: [] }] } }, extra: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), "matrix-preview-org-"));
  directories.push(directory);
  const mock = join(directory, "gcloud");
  const calls = join(directory, "calls");
  writeFileSync(calls, "");
  writeFileSync(mock, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(process.env.MOCK_REVISION);
process.exit(Number(process.env.MOCK_STATUS || '0'));
`);
  chmodSync(mock, 0o700);
  const result = spawnSync(process.execPath, [helper, mode, "reviewed-revision"], {
    encoding: "utf8",
    env: {
      ...process.env, PATH: `${directory}:${process.env.PATH}`, GITHUB_ACTIONS: "false",
      [setting]: value, GCP_PROJECT_ID: "offline-project", GCP_REGION: "offline-region",
      MOCK_CALLS: calls, MOCK_REVISION: JSON.stringify(fixture), ...extra,
    },
  });
  return { ...result, calls: readFileSync(calls, "utf8") };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("normal Private Preview organization deployment", () => {
  it("keeps an absent variable optional with an explicit disabled diagnostic", () => {
    const validation = run("validate");
    expect(validation.status, validation.stderr).toBe(0);
    expect(validation.stderr).toContain("503");
    expect(validation.stdout).toBe("");
    expect(validation.calls).toBe("");
    expect(run("env-bindings").stdout).toBe("");
    expect(run("update-env-bindings").stdout).toBe("");
    expect(run("remove-env-bindings").stdout).toBe(`,${setting}`);
  });

  it("binds only the strictly validated existing setting and preserves both delimiters", () => {
    expect(run("env-bindings", organization).stdout).toBe(`|${setting}=${organization}`);
    expect(run("update-env-bindings", organization).stdout).toBe(`,${setting}=${organization}`);
    expect(run("remove-env-bindings", organization).stdout).toBe("");
    expect(run("validate", organization).stdout).toBe("");
  });

  it("masks configured organization identity in Actions before deployment output", () => {
    const result = run("validate", organization, undefined, { GITHUB_ACTIONS: "true" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`::add-mask::${organization}\n`);
    expect(result.stderr).not.toContain(organization);
    expect(result.calls).toBe("");
  });

  it.each(["org_", "organization_test", " org_Test", "org_Test ", "org_Test\n", "org_Test|OTHER=true", "org_Test,OTHER=true", "org_测试", "org_" + "a".repeat(125)])("rejects invalid configuration without logging or cloud calls: %j", value => {
    const result = run("env-bindings", value);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(value);
    expect(result.calls).toBe("");
  });

  it("verifies the exact configured value from the requested immutable revision", () => {
    const result = run("verify-revision", organization, { spec: { containers: [{ env: [{ name: setting, value: organization }] }] } });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.calls)).toEqual(["run", "revisions", "describe", "reviewed-revision", "--project", "offline-project", "--region", "offline-region", "--quiet", "--format=json"]);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(organization);
  });

  it.each([
    [], [{ name: setting, value: "org_WrongFixture" }],
    [{ name: setting, valueFrom: { secretKeyRef: { name: "unexpected-binding", key: "latest" } } }],
    [{ name: setting, value: organization }, { name: setting, value: organization }],
    [{ name: setting, value: organization, valueFrom: {} }],
  ])("rejects missing, changed, duplicate, or nonliteral revision bindings", entries => {
    const result = run("verify-revision", organization, { spec: { containers: [{ env: entries }] } });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(organization);
  });

  it("requires absence when unconfigured, including stale or empty bindings", () => {
    expect(run("verify-revision").status).toBe(0);
    for (const value of [organization, ""]) {
      expect(run("verify-revision", undefined, { spec: { containers: [{ env: [{ name: setting, value }] }] } }).status).not.toBe(0);
    }
  });

  it("fails closed on malformed/multi-container/cloud-error readback without echoing it", () => {
    for (const fixture of [{}, { spec: { containers: [{ env: [] }, { env: [] }] } }]) {
      expect(run("verify-revision", organization, fixture).status).not.toBe(0);
    }
    const failed = run("verify-revision", organization, { private: organization }, { MOCK_STATUS: "1" });
    expect(failed.status).not.toBe(0);
    expect(failed.stdout + failed.stderr).not.toContain(organization);
  });

  it("preserves organization and secret settings through the existing worker renderer", () => {
    const candidate = {
      metadata: { annotations: {} },
      spec: { serviceAccountName: "offline@example.invalid", containers: [{
        image: "offline/image@sha256:" + "a".repeat(64), env: [
          { name: "PLATFORM_BACKGROUND_WORKERS_ENABLED", value: "false" },
          { name: setting, value: organization },
          { name: "PLATFORM_DATABASE_URL", valueFrom: { secretKeyRef: { name: "offline-database", key: "latest" } } },
        ],
      }] },
    };
    const result = spawnSync(process.execPath, [resolve("scripts/render-platform-worker-service.mjs"), "offline-worker"], { input: JSON.stringify(candidate), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const worker = JSON.parse(result.stdout).spec.template;
    expect(worker.spec.containers[0].env).toContainEqual(candidate.spec.containers[0].env[1]);
    expect(worker.spec.containers[0].env).toContainEqual(candidate.spec.containers[0].env[2]);
    expect(run("verify-revision", organization, worker).status).toBe(0);
  });

  it.each([organization, ""])("executes production update/removal wiring without changing other flags: %j", value => {
    const parsed = parse(workflow);
    const source = parsed.jobs.deploy.steps.find((entry: { name: string }) => entry.name === "Deploy production-role revision").run as string;
    const script = source.split("production_revision=")[0];
    const env = Object.fromEntries(Object.keys(parsed.jobs.deploy.env).map(name => [name, "offline-fixture"]));
    const result = spawnSync("bash", ["-c", `
      gcloud() { printf '%s\\n' "$@"; }
      ${script}
      printf '%s\\n' "$deploy_json"
    `], { encoding: "utf8", env: { ...env, PATH: process.env.PATH, IMAGE_DIGEST: "offline/image@sha256:" + "a".repeat(64), [setting]: value } });
    expect(result.status, result.stderr).toBe(0);
    const args = result.stdout.trim().split("\n");
    const update = args[args.indexOf("--update-env-vars") + 1];
    const remove = args[args.indexOf("--remove-env-vars") + 1];
    expect(update).toContain("PLATFORM_BACKGROUND_WORKERS_ENABLED=false");
    expect(update).not.toContain("MATRIX_FUNDED");
    if (value) {
      expect(update).toContain(`,${setting}=${organization}`);
      expect(remove).not.toContain(setting);
    } else {
      expect(update).not.toContain(setting);
      expect(remove).toBe(`MATRIX_PREBILLING_PROVISIONING_MAX_HOURLY_COST_MICROS,MATRIX_PREBILLING_PROVISIONING_COSTS,${setting}`);
    }
  });

  it("wires validation, explicit candidate/production binding, and every revision readback", () => {
    expect(workflow.includes("MATRIX_INTERNAL_CLERK_ORG_ID: ${{ secrets.MATRIX_INTERNAL_CLERK_ORG_ID }}")).toBe(true);
    expect(workflow.includes("${{ vars.MATRIX_INTERNAL_CLERK_ORG_ID }}")).toBe(false);
    expect(workflow.indexOf("platform-private-preview-env.mjs validate")).toBeGreaterThan(0);
    expect(workflow.indexOf("platform-private-preview-env.mjs validate")).toBeLessThan(workflow.indexOf("- name: Deploy tagged revision"));
    expect(workflow).toContain('private_preview_env_bindings="$(node scripts/ci/platform-private-preview-env.mjs env-bindings)"');
    expect(workflow).toContain('private_preview_update_env_bindings="$(node scripts/ci/platform-private-preview-env.mjs update-env-bindings)"');
    expect(workflow).toContain('private_preview_remove_env_bindings="$(node scripts/ci/platform-private-preview-env.mjs remove-env-bindings)"');
    for (const revision of ["CANDIDATE_REVISION", "PRODUCTION_REVISION", "worker_revision"]) {
      expect(workflow).toContain(`node scripts/ci/platform-private-preview-env.mjs verify-revision "$${revision}"`);
    }
  });
});
