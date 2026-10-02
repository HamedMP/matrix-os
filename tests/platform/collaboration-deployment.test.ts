import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(resolve(".github/workflows/platform-cloud-run.yml"), "utf8");

// Must accept exactly what the platform's decodeSigningSecret accepts (webhook-signature.ts):
// the whole value is `whsec_` + base64, and the key decodes to at least 16 bytes.
const WEBHOOK_SECRET_FILTER =
  'test("\\\\Awhsec_[A-Za-z0-9+/=]{16,}\\\\z") and ((((ltrimstr("whsec_") | gsub("="; "") | length) * 3 / 4) | floor) >= 16)';

// The workflow itself runs this filter with jq, which GitHub runners ship. Locally jq is not a
// declared prerequisite, so the filter test is skipped there rather than failing with ENOENT --
// but never in CI, where a missing jq must fail loudly.
const jqAvailable = spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;

function webhookSecretAccepted(value: string): boolean {
  const result = spawnSync("jq", ["-Rse", WEBHOOK_SECRET_FILTER], { input: value, encoding: "utf8" });
  if (result.error) throw result.error;
  return result.status === 0;
}

// `collaboration-ticket-keys` holds Ed25519 seeds and is not the V1 `collaboration-proof-keys`
// secret under a new name: #1864 also tightened the value check from "any string >= 32 bytes" to
// base64url of exactly 32 bytes, so the two are different key material. #1889 tried to satisfy the
// V2 gate with the V1 secret and could not. The secret was provisioned on 2026-09-24 and these
// expectations track it.
describe("platform collaboration deployment contract", () => {
  it("configures the direct ticket authority without V1 proof keys or a release flag", () => {
    expect(workflow).toContain("MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID:");
    expect(workflow).toContain("MATRIX_COLLABORATION_TICKET_KEYS=collaboration-ticket-keys:latest");
    expect(workflow).not.toContain("MATRIX_COLLABORATION_PROOF_KEYS=collaboration-proof-keys:latest");
    expect(workflow).not.toContain("MATRIX_COLLABORATION_ACTIVE_KEY_ID:");
    expect(workflow).not.toContain("MATRIX_COLLABORATION_ENABLED");
  });

  it("keeps long-lived collaboration sockets within a bounded Cloud Run capacity envelope", () => {
    expect(workflow).toContain("--timeout 3600");
    expect(workflow).toContain("--concurrency 80");
    expect(workflow).toContain("PLATFORM_MAX_INSTANCES: '30'");
    expect(workflow.match(/--max-instances "\$PLATFORM_MAX_INSTANCES"/g)).toHaveLength(2);
    expect(workflow).toContain('if [ "$actual_max_instances" != "$PLATFORM_MAX_INSTANCES" ]; then');
  });

  // Without this secret the Clerk organization webhook answers 503, the membership projection
  // never fills, and no organization is ever verified -- every share is refused (S03 open gate).
  // `--set-secrets` replaces the whole set on each deploy, so a binding added by hand would be
  // dropped by the next one: the workflow must carry it.
  it("passes the Clerk organization webhook signing secret to the platform", () => {
    expect(workflow).toContain(
      "CLERK_ORGANIZATION_WEBHOOK_SIGNING_SECRET=clerk-organization-webhook-signing-secret:latest",
    );
  });

  it("refuses to deploy without a usable Clerk organization webhook signing secret", () => {
    expect(workflow).toContain("Verify Clerk organization webhook secret");
    expect(workflow).toContain("secret_name=clerk-organization-webhook-signing-secret");
    expect(workflow).toContain(`jq -Rse '${WEBHOOK_SECRET_FILTER}'`);
    // The value is checked from a private temp file and never echoed.
    expect(workflow).toContain('trap \'rm -f "$webhook_secret_tmpfile"\' EXIT');
  });

  it.skipIf(!jqAvailable && !process.env.CI)("accepts only a whole value the platform can decode into a 16-byte key", () => {
    const key = Buffer.alloc(24, 7).toString("base64");
    expect(webhookSecretAccepted(`whsec_${key}`)).toBe(true);
    // 16 base64 characters decode to only 12 bytes: the platform refuses it.
    expect(webhookSecretAccepted("whsec_AAAAAAAAAAAAAAAA")).toBe(false);
    // The platform validates the whole value, so a trailing newline or a second line is unusable.
    expect(webhookSecretAccepted(`whsec_${key}\n`)).toBe(false);
    expect(webhookSecretAccepted(`whsec_${key}\nextra`)).toBe(false);
    expect(webhookSecretAccepted(key)).toBe(false);
  });

  it("checks that the Cloud Run runtime identity, not the deployer, can read the secret", () => {
    // A grant on the secret, or an unconditional project-level secretAccessor grant (how
    // production reads its other secrets) -- so a staging runtime without either fails here,
    // before a revision is created.
    expect(workflow).toContain('runtime_member="serviceAccount:${CLOUD_RUN_SERVICE_ACCOUNT}"');
    expect(workflow).toContain('gcloud projects get-iam-policy "$GCP_PROJECT_ID" --format=json');
    expect(workflow).toContain('select(.role == "roles/secretmanager.secretAccessor" and .condition == null');
    expect(workflow).toContain("must be readable by the Cloud Run runtime identity");
    // The project policy is read only when the secret has no direct grant.
    expect(workflow).toContain('project_grants=0\n          if [ "$secret_grant" != "$runtime_member" ]; then');
  });

  it("verifies the direct ticket key secret and deployed revision contract", () => {
    expect(workflow).toContain("Verify collaboration ticket secret");
    expect(workflow).toContain("secret_name=collaboration-ticket-keys");
    expect(workflow).toContain("MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID\n");
    expect(workflow).toContain("MATRIX_COLLABORATION_TICKET_KEYS=collaboration-ticket-keys:latest");
  });
});
