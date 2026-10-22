import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/platform-cloud-run.yml", "utf8");
const script = workflow.split("python3 - <<'PYCONFIG'\n")[1].split("          PYCONFIG")[0]
  .split("\n").map(line => line.startsWith("          ") ? line.slice(10) : line).join("\n");
const env = { DEPLOY_ENVIRONMENT: "production", MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "true",
  MATRIX_FUNDED_HOST_CONFIG_MACHINE_IDS: "12345678-1234-4234-8234-123456789abc",
  MATRIX_FUNDED_HOST_CONFIG_VALID_THROUGH: new Date(Date.now() + 3_600_000).toISOString(),
  GITHUB_SHA: "a".repeat(40), MATRIX_FUNDED_AI_RELAY_URL: "https://matrix-ai-relay-production-jqxkjdhtkq-ey.a.run.app" };
function validate(overrides: Record<string, string> = {}) {
  return spawnSync("python3", ["-c", script], { env: { PATH: process.env.PATH, ...env, ...overrides }, timeout: 5000 });
}
describe("default-off host config workflow", () => {
  it("validates the bounded reviewed production configuration", () => expect(validate().status).toBe(0));
  it.each([
    { DEPLOY_ENVIRONMENT: "staging" }, { MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "false" },
    { MATRIX_FUNDED_HOST_CONFIG_MACHINE_IDS: "not-uuid" },
    { MATRIX_FUNDED_HOST_CONFIG_MACHINE_IDS: env.MATRIX_FUNDED_HOST_CONFIG_MACHINE_IDS + "," + env.MATRIX_FUNDED_HOST_CONFIG_MACHINE_IDS },
    { MATRIX_FUNDED_HOST_CONFIG_MACHINE_IDS: Array.from({ length: 101 }, (_, index) => `${String(index).padStart(8, "0")}-1234-4234-8234-123456789abc`).join(",") },
    { MATRIX_FUNDED_HOST_CONFIG_VALID_THROUGH: new Date(Date.now() - 1000).toISOString() },
    { MATRIX_FUNDED_HOST_CONFIG_VALID_THROUGH: new Date(Date.now() + 8 * 86_400_000).toISOString() },
    { MATRIX_FUNDED_HOST_CONFIG_VALID_THROUGH: "2026-02-30T12:00:00.000Z" },
    { GITHUB_SHA: "abc" }, { MATRIX_FUNDED_AI_RELAY_URL: "https://candidate---matrix-ai-relay-production-x-ey.a.run.app" },
    { MATRIX_FUNDED_AI_RELAY_URL: "https://matrix-ai-relay-x-ey.a.run.app" },
  ])("rejects invalid settings %j", value => {
    const result = validate(value); expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain("Funded host configuration is misconfigured");
  });
  it("allows empty cohort without enabling any machine", () => expect(validate({ MATRIX_FUNDED_HOST_CONFIG_MACHINE_IDS: "" }).status).toBe(0));
  it("persists default false and binds enabled source to deployment commit", () => {
    expect(workflow).toContain("MATRIX_FUNDED_HOST_CONFIG_ENABLED: ${{ vars.MATRIX_FUNDED_HOST_CONFIG_ENABLED || 'false' }}");
    expect(workflow).toContain("|MATRIX_FUNDED_HOST_CONFIG_ENABLED=${MATRIX_FUNDED_HOST_CONFIG_ENABLED}");
    expect(workflow).toContain("|MATRIX_FUNDED_HOST_CONFIG_SOURCE_SHA=${GITHUB_SHA}");
    expect(workflow).toContain('if [ "$MATRIX_FUNDED_HOST_CONFIG_ENABLED" = "true" ]; then');
  });
});
