import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const workflow = YAML.parse(readFileSync(".github/workflows/preview-platform.yml", "utf8"));
const steps = workflow.jobs.preview.steps as Array<{ name?: string; run?: string }>;

function resolve(overrides: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "outlook-preview-"));
  const output = join(directory, "environment");
  try {
    const run = steps.find(step => step.name === "Configure scoped Outlook preview")?.run ?? "exit 99";
    const result = spawnSync("bash", ["--noprofile", "--norc", "-euc", run], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        PATH: process.env.PATH, GITHUB_ENV: output,
        PREVIEW_OUTLOOK_REQUESTED: "true", ISOLATED_PREVIEW_ORIGIN: "false",
        REQUIRE_EXISTING_SERVICE: "true",
        PR_NUMBER: "3801", OUTLOOK_PREVIEW_PR_NUMBER: "3801",
        OUTLOOK_PREVIEW_CLIENT_ID: "99c876a4-a5bd-4ad4-82ab-80a7d58ca7ad",
        CLOUD_RUN_PREVIEW_SERVICE: "matrix-platform-preview",
        PREVIEW_PUBLIC_URL: "https://preview.matrix-os.com",
        ...overrides,
      },
    });
    return { status: result.status, env: result.status === 0 && overrides.PREVIEW_OUTLOOK_REQUESTED !== "false" ? readFileSync(output, "utf8") : "" };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("Outlook preview deployment", () => {
  it("binds a test app and reuses standard Clerk on the Preview browser origin", () => {
    const result = resolve();
    expect(result.status).toBe(0);
    expect(result.env).toContain("|MATRIX_OUTLOOK_ENABLED=true|MATRIX_OUTLOOK_LEGACY_RETIRED=false|");
    expect(result.env).toContain("MATRIX_OUTLOOK_REDIRECT_URI=https://preview.matrix-os.com/api/integrations/outlook/oauth/callback");
    expect(result.env).not.toContain("CLERK");
    expect(result.env).toContain("matrix-outlook-client-secret-preview:1");
    expect(result.env).toContain("matrix-outlook-credential-key-preview:1");
    const validation = workflow.jobs.preview.steps.find((step: { name?: string }) => step.name === "Verify Outlook Preview credentials");
    expect(validation.if).toContain("env.PREVIEW_OUTLOOK_REQUESTED == 'true'");
    expect(validation.run).toContain("gcloud secrets versions describe 1");
    expect(validation.run).not.toContain("secrets versions access");
    expect(validation.run).not.toContain("clerk");
    const deploy = steps.find(step => step.name === "Deploy zero-traffic tagged revision to preview service")?.run;
    expect(deploy).toContain("${OUTLOOK_PREVIEW_ENV_BINDINGS:-}");
    expect(deploy).toContain("${OUTLOOK_PREVIEW_SECRET_BINDINGS:-}");
    expect(deploy).toContain("CLERK_SECRET_KEY=clerk-secret-key:latest,NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=next-public-clerk-publishable-key:latest");
    expect(deploy).toContain("--no-traffic");
  });

  it("keeps ordinary previews independent of Outlook credentials", () => {
    expect(resolve({ PREVIEW_OUTLOOK_REQUESTED: "false", OUTLOOK_PREVIEW_CLIENT_ID: "" })).toEqual({ status: 0, env: "" });
  });

  it.each([
    { OUTLOOK_PREVIEW_PR_NUMBER: "3802" },
    { ISOLATED_PREVIEW_ORIGIN: "true" },
    { REQUIRE_EXISTING_SERVICE: "false" },
    { CLOUD_RUN_PREVIEW_SERVICE: "matrix-platform" },
    { PREVIEW_PUBLIC_URL: "https://app.matrix-os.com" },
    { PREVIEW_PUBLIC_URL: "https://pr-3801---matrix-platform-preview-example-ey.a.run.app" },
    { OUTLOOK_PREVIEW_CLIENT_ID: "" },
  ])("rejects a production, unconfigured, or mismatched Preview %j", overrides => {
    expect(resolve(overrides).status).not.toBe(0);
  });
});
