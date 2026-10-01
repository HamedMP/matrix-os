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
        GCP_PROJECT_ID: "synthetic-project", GCP_REGION: "synthetic-region",
        SERVICE_URL: "https://matrix-platform-preview-example-ey.a.run.app", ...overrides,
      },
    });
    return { ...result, env: result.status === 0 && overrides.ISOLATED_PREVIEW_ORIGIN !== "false" ? readFileSync(output, "utf8") : "" };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("isolated preview browser origin", () => {
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
