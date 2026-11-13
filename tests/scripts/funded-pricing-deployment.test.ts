import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const registry = "MATRIX_FUNDED_AI_PRICING_REGISTRY_ENABLED";
const job = "MATRIX_FUNDED_AI_PRICING_REVIEW_JOB_ENABLED";
const controlled = {
  MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "true",
  MATRIX_FUNDED_AI_PRICING_LINEAR_TEAM_ID: "11111111-1111-4111-8111-111111111111",
  MATRIX_FUNDED_AI_PRICING_LINEAR_OPEN_STATE_ID: "22222222-2222-4222-8222-222222222222",
  MATRIX_FUNDED_AI_PRICING_LINEAR_COMPLETED_STATE_ID: "33333333-3333-4333-8333-333333333333",
  MATRIX_FUNDED_AI_PRICING_LINEAR_TOKEN_VERSION: "3",
};
const render = (env: Record<string, string>) => spawnSync("bash", ["scripts/ci/platform-funded-pricing-env.sh"], {
  env: { PATH: process.env.PATH, ...env }, encoding: "utf8",
});

describe("funded pricing Cloud Run bindings", () => {
  it("keeps normal releases inactive until explicitly configured", () => {
    const result = render({});
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("FUNDED_PRICING_ENV_BINDINGS=\nFUNDED_PRICING_SECRET_BINDINGS=\n");
  });

  it("can stage the verifier before switching registry reads", () => {
    const staged = render({ ...controlled, [job]: "true" });
    expect(staged.status).toBe(0);
    expect(staged.stdout).toContain(`${job}=true`);
    expect(staged.stdout).toContain("MATRIX_FUNDED_AI_PRICING_LINEAR_API_KEY=funded-ai-pricing-linear-token:3");
    expect(staged.stdout).not.toContain(registry);
    const active = render({ ...controlled, [job]: "true", [registry]: "true" });
    expect(active.status).toBe(0);
    expect(active.stdout).toContain(`${registry}=true`);
  });

  it.each([
    { [job]: "true", MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "false" },
    { [job]: "true", MATRIX_FUNDED_AI_PRICING_LINEAR_TOKEN_VERSION: "latest" },
    { [job]: "true", MATRIX_FUNDED_AI_PRICING_LINEAR_TEAM_ID: "team|OTHER=true" },
    { [registry]: "true" },
  ])("rejects an incomplete or unsafe activation (%j)", patch => {
    const result = render({ ...controlled, ...patch });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});
