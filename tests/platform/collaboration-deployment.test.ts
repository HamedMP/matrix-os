import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(resolve(".github/workflows/platform-cloud-run.yml"), "utf8");

describe("platform collaboration deployment contract", () => {
  it("configures the platform authority without any collaboration release flag", () => {
    expect(workflow).toContain("MATRIX_COLLABORATION_ACTIVE_KEY_ID:");
    expect(workflow).toContain("MATRIX_COLLABORATION_ALLOWED_ORIGINS:");
    expect(workflow).toContain("MATRIX_COLLABORATION_PROOF_KEYS=collaboration-proof-keys:latest");
    expect(workflow).not.toContain("MATRIX_COLLABORATION_ENABLED");
  });

  it("keeps long-lived collaboration sockets within a bounded Cloud Run capacity envelope", () => {
    expect(workflow).toContain("--timeout 3600");
    expect(workflow).toContain("--concurrency 80");
    expect(workflow).toContain("--max-instances 10");
  });

  it("verifies the proof-key secret and the deployed revision contract", () => {
    expect(workflow).toContain("Verify collaboration proof secret");
    expect(workflow).toContain("secret_name=collaboration-proof-keys");
    expect(workflow).toContain("MATRIX_COLLABORATION_ACTIVE_KEY_ID\n");
    expect(workflow).toContain("MATRIX_COLLABORATION_PROOF_KEYS=collaboration-proof-keys:latest");
  });
});
