import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const names = ["APP_ID", "CLIENT_ID", "CLIENT_SECRET", "SIGNING_SECRET", "TOKEN_ENCRYPTION_KEY", "PUBLIC_BASE_URL"];
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function run(mode: string, enabled = "false", env: unknown[] = [], extra: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "matrix-slack-deploy-")); dirs.push(dir);
  writeFileSync(join(dir, "gcloud"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('revisions')) process.stdout.write(process.env.MOCK_REVISION);
else if (args.includes('get-iam-policy')) process.stdout.write(process.env.MOCK_ACCESSOR);
else if (args.includes('access')) process.stdout.write(JSON.parse(process.env.MOCK_VALUES)[args[args.indexOf('--secret') + 1]] || '');
else process.stdout.write('ENABLED');
`);
  chmodSync(join(dir, "gcloud"), 0o700);
  return spawnSync("bash", [join(root, "scripts/ci/platform-slack-env.sh"), mode, "reviewed-revision"], {
    encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SLACK_ENABLED: enabled,
      SLACK_TOKEN_ENCRYPTION_KEY_VERSION: "1", GCP_PROJECT_ID: "example", GCP_REGION: "example",
      MOCK_REVISION: JSON.stringify({ spec: { containers: [{ env }] } }),
      CLOUD_RUN_SERVICE_ACCOUNT: "runtime@example.com", MOCK_ACCESSOR: "serviceAccount:runtime@example.com",
      MOCK_VALUES: JSON.stringify({ "slack-app-id": "A123", "slack-client-id": "123.456",
        "slack-client-secret": "test-client-secret-123", "slack-signing-secret": "test-signing-secret-123",
        "slack-token-encryption-key": Buffer.alloc(32, 1).toString("base64"), "slack-public-base-url": "https://app.example.com" }),
      ...extra,
    },
  });
}
describe("native Slack deployment contract", () => {
  it("defaults off and requires explicit opt-in", () => {
    expect(run("secret-bindings").stdout).toBe("");
    expect(run("validate", "yes").status).not.toBe(0);
    expect(run("validate", "true").status).toBe(0);
  });
  it("keeps credentials secret-backed and pins the token encryption key", () => {
    const result = run("secret-bindings", "true");
    expect(result.status, result.stderr).toBe(0);
    for (const name of names) expect(result.stdout).toContain(`SLACK_${name}=slack-${name.toLowerCase().replaceAll("_", "-")}:${name === "TOKEN_ENCRYPTION_KEY" ? "1" : "latest"}`);
    expect(run("validate", "true", [], { SLACK_TOKEN_ENCRYPTION_KEY_VERSION: "latest" }).status).not.toBe(0);
  });
  it("preflights private credential values and runtime access without printing credentials", () => {
    const good = run("preflight-secrets", "true");
    expect(good.status, good.stderr).toBe(0);
    expect(good.stdout + good.stderr).not.toContain("test-client-secret");
    expect(run("preflight-secrets", "true", [], { MOCK_ACCESSOR: "serviceAccount:other@example.com" }).status).not.toBe(0);
    const invalid = run("preflight-secrets", "true", [], { MOCK_VALUES: JSON.stringify({ "slack-app-id": "private-invalid" }) });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout + invalid.stderr).not.toContain("private-invalid");
  });
  it("rejects partial, plaintext, or wrong secret bindings before promotion", () => {
    const env = names.map(name => ({ name: `SLACK_${name}`, valueFrom: { secretKeyRef: {
      name: `slack-${name.toLowerCase().replaceAll("_", "-")}`, key: name === "TOKEN_ENCRYPTION_KEY" ? "1" : "latest",
    } } }));
    expect(run("verify-revision", "true", env).status).toBe(0);
    expect(run("verify-revision", "true", env.slice(1)).status).not.toBe(0);
    expect(run("verify-revision", "true", [...env.slice(1), { name: "SLACK_APP_ID", value: "A123" }]).status).not.toBe(0);
    expect(run("verify-revision", "false", env).status).not.toBe(0);
    expect(run("verify-revision", "false").status).toBe(0);
  });
  it("verifies both serving revisions and the inherited private worker configuration", () => {
    const workflow = readFileSync(join(root, ".github/workflows/platform-cloud-run.yml"), "utf8");
    expect(workflow).toContain("SLACK_ENABLED: ${{ vars.SLACK_ENABLED || 'false' }}");
    expect(workflow).toContain("scripts/ci/platform-slack-env.sh preflight-secrets");
    expect(workflow).toContain('${whatsapp_secret_bindings}${slack_secret_bindings}');
    for (const revision of ["CANDIDATE_REVISION", "PRODUCTION_REVISION", "worker_revision"]) {
      expect(workflow).toContain(`scripts/ci/platform-slack-env.sh verify-revision "$${revision}"`);
    }
  });
});
