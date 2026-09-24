import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(resolve(".github/workflows/platform-cloud-run.yml"), "utf8");

// The env var name and the secret name deliberately differ. `MATRIX_COLLABORATION_TICKET_KEYS`
// is the V2 spelling the platform code reads; `collaboration-proof-keys` is the Secret Manager
// entry that actually exists and holds the signing seeds. #1864 renamed the workflow and the code
// to `collaboration-ticket-keys` but nothing renamed the secret, which broke every production
// deployment until #1889 pointed the binding back at the live name. Renaming the secret is a key
// migration (create, grant, cut over, verify, retire) and is deliberately not bundled with an
// outage fix -- so do not "correct" these expectations to `collaboration-ticket-keys` without
// migrating the secret first and confirming the new name exists in `matrix-os-1144`.
describe("platform collaboration deployment contract", () => {
  it("configures the direct ticket authority without V1 proof keys or a release flag", () => {
    expect(workflow).toContain("MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID:");
    expect(workflow).toContain("MATRIX_COLLABORATION_TICKET_KEYS=collaboration-proof-keys:latest");
    expect(workflow).not.toContain("MATRIX_COLLABORATION_PROOF_KEYS=collaboration-proof-keys:latest");
    expect(workflow).not.toContain("MATRIX_COLLABORATION_ACTIVE_KEY_ID:");
    expect(workflow).not.toContain("MATRIX_COLLABORATION_ENABLED");
  });

  it("keeps long-lived collaboration sockets within a bounded Cloud Run capacity envelope", () => {
    expect(workflow).toContain("--timeout 3600");
    expect(workflow).toContain("--concurrency 80");
    expect(workflow).toContain("--max-instances 10");
  });

  it("verifies the direct ticket key secret and deployed revision contract", () => {
    expect(workflow).toContain("Verify collaboration ticket secret");
    expect(workflow).toContain("secret_name=collaboration-proof-keys");
    expect(workflow).toContain("MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID\n");
    expect(workflow).toContain("MATRIX_COLLABORATION_TICKET_KEYS=collaboration-proof-keys:latest");
  });
});
