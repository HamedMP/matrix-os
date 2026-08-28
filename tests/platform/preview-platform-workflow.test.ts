import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = process.cwd();

function runTeardownWithService(
  service: unknown,
  deleteFailure =
    "ERROR: (gcloud.run.revisions.delete) FAILED_PRECONDITION: The latest created Revision 'revision-latest' cannot be directly deleted.",
) {
  const workflow = parse(
    readFileSync(join(root, ".github/workflows/preview-platform.yml"), "utf8"),
  ) as {
    jobs: { teardown: { steps: Array<{ name?: string; run?: string }> } };
  };
  const script = workflow.jobs.teardown.steps.find(
    (step) => step.name === "Remove tag and delete tagged revisions",
  )?.run;
  if (!script) {
    throw new Error("Preview teardown script is missing");
  }

  const tempDir = mkdtempSync(join(tmpdir(), "matrix-preview-teardown-"));
  const logPath = join(tempDir, "gcloud.log");
  const gcloudPath = join(tempDir, "gcloud");
  writeFileSync(
    gcloudPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_GCLOUD_LOG"
case "$*" in
  "run services describe "*)
    if [[ "$*" == *"--format json"* ]]; then
      printf '%s\\n' "$MOCK_SERVICE_JSON"
    else
      printf '%s\\n' "$MOCK_LATEST_REVISION"
    fi
    ;;
  "run services update-traffic "*)
    ;;
  "run revisions delete "*)
    if [[ "$*" == *"run revisions delete $MOCK_UNDELETABLE_REVISION "* ]]; then
      printf '%s\n' "$MOCK_DELETE_FAILURE" >&2
      exit 1
    fi
    ;;
  *)
    exit 64
    ;;
