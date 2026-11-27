import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

// Production metal and free-tier deployment contract (spec 2691, ENG-520).
const root = process.cwd();
const script = join(root, "scripts/ci/platform-metal-env.sh");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir;
}

function selfSignedPem(): string {
  const dir = tempDir("matrix-metal-ca-");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=hostd-test-ca", "-days", "1",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
  return readFileSync(join(dir, "cert.pem"), "utf8");
}

const enabled: NodeJS.ProcessEnv = {
  METAL_HOSTS_ENABLED: "1", METAL_GOLDEN_VERSION: "0.1.32",
  MATRIX_FREE_TIER_ENABLED: "1", MATRIX_FREE_TIER_MAX_RUNTIMES: "50",
  MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD: "20000000", MATRIX_FREE_TIER_SLEEP_ENABLED: "1",
};
const accessor = "roles/secretmanager.secretAccessor";
function policy(member: string, condition?: object) {
  return { bindings: [{ role: accessor, members: [member], ...(condition ? { condition } : {}) }] };
}
const apiToken = "a".repeat(40);
const ingressToken = "b".repeat(40);

function run(mode: string, settings: NodeJS.ProcessEnv = {}, env: unknown[] = [], extra: NodeJS.ProcessEnv = {}) {
  const dir = tempDir("matrix-metal-deploy-");
  writeFileSync(join(dir, "gcloud"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('revisions') && args.includes('describe') && args.includes('run')) process.stdout.write(process.env.MOCK_REVISION);
else if (args.includes('projects') && args.includes('get-iam-policy')) process.stdout.write(process.env.MOCK_PROJECT_POLICY);
else if (args.includes('get-iam-policy')) process.stdout.write(process.env.MOCK_SECRET_POLICY);
else if (args.includes('access')) process.stdout.write(JSON.parse(process.env.MOCK_VALUES)[args[args.indexOf('--secret') + 1]] || '');
else process.stdout.write('ENABLED');
`);
  chmodSync(join(dir, "gcloud"), 0o700);
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !name.startsWith("METAL_") && !name.startsWith("MATRIX_FREE_TIER_")));
  return spawnSync("bash", [script, mode, "reviewed-revision"], {
    encoding: "utf8",
    env: {
      ...base, PATH: `${dir}:${process.env.PATH}`, GCP_PROJECT_ID: "example", GCP_REGION: "example",
      CLOUD_RUN_SERVICE_ACCOUNT: "runtime@example.com",
      MOCK_SECRET_POLICY: JSON.stringify(policy("serviceAccount:runtime@example.com")),
      MOCK_PROJECT_POLICY: JSON.stringify({ bindings: [] }),
      MOCK_REVISION: JSON.stringify({ spec: { containers: [{ env }] } }),
      MOCK_VALUES: JSON.stringify({ "metal-hostd-api-token": apiToken, "metal-hostd-ingress-token": ingressToken,
        "metal-hostd-ca-pem": extra.MOCK_CA ?? "" }),
      ...settings, ...extra,
    },
  });
}

const secretEnv = [
  { name: "METAL_HOSTD_API_TOKEN", valueFrom: { secretKeyRef: { name: "metal-hostd-api-token", key: "latest" } } },
  { name: "METAL_HOSTD_INGRESS_TOKEN", valueFrom: { secretKeyRef: { name: "metal-hostd-ingress-token", key: "latest" } } },
  { name: "METAL_HOSTD_CA_PEM", valueFrom: { secretKeyRef: { name: "metal-hostd-ca-pem", key: "latest" } } },
];
const plainEnv = [
  { name: "METAL_HOSTS_ENABLED", value: "1" }, { name: "METAL_GOLDEN_VERSION", value: "0.1.32" },
  { name: "MATRIX_FREE_TIER_ENABLED", value: "1" }, { name: "MATRIX_FREE_TIER_MAX_RUNTIMES", value: "50" },
  { name: "MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD", value: "20000000" },
  { name: "MATRIX_FREE_TIER_SLEEP_ENABLED", value: "1" },
];

describe("production metal and free-tier deployment contract", () => {
  it("defaults off: renders no metal or free-tier bindings and needs no settings", () => {
    for (const mode of ["validate", "env-bindings", "secret-bindings", "preflight-secrets"]) {
      const result = run(mode);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
    }
    expect(run("verify-revision", {}, [{ name: "PLATFORM_PORT", value: "8080" }]).status).toBe(0);
    // Settings that only matter once enabled are not checked while off.
    const ignored = { METAL_GOLDEN_VERSION: "a|b", MATRIX_FREE_TIER_MAX_RUNTIMES: "fixture" };
    expect(run("env-bindings", ignored).stdout).toBe("");
    expect(run("validate", ignored).status).toBe(0);
  });

  it("renders the enabled settings and secret-backed hostd credentials", () => {
    const env = run("env-bindings", enabled);
    expect(env.status, env.stderr).toBe(0);
    expect(env.stdout).toBe("|METAL_HOSTS_ENABLED=1|METAL_GOLDEN_VERSION=0.1.32|MATRIX_FREE_TIER_ENABLED=1"
      + "|MATRIX_FREE_TIER_MAX_RUNTIMES=50"
      + "|MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD=20000000|MATRIX_FREE_TIER_SLEEP_ENABLED=1");
    expect(env.stdout).not.toContain("TOKEN");
    const secrets = run("secret-bindings", enabled);
    expect(secrets.stdout).toBe(",METAL_HOSTD_API_TOKEN=metal-hostd-api-token:latest"
      + ",METAL_HOSTD_INGRESS_TOKEN=metal-hostd-ingress-token:latest,METAL_HOSTD_CA_PEM=metal-hostd-ca-pem:latest");
    // The CA is required whenever metal is on; pool limits and invite policy are not deploy settings.
    expect(run("secret-bindings", { ...enabled, METAL_HOSTD_CA_PEM_ENABLED: "false" }).stdout).toBe(secrets.stdout);
    const ignoredSettings = run("env-bindings", { ...enabled, METAL_POOL_MAX_DATA_PERCENT: "85",
      METAL_POOL_MAX_METADATA_PERCENT: "80", MATRIX_FREE_TIER_INVITE_REQUIRED: "false" });
    expect(ignoredSettings.stdout).toBe(env.stdout);
  });

  it("enables metal alone without the free tier", () => {
    const metalOnly = { METAL_HOSTS_ENABLED: "1", METAL_GOLDEN_VERSION: "0.1.32" };
    expect(run("env-bindings", metalOnly).stdout).toBe("|METAL_HOSTS_ENABLED=1|METAL_GOLDEN_VERSION=0.1.32");
  });

  it.each([
    [{ METAL_HOSTS_ENABLED: "yes" }],
    [{ METAL_HOSTS_ENABLED: "1" }],
    [{ METAL_HOSTS_ENABLED: "1", METAL_GOLDEN_VERSION: "0.1|INJECTED=1" }],
    [{ MATRIX_FREE_TIER_ENABLED: "1", MATRIX_FREE_TIER_MAX_RUNTIMES: "10" }],
    [{ MATRIX_FREE_TIER_SLEEP_ENABLED: "1" }],
    [{ ...enabled, MATRIX_FREE_TIER_MAX_RUNTIMES: "" }],
    [{ ...enabled, MATRIX_FREE_TIER_MAX_RUNTIMES: "0" }],
    [{ ...enabled, MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD: "-5" }],
  ])("fails closed on invalid settings %j", (settings) => {
    for (const mode of ["validate", "env-bindings"]) {
      const result = run(mode, settings);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  it("preflights hostd credentials and runtime access without printing them", () => {
    const pem = selfSignedPem();
    const good = run("preflight-secrets", enabled, [], { MOCK_CA: pem });
    expect(good.status, good.stderr).toBe(0);
    expect(good.stdout + good.stderr).not.toContain(apiToken);
    expect(run("preflight-secrets", enabled, [], { MOCK_CA: "not-a-certificate" }).status).not.toBe(0);
    const shortToken = run("preflight-secrets", enabled, [], {
      MOCK_CA: pem, MOCK_VALUES: JSON.stringify({ "metal-hostd-api-token": "private-short", "metal-hostd-ingress-token": ingressToken,
        "metal-hostd-ca-pem": pem }),
    });
    expect(shortToken.status).not.toBe(0);
    expect(shortToken.stdout + shortToken.stderr).not.toContain("private-short");
    const trailingNewline = run("preflight-secrets", enabled, [], {
      MOCK_VALUES: JSON.stringify({ "metal-hostd-api-token": `${apiToken}\n`, "metal-hostd-ingress-token": ingressToken,
        "metal-hostd-ca-pem": pem }),
    });
    expect(trailingNewline.status).not.toBe(0);
    expect(run("preflight-secrets", enabled).status).not.toBe(0);
  });

  it("accepts a direct or unconditional project grant and rejects conditional or missing access", () => {
    const pem = selfSignedPem();
    const member = "serviceAccount:runtime@example.com";
    const none = JSON.stringify({ bindings: [] });
    const condition = { title: "expires", expression: "request.time < timestamp('2030-01-01T00:00:00Z')" };
    const preflight = (secretPolicy: string, projectPolicy: string) =>
      run("preflight-secrets", enabled, [], { MOCK_CA: pem, MOCK_SECRET_POLICY: secretPolicy, MOCK_PROJECT_POLICY: projectPolicy });
    const direct = preflight(JSON.stringify(policy(member)), none);
    expect(direct.status, direct.stderr).toBe(0);
    const project = preflight(none, JSON.stringify(policy(member)));
    expect(project.status, project.stderr).toBe(0);
    expect(preflight(none, JSON.stringify(policy(member, condition))).status).not.toBe(0);
    expect(preflight(JSON.stringify(policy(member, condition)), none).status).not.toBe(0);
    expect(preflight(none, none).status).not.toBe(0);
    expect(preflight(JSON.stringify(policy("serviceAccount:other@example.com")), none).status).not.toBe(0);
    expect(preflight("not-json", none).status).not.toBe(0);
  });

  it("rejects missing, plaintext, stale, or leftover bindings on a deployed revision", () => {
    expect(run("verify-revision", enabled, [...plainEnv, ...secretEnv]).status).toBe(0);
    expect(run("verify-revision", enabled, [...plainEnv, ...secretEnv.slice(1)]).status).not.toBe(0);
    expect(run("verify-revision", enabled, [...plainEnv, ...secretEnv.slice(1),
      { name: "METAL_HOSTD_API_TOKEN", value: apiToken }]).status).not.toBe(0);
    expect(run("verify-revision", { ...enabled, MATRIX_FREE_TIER_MAX_RUNTIMES: "60" }, [...plainEnv, ...secretEnv]).status).not.toBe(0);
    // A disabled deployment must not keep any metal or free-tier setting from an earlier revision.
    expect(run("verify-revision", {}, plainEnv.slice(0, 1)).status).not.toBe(0);
    expect(run("verify-revision", {}, secretEnv.slice(0, 1)).status).not.toBe(0);
  });

  it("is wired into the full deploy, every verified revision, and the inherited worker", () => {
    const workflow = readFileSync(join(root, ".github/workflows/platform-cloud-run.yml"), "utf8");
    for (const line of [
      "METAL_HOSTS_ENABLED: ${{ vars.METAL_HOSTS_ENABLED || '0' }}",
      "MATRIX_FREE_TIER_ENABLED: ${{ vars.MATRIX_FREE_TIER_ENABLED || '0' }}",
      "MATRIX_FREE_TIER_SLEEP_ENABLED: ${{ vars.MATRIX_FREE_TIER_SLEEP_ENABLED || '0' }}",
      "scripts/ci/platform-metal-env.sh validate",
      "scripts/ci/platform-metal-env.sh preflight-secrets",
      'metal_env_bindings="$(scripts/ci/platform-metal-env.sh env-bindings)"',
      'metal_secret_bindings="$(scripts/ci/platform-metal-env.sh secret-bindings)"',
      "${google_env_bindings}${metal_env_bindings}\"",
      "${sites_secret_bindings}${metal_secret_bindings}\"",
      "- \"scripts/ci/platform-metal-env.sh\"",
    ]) expect(workflow).toContain(line);
    for (const removed of ["MATRIX_FREE_TIER_INVITE_REQUIRED", "METAL_POOL_MAX_", "METAL_HOSTD_CA_PEM_ENABLED"]) {
      expect(workflow).not.toContain(removed);
    }
    for (const revision of ["CANDIDATE_REVISION", "PRODUCTION_REVISION", "worker_revision"]) {
      expect(workflow).toContain(`scripts/ci/platform-metal-env.sh verify-revision "$${revision}"`);
    }
    // The production-role fast path merges onto the candidate template; it must never set or drop metal settings.
    const fastPath = workflow.split("- name: Deploy production-role revision")[1].split("- name:")[0];
    expect(fastPath).not.toMatch(/METAL_|MATRIX_FREE_TIER_/);
  });
});
