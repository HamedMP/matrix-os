import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

function cleanup(latest: string, otherTraffic: unknown[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "preview-cleanup-"));
  const stateFile = join(directory, "state.json");
  const callsFile = join(directory, "calls.json");
  const service = { status: { latestCreatedRevisionName: latest, traffic: [
    { tag: "pr-1631", revisionName: "preview-target", percent: 0 }, ...otherTraffic,
  ] } };
  writeFileSync(stateFile, JSON.stringify(service));
  writeFileSync(callsFile, "[]");
  const executable = join(directory, "gcloud");
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const calls = JSON.parse(fs.readFileSync(process.env.CALLS_FILE, 'utf8'));
calls.push(args); fs.writeFileSync(process.env.CALLS_FILE, JSON.stringify(calls));
const service = JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8'));
if (args.slice(0, 3).join(' ') === 'run services describe') {
  console.log(JSON.stringify(service));
} else if (args.slice(0, 3).join(' ') === 'run services update-traffic') {
  service.status.traffic = service.status.traffic.filter(x => x.tag !== 'pr-1631');
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify(service));
} else if (args.slice(0, 3).join(' ') === 'run revisions delete') {
  if (args[3] === service.status.latestCreatedRevisionName) {
    console.error('FAILED_PRECONDITION: latest created revision cannot be deleted'); process.exit(1);
  }
  if (service.status.traffic.some(x => x.revisionName === args[3] && (x.tag || x.percent > 0))) {
    console.error('Revision is still referenced'); process.exit(1);
  }
} else { console.error('Unexpected gcloud invocation'); process.exit(2); }
`);
  chmodSync(executable, 0o755);
  try {
    const workflow = parse(readFileSync(".github/workflows/preview-platform.yml", "utf8"));
    const step = workflow.jobs["teardown"].steps.find((item: { name?: string }) => item.name === "Remove tag and delete tagged revisions");
    const result = spawnSync("bash", ["-c", step.run], { encoding: "utf8", env: {
      ...process.env, PATH: `${directory}:${process.env.PATH}`, STATE_FILE: stateFile, CALLS_FILE: callsFile,
      CLOUD_RUN_PREVIEW_SERVICE: "preview-service", GCP_PROJECT_ID: "test-project", GCP_REGION: "test-region", PR_NUMBER: "1631",
    } });
    return { ...result, calls: JSON.parse(readFileSync(callsFile, "utf8")) as string[][] };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("Cloud Run preview cleanup", () => {
  it("removes the PR tag while retaining the latest-created revision", () => {
    const result = cleanup("preview-target");
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.some(args => args.includes("--remove-tags"))).toBe(true);
    expect(result.calls.some(args => args.includes("delete"))).toBe(false);
  });
  it("deletes an older unreferenced revision", () => {
    const result = cleanup("newer-revision");
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.some(args => args.slice(0, 4).join(" ") === "run revisions delete preview-target")).toBe(true);
  });
  it.each([
    [{ revisionName: "preview-target", percent: 100 }],
    [{ revisionName: "preview-target", tag: "another-preview", percent: 0 }],
  ])("retains a revision still referenced after removing the PR tag", (...traffic) => {
    const result = cleanup("newer-revision", traffic);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.some(args => args.includes("delete"))).toBe(false);
  });
});