esac
`,
  );
  chmodSync(gcloudPath, 0o755);

  try {
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        CLOUD_RUN_PREVIEW_SERVICE: "matrix-platform-preview",
        GCP_PROJECT_ID: "matrix-test",
        GCP_REGION: "europe-west3",
        PR_NUMBER: "42",
        MOCK_GCLOUD_LOG: logPath,
        MOCK_SERVICE_JSON: JSON.stringify(service),
        MOCK_LATEST_REVISION: "revision-latest",
        MOCK_UNDELETABLE_REVISION: "revision-latest",
        MOCK_DELETE_FAILURE: deleteFailure,
      },
    });
    return {
      ...result,
      log: readFileSync(logPath, "utf8"),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runDeployWithServiceLookupFailure(lookupFailure: string) {
  const workflow = parse(
    readFileSync(join(root, ".github/workflows/preview-platform.yml"), "utf8"),
  ) as {
    jobs: { preview: { steps: Array<{ name?: string; run?: string }> } };
  };
  const script = workflow.jobs.preview.steps.find(
    (step) => step.name === "Deploy isolated tagged revision",
  )?.run;
  if (!script) {
    throw new Error("Preview deployment script is missing");
  }

  const tempDir = mkdtempSync(join(tmpdir(), "matrix-preview-deploy-"));
  const logPath = join(tempDir, "gcloud.log");
  const gcloudPath = join(tempDir, "gcloud");
  const githubEnvPath = join(tempDir, "github.env");
  writeFileSync(githubEnvPath, "");
  writeFileSync(
    gcloudPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_GCLOUD_LOG"
if [[ "$*" == "run services describe "* ]]; then
  printf '%s\\n' "$MOCK_LOOKUP_FAILURE" >&2
  exit 1
fi
exit 64
`,
  );
  chmodSync(gcloudPath, 0o755);

  try {
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        CLOUD_RUN_PREVIEW_SERVICE: "matrix-platform-staging",
        CLOUD_RUN_SERVICE_ACCOUNT:
          "matrix-platform-preview-runner@matrix-os-1144.iam.gserviceaccount.com",
        DEPLOYMENT_ENVIRONMENT: "staging",
        GCP_PROJECT_ID: "matrix-test",
        GCP_REGION: "europe-west3",
        GITHUB_ENV: githubEnvPath,
        IMAGE: "europe-west3-docker.pkg.dev/matrix-test/containers/platform:test",
        MATRIX_CARD_TRIAL_DAYS: "7",
        MATRIX_CARD_TRIALS_ENABLED: "false",
        MOCK_GCLOUD_LOG: logPath,
        MOCK_LOOKUP_FAILURE: lookupFailure,
        PREVIEW_PUBLIC_URL: "https://staging.example.test",
        PR_NUMBER: "42",
        REVISION_TAG: "staging-42",
      },
    });
    return {
      ...result,
      log: readFileSync(logPath, "utf8"),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("preview platform workflow", () => {
  it("sources the deployed control-plane origin from the selected environment", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/platform-cloud-run.yml"),
      "utf8",
    );

    expect(workflow).toContain("MATRIX_API_ORIGIN: ${{ vars.MATRIX_API_ORIGIN }}");
    expect(workflow).toContain("PLATFORM_PUBLIC_URL \\");
    expect(workflow).toContain("MATRIX_API_ORIGIN \\");
    expect(workflow).toContain("MATRIX_API_ORIGIN=${MATRIX_API_ORIGIN}");
    expect(workflow).not.toContain("MATRIX_API_ORIGIN=https://api.matrix-os.com");
  });

  it("bootstraps a missing Cloud Run service before deriving its dedicated API origin", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/preview-platform.yml"),
      "utf8",
    );

    expect(workflow).not.toContain("2>/dev/null || true");
    expect(workflow).toContain('service_lookup_error="$(mktemp)"');
    expect(workflow).toContain('grep -Fq "could not be found" "$service_lookup_error"');
    expect(workflow).toContain('BOOTSTRAP_API_ORIGIN="$PREVIEW_PUBLIC_URL"');
    expect(workflow).toContain('if [ -z "$service_base_url" ]; then');
    expect(workflow).toContain('deploy_preview "$BOOTSTRAP_API_ORIGIN"');
    expect(workflow).toContain('deploy_preview "$PREVIEW_API_ORIGIN"');

    const bootstrap = workflow.indexOf('deploy_preview "$BOOTSTRAP_API_ORIGIN"');
    const deriveOrigin = workflow.indexOf(
      'PREVIEW_API_ORIGIN="https://${REVISION_TAG}---${service_base_url#https://}"',
    );
    const finalDeploy = workflow.indexOf('deploy_preview "$PREVIEW_API_ORIGIN"');
    expect(bootstrap).toBeGreaterThan(-1);
    expect(deriveOrigin).toBeGreaterThan(bootstrap);
    expect(finalDeploy).toBeGreaterThan(deriveOrigin);
  });

  it("fails closed when Cloud Run service lookup fails for a reason other than not found", () => {
    const result = runDeployWithServiceLookupFailure(
      "ERROR: (gcloud.run.services.describe) PERMISSION_DENIED: denied",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PERMISSION_DENIED: denied");
    expect(result.log).toContain("run services describe matrix-platform-staging");
    expect(result.log).not.toContain("run deploy");
  });

  it("promotes only the health-checked staging revision to default traffic", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/preview-platform.yml"),
      "utf8",
    );

    expect(workflow).toContain('if [ "$DEPLOYMENT_ENVIRONMENT" = "staging" ]; then');
    expect(workflow).toContain('--to-revisions "${revision}=100"');
    expect(workflow).toContain("Staging default traffic does not point to the verified revision.");

    const healthCheck = workflow.indexOf(
      '"${PREVIEW_API_ORIGIN}/health" > /dev/null',
    );
    const promotion = workflow.indexOf('--to-revisions "${revision}=100"');
    expect(healthCheck).toBeGreaterThan(-1);
    expect(promotion).toBeGreaterThan(healthCheck);
  });

  it("removes closed PR tags while tolerating Cloud Run's latest-created revision guard", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/preview-platform.yml"),
      "utf8",
    );

    expect(workflow).toContain('--remove-tags "pr-${PR_NUMBER}"');
    expect(workflow).toContain('if delete_output="$(gcloud run revisions delete "$rev"');
    expect(workflow).toContain(
      'grep -Fq "FAILED_PRECONDITION: The latest created Revision"',
    );
    expect(workflow).toContain('grep -Fq "cannot be directly deleted"');
    expect(workflow).toContain("Retained latest-created revision $rev after removing its PR tag.");

    const removeTag = workflow.indexOf('--remove-tags "pr-${PR_NUMBER}"');
    const deleteRevision = workflow.indexOf(
      'if delete_output="$(gcloud run revisions delete "$rev"',
    );
    const tolerateLatest = workflow.indexOf(
      'grep -Fq "FAILED_PRECONDITION: The latest created Revision"',
    );
    expect(removeTag).toBeGreaterThan(-1);
    expect(deleteRevision).toBeGreaterThan(removeTag);
    expect(tolerateLatest).toBeGreaterThan(deleteRevision);
  });

  it("removes the PR tag, tolerates the protected latest revision, and deletes older tagged revisions", () => {
    const result = runTeardownWithService({
      status: {
        latestCreatedRevisionName: "revision-stale-snapshot",
        traffic: [
          { tag: "pr-42", revisionName: "revision-latest" },
          { tag: "pr-42", revisionName: "revision-older" },
        ],
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Retained latest-created revision revision-latest after removing its PR tag.",
    );
    expect(result.stdout).toContain("Deleted revision revision-older");
    expect(result.log).toContain("run services update-traffic matrix-platform-preview");
    expect(result.log).toContain("--remove-tags pr-42");
    expect(result.log).toContain(
      "run revisions delete revision-latest --project matrix-test --region europe-west3 --quiet",
    );
    expect(result.log).toContain("run revisions delete revision-older");
  });

  it("fails teardown when revision deletion returns an unrelated error", () => {
    const result = runTeardownWithService(
      {
        status: {
          traffic: [{ tag: "pr-42", revisionName: "revision-latest" }],
        },
      },
      "ERROR: permission denied",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ERROR: permission denied");
    expect(result.log).toContain("run revisions delete revision-latest");
  });

  it("treats an already removed preview tag as a successful no-op", () => {
    const result = runTeardownWithService({
      status: {
        latestCreatedRevisionName: "revision-latest",
        traffic: [],
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No revisions tagged pr-42; nothing to tear down.");
    expect(result.log).toContain("run services describe matrix-platform-preview");
    expect(result.log).not.toContain("run services update-traffic");
    expect(result.log).not.toContain("run revisions delete");
  });
});
