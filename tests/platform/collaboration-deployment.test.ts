import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(resolve(".github/workflows/platform-cloud-run.yml"), "utf8");

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
    expect(workflow).toContain("--max-instances 10");
  });

  it("verifies the direct ticket key secret and deployed revision contract", () => {
    expect(workflow).toContain("Verify collaboration ticket secret");
    expect(workflow).toContain("secret_name=collaboration-ticket-keys");
    expect(workflow).toContain("MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID\n");
    expect(workflow).toContain("MATRIX_COLLABORATION_TICKET_KEYS=collaboration-ticket-keys:latest");
  });
});
