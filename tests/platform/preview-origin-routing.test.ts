import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/preview-platform.yml", "utf8"));
const step = workflow.jobs["connect-share-preview"].steps.find((item: { name?: string }) => item.name === "Enable the existing tagged host without moving traffic");
const script = (step.run as string).split('if ! [[ "$PREVIEW_CLERK_USER_ID"')[0];

// Execute the actual connector shell with only the cloud boundary replaced.
function connector(publicOrigin = "https://preview.example.com") {
  return spawnSync("bash", ["-c", `
    gcloud() {
      case "$1 $2 $3" in
        "help "*) return 0 ;;
        "run services describe") printf '%s' '{"status":{"url":"https://service.run.app","traffic":[{"tag":"pr-42","revisionName":"revision-42","url":"https://pr-42---service.run.app"}]}}' ;;
        "run revisions describe")
          if [[ "$*" == *"--format=json"* ]]; then
            printf '%s' "$FIXTURE_REVISION"
          else printf '%s' 'region-docker.pkg.dev/fixture/images/matrix-platform:pr-42-aaaaaaaaaaaa'; fi ;;
        "artifacts docker images") printf '%s' 'sha256:fixture' ;;
        "run deploy matrix-platform-preview") printf '%s\\n' "$@" ;;
        *) return 1 ;;
      esac
    }
    ${script}
  `], { encoding: "utf8", env: {
    PATH: process.env.PATH, PR_NUMBER: "42", GCP_PROJECT_ID: "fixture", GCP_REGION: "region",
    ARTIFACT_REPOSITORY: "images", CLOUD_RUN_PREVIEW_SERVICE: "matrix-platform-preview",
    EXPECTED_HEAD_SHA: "a".repeat(40), CUSTOM_MCP_ENABLED: "false",
    FIXTURE_REVISION: JSON.stringify({ spec: { containers: [{
      image: "region-docker.pkg.dev/fixture/images/matrix-platform:pr-42-aaaaaaaaaaaa",
      env: [{ name: "MATRIX_APP_ORIGIN", value: publicOrigin }],
    }] } }),
  } });
}

describe("preview browser routing after connecting the share home", () => {
  it("keeps the selected preview's canonical origin, tagged host and default service host", () => {
    const result = connector();
    expect(result.status, result.stderr).toBe(0);
    const args = result.stdout.trim().split("\n");
    const env = args[args.indexOf("--update-env-vars") + 1].slice(3).split("@");
    expect(env).toContain("MATRIX_APP_DOMAIN_HOSTS=preview.example.com,pr-42---service.run.app,service.run.app");
    expect(env).toContain("MATRIX_APP_ORIGIN=https://preview.example.com");
    expect(args).toContain("--no-traffic");
  });

  it.each(["https://app.matrix-os.com", "https://api.matrix-os.com", "http://preview.example.com"])("rejects an invalid preview origin %s before deploying", (origin) => {
    const result = connector(origin);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("--update-env-vars");
  });
});
