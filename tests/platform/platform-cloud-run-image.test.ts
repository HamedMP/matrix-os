import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/platform-cloud-run.yml", "utf8"));
const buildStep = workflow.jobs.deploy.steps.find((step: { name?: string }) => step.name === "Build platform image");
const digest = `sha256:${"a".repeat(64)}`;
const fakeCloud = `
gcloud() {
  case "$1 $2" in
    'secrets versions') echo 'test-clerk-key' ;;
    'builds submit')
      [[ " $* " == *' --timeout=1800s '* ]] || return 91
      echo 'build-42'
      ;;
    'builds describe')
      case "$*" in
        *'value(status)'*)
          if [[ "$SCENARIO" == cloud-timeout ]]; then echo TIMEOUT; else echo SUCCESS; fi
          ;;
        *'timing,steps.timing,results.images'*) printf 'timing:\\n  BUILD: {}\\n  PUSH: {}\\n' ;;
        *) echo 'failure metadata' ;;
      esac
      ;;
    'builds log') echo 'Cloud Build logs' ;;
    'artifacts docker')
      if [[ "$SCENARIO" == invalid-digest ]]; then echo invalid; else echo '${digest}'; fi
      ;;
    *) return 92 ;;
  esac
}
timeout() {
  if [[ "$*" == *'value(status)' ]]; then
    [[ "$1" =~ ^(209[6-9]|2100)s$ ]] || return 93
    if [[ "$SCENARIO" == poll-deadline ]]; then return 124; fi
  fi
  shift
  "$@"
}
`;

it.each(["success", "poll-deadline", "cloud-timeout", "invalid-digest"])(
  "bounds the platform image publish and records its outcome when %s",
  (scenario) => {
    const tempDir = mkdtempSync(join(tmpdir(), "matrix-platform-image-"));
    const envFile = join(tempDir, "env");
    const summaryFile = join(tempDir, "summary");
    try {
      const result = spawnSync("bash", ["-c", fakeCloud + buildStep.run], {
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          GCP_PROJECT_ID: "project",
          GCP_REGION: "region",
          ARTIFACT_REPOSITORY: "repo",
          GITHUB_SHA: "b".repeat(40),
          POSTHOG_PUBLIC_HOST: "",
          POSTHOG_PUBLIC_API_HOST: "/relay",
          MATRIX_APP_URL: "https://example.com",
          GITHUB_ENV: envFile,
          GITHUB_STEP_SUMMARY: summaryFile,
          SCENARIO: scenario,
        },
      });
      const published = scenario === "success";
      expect(result.status, result.stderr).toBe(published ? 0 : 1);
      const summary = readFileSync(summaryFile, "utf8");
      expect(summary).toContain("BUILD:");
      expect(summary).toContain("PUSH:");
      expect(summary.includes(digest)).toBe(published);
      const outputs = readFileSync(envFile, "utf8");
      if (published) {
        expect(outputs).toContain(`IMAGE_DIGEST=region-docker.pkg.dev/project/repo/matrix-platform@${digest}`);
      } else {
        expect(outputs).not.toContain("IMAGE_DIGEST=");
      }
      if (scenario === "poll-deadline" || scenario === "cloud-timeout") {
        expect(result.stdout).toContain("failure metadata");
        expect(result.stdout).toContain("Cloud Build logs");
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  },
);
