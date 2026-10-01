import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const job = YAML.parse(readFileSync(".github/workflows/preview-platform.yml", "utf8")).jobs.preview;
const name = "Resolve isolated preview browser origin";
function resolve(overrides: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "preview-origin-"));
  const output = join(directory, "environment");
  try {
    const run = job.steps.find((step: { name?: string }) => step.name === name)?.run;
    const result = spawnSync("bash", ["-euc", `gcloud() { printf '%s\\n' "$SERVICE_URL"; }\n${run ?? "exit 99"}`], {
      encoding: "utf8", timeout: 5_000, env: {
        PATH: process.env.PATH, GITHUB_ENV: output, PR_NUMBER: "2079",
        ISOLATED_PREVIEW_ORIGIN: "true", CLOUD_RUN_PREVIEW_SERVICE: "matrix-platform-preview",
        SLACK_PILOT_PR_NUMBER: "", SLACK_PILOT_APP_ID: "", SLACK_PILOT_CLIENT_ID: "",
        GCP_PROJECT_ID: "synthetic-project", GCP_REGION: "synthetic-region",
        SERVICE_URL: "https://matrix-platform-preview-example-ey.a.run.app", ...overrides,
      },
    });
    return { ...result, env: result.status === 0 && overrides.ISOLATED_PREVIEW_ORIGIN !== "false" ? readFileSync(output, "utf8") : "" };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function verifyPilotSecret(state = "ENABLED", accessor = "serviceAccount:synthetic-preview@example.test") {
  const run = job.steps.find((step: { name?: string }) => step.name === "Verify selected Slack preview credentials").run;
  const result = spawnSync("bash", ["-euc", `gcloud() { if [ "$2" = "versions" ]; then printf '%s\\n' "$SECRET_STATE"; else printf '%s\\n' "$ACCESSOR"; fi; }\n${run}`], {
    encoding: "utf8", timeout: 5_000, env: {
      PATH: process.env.PATH, PR_NUMBER: "2079", GCP_PROJECT_ID: "synthetic-project",
      CLOUD_RUN_SERVICE_ACCOUNT: "synthetic-preview@example.test", SECRET_STATE: state, ACCESSOR: accessor,
    },
  });
  return result;
}

describe("isolated preview browser origin", () => {
  it("requires enabled pilot secret versions and the exact preview runner's grant before building", () => {
    expect(verifyPilotSecret().status).toBe(0);
    expect(verifyPilotSecret("DISABLED").status).not.toBe(0);
    expect(verifyPilotSecret("DESTROYED").status).not.toBe(0);
    expect(verifyPilotSecret("ENABLED", "serviceAccount:other@example.test").status).not.toBe(0);
    const names = job.steps.map((step: { name?: string }) => step.name);
    expect(names.indexOf("Verify selected Slack preview credentials")).toBeLessThan(names.indexOf("Build platform image"));
  });
  it("bakes the exact tag into sign-in and runtime configuration before building", () => {
    const result = resolve();
    expect(result.status, result.stderr).toBe(0);
    expect(result.env).toBe("PREVIEW_PUBLIC_URL=https://pr-2079---matrix-platform-preview-example-ey.a.run.app\n");
    const names = job.steps.map((step: { name?: string }) => step.name);
    expect(names.indexOf(name)).toBeGreaterThan(names.indexOf("Authenticate to Google Cloud"));
    expect(names.indexOf(name)).toBeLessThan(names.indexOf("Build platform image"));
    expect(job.env.ISOLATED_PREVIEW_ORIGIN).toContain("preview-isolated");
  });
  it("preserves the existing shared-host mode unless isolation is selected", () => {
    expect(resolve({ ISOLATED_PREVIEW_ORIGIN: "false" }).status).toBe(0);
  });
  it("retains the explicitly selected Slack app across builds on its approved browser alias", () => {
    const result = resolve({ SLACK_PILOT_PR_NUMBER: "2079", SLACK_PILOT_APP_ID: "AEXAMPLE", SLACK_PILOT_CLIENT_ID: "123.456" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.env).toContain("PREVIEW_PUBLIC_URL=https://pr-2079-preview.matrix-os.com\n");
    expect(result.env).toContain("SLACK_APP_ID=AEXAMPLE|SLACK_CLIENT_ID=123.456|SLACK_PUBLIC_BASE_URL=https://pr-2079-preview.matrix-os.com|SLACK_PREVIEW_RUNTIME_HANDLE=pr-2079");
    expect(result.env).toContain("SLACK_CLIENT_SECRET=slack-preview-pr2079-client-secret:1");
    expect(result.env).toContain("SLACK_SIGNING_SECRET=slack-preview-pr2079-signing-secret:1");
    expect(result.env).toContain("SLACK_TOKEN_ENCRYPTION_KEY=slack-preview-pr2079-token-encryption-key:1");
  });
  it("does not grant another PR access to the pilot app", () => {
    expect(resolve({ SLACK_PILOT_PR_NUMBER: "2080", SLACK_PILOT_APP_ID: "AEXAMPLE", SLACK_PILOT_CLIENT_ID: "123.456" }).env)
      .toBe("PREVIEW_PUBLIC_URL=https://pr-2079---matrix-platform-preview-example-ey.a.run.app\n");
  });
  it.each([
    { SLACK_PILOT_APP_ID: "" },
    { SLACK_PILOT_APP_ID: "AEXAMPLE|OTHER=1" },
    { SLACK_PILOT_CLIENT_ID: "" },
    { SLACK_PILOT_CLIENT_ID: "123.456\nOTHER=1" },
    { ISOLATED_PREVIEW_ORIGIN: "false" },
  ])("refuses invalid selected pilot configuration %j", (override) => {
    expect(resolve({ SLACK_PILOT_PR_NUMBER: "2079", SLACK_PILOT_APP_ID: "AEXAMPLE", SLACK_PILOT_CLIENT_ID: "123.456", ...override }).status).not.toBe(0);
  });
  it.each([
    { SERVICE_URL: "" },
    { SERVICE_URL: "https://app.matrix-os.com" },
    { SERVICE_URL: "https://matrix-platform-preview-example-ey.a.run.app/path" },
    { SERVICE_URL: "http://matrix-platform-preview-example-ey.a.run.app" },
    { SERVICE_URL: "https://matrix-platform-example-ey.a.run.app" },
    { CLOUD_RUN_PREVIEW_SERVICE: "matrix-platform" },
    { PR_NUMBER: "2079\nOTHER=1" },
    { PR_NUMBER: "" },
    { PR_NUMBER: "0" },
    { ISOLATED_PREVIEW_ORIGIN: "yes" },
  ])("refuses an invalid isolated configuration %j", (overrides) => {
    expect(resolve(overrides).status).not.toBe(0);
  });
});
