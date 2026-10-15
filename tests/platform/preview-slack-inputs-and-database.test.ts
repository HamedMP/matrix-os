import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const jobs = YAML.parse(readFileSync(".github/workflows/preview-platform.yml", "utf8")).jobs;
const slack = jobs["connect-slack-pilot-preview"];
const target = slack.steps.find((step: { id?: string }) => step.id === "target");
const head = "a".repeat(40);
function fixture(callback: (directory: string, executable: (name: string, body: string) => void) => void) {
  const directory = mkdtempSync(join(tmpdir(), "slack-preview-binding-"));
  try {
    callback(directory, (name, body) => {
      const path = join(directory, name);
      writeFileSync(path, `#!/usr/bin/env bash\n${body}`); chmodSync(path, 0o700);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function checkTarget(version: unknown, duplicate = false) {
  let result: { status: number | null; stderr: string; output: string };
  fixture((directory, executable) => {
    const database = { name: "PLATFORM_DATABASE_URL", valueFrom: { secretKeyRef: { name: "slack-preview-pr2079-platform-database-url", key: version } } };
    const env = [database,
      { name: "PLATFORM_PREVIEW", value: "true" },
      { name: "SLACK_PREVIEW_RUNTIME_HANDLE", value: "pr-2079" },
      { name: "PLATFORM_SECRET", valueFrom: { secretKeyRef: { name: "platform-preview-secret", key: "latest" } } },
      { name: "MATRIX_COLLABORATION_ALLOWED_ORIGINS", value: "https://pr-2079-preview.matrix-os.com" },
      { name: "MATRIX_COLLABORATION_RELAY_ORIGIN", value: "https://pr-2079-preview.matrix-os.com" },
      { name: "MATRIX_COLLABORATION_TICKET_KEYS", valueFrom: { secretKeyRef: { name: "collaboration-ticket-keys-preview", key: "latest" } } },
      ...(duplicate ? [database] : []),
    ];
    writeFileSync(join(directory, "revision"), JSON.stringify({ spec: { containers: [{ image: `eu-docker.pkg.dev/synthetic/artifacts/matrix-platform:pr-2079-${head.slice(0,12)}`, env }] } }));
    writeFileSync(join(directory, "service"), JSON.stringify({ status: { traffic: [{ tag: "pr-2079", revisionName: "synthetic-revision", url: "https://preview.example.test" }] } }));
    writeFileSync(join(directory, "pull"), JSON.stringify({ state: "open", head: { sha: head, repo: { full_name: "HamedMP/matrix-os" } }, labels: ["preview-vps", "preview-platform", "preview-isolated"].map(name => ({name})) }));
    writeFileSync(join(directory, "output"), "");
    executable("gh", 'cat "$ROOT/pull"\n');
    executable("gcloud", `case "$*" in
      "run services describe "*) cat "$ROOT/service" ;;
      "run revisions describe "*) cat "$ROOT/revision" ;;
      "artifacts docker images describe "*) printf 'sha256:synthetic' ;;
      *) exit 19 ;;
    esac\n`);
    const run = spawnSync("bash", ["-euc", target.run], { encoding: "utf8", timeout: 5_000, env: {
      PATH: `${directory}:${process.env.PATH}`, ROOT: directory, GITHUB_OUTPUT: join(directory,"output"),
      PR_NUMBER: "2079", SLACK_PILOT_PR_NUMBER: "2079", PREVIEW_RUNTIME_OWNER_ID: "user_synthetic",
      CLOUD_RUN_PREVIEW_SERVICE: "matrix-platform-preview", GCP_PROJECT_ID: "synthetic", GCP_REGION: "eu", ARTIFACT_REPOSITORY: "artifacts",
      GITHUB_REPOSITORY: "HamedMP/matrix-os", EXPECTED_HEAD_SHA: head,
    } });
    result = { status: run.status, stderr: run.stderr, output: readFileSync(join(directory,"output"),"utf8") };
  });
  return result!;
}

describe("Slack preview connection input and database fences", () => {
  it.each(["1", "17"])("carries checked revision database version %s instead of rotated latest", version => {
    const result = checkTarget(version);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain(`database_secret_version=${version}\n`);
  });
  it.each(["latest", "", null])("rejects non-immutable database version %s", version => {
    expect(checkTarget(version).status).not.toBe(0);
  });
  it("rejects ambiguous database bindings", () => {
    expect(checkTarget("1", true).status).not.toBe(0);
  });
  it("uses the checked version in both connection processes", () => {
    const consumers = slack.steps.filter((step: { name?: string }) => [
      "Prove the Slack link and preview home have the same owner",
      "Connect the preview VM to the isolated Slack backend under a rollback guard",
    ].includes(step.name ?? ""));
    expect(consumers).toHaveLength(2);
    for (const step of consumers) {
      expect(step.env.PREVIEW_DATABASE_SECRET_VERSION).toBe("${{ steps.target.outputs.database_secret_version }}");
      fixture((directory, executable) => {
        executable("gcloud", 'printf "%s\\n" "$*" > "$ROOT/arguments"\nprintf synthetic-database\n');
        const command = step.run.match(/^\s*preview_db=.*$/m)?.[0];
        expect(command).toBeDefined();
        const run = spawnSync("bash", ["-euc", command!], { encoding: "utf8", timeout: 2_000, env: {
          PATH: `${directory}:${process.env.PATH}`, ROOT: directory, PR_NUMBER: "2079", GCP_PROJECT_ID: "synthetic", PREVIEW_DATABASE_SECRET_VERSION: "17",
        } });
        expect(run.status, run.stderr).toBe(0);
        expect(readFileSync(join(directory,"arguments"),"utf8")).toContain("versions access 17 --secret slack-preview-pr2079-platform-database-url");
      });
    }
  });
  it.each([[true,true,1],[true,false,0],[false,true,0],[false,false,0]])(
    "validates shared prerequisites for Slack=%s/share=%s", (pilot, share, status) => {
      const selection = jobs["select-share-preview"];
      expect(selection.if).toContain("inputs.connect_share_preview || inputs.connect_slack_pilot");
      for (const name of ["connect-share-preview", "connect-slack-pilot-preview"]) {
        expect(jobs[name].needs).toBe("select-share-preview");
        expect(jobs[name].if).not.toContain("always()");
      }
      const guard = selection.steps[0];
      expect(guard.name).toBe("Validate preview connection inputs");
      expect(guard.env.CONNECT_SLACK_PILOT).toContain("inputs.connect_slack_pilot");
      expect(guard.env.CONNECT_SHARE_PREVIEW).toContain("inputs.connect_share_preview");
      const run = spawnSync("bash", ["-euc", guard.run], { encoding:"utf8", timeout:2_000, env: {
        CONNECT_SLACK_PILOT:String(pilot), CONNECT_SHARE_PREVIEW:String(share),
      } });
      expect(run.status, run.stderr).toBe(status);
    },
  );
});
