import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import * as controller from "../../scripts/preview-pair/build-request.mjs";
const controllerSha = "c".repeat(40), sourceSha = "a".repeat(40);
const input = { pr: "3022", sourceSha, pairId: "01234567-89ab-4cde-8fab-0123456789ab", generation: "1" };
const pull = { number: 3022, state: "open", head: { sha: sourceSha, repo: { full_name: "HamedMP/matrix-os" } }, base: { repo: { full_name: "HamedMP/matrix-os" } } };
const run = { repository: "HamedMP/matrix-os", event: "workflow_dispatch", sha: controllerSha, reviewedControllerSha: controllerSha };
const validate = (i: unknown=input, p: unknown=pull, r: unknown=run) => (controller as any).validatePreviewPairBuild?.(i,p,r);
describe("protected candidate build admission", () => {
  it("binds the exact open PR source separately from controller execution", () => {
    expect(validate()).toEqual({ ...input, pr: 3022, generation: 1, controllerSha });
  });
  it.each([
    { ...pull, state: "closed" }, { ...pull, head: { ...pull.head, sha: "b".repeat(40) } },
    { ...pull, head: { ...pull.head, repo: { full_name: "other/matrix-os" } } }, { ...pull, number: 3023 },
  ])("refuses closed, stale, fork or wrong PR before packaging", p => expect(() => validate(input,p)).toThrow());
  it.each([
    { ...run, sha: sourceSha }, { ...run, event: "pull_request_target" }, { ...run, reviewedControllerSha: "" },
    { ...run, repository: "other/matrix-os" },
  ])("refuses unreviewed execution origins", r => expect(() => validate(input,pull,r)).toThrow());
  it.each([{ ...input, sourceSha: "main" }, { ...input, generation: "1000" }, { ...input, pr: "2;echo hi" }, { ...input, pairId: "../../x" }])(
    "rejects noncanonical input selectors", i => expect(() => validate(i)).toThrow());
});

const workflow = parse(readFileSync(".github/workflows/desktop-build.yml", "utf8"));
describe("actual unsigned pair build job", () => {
  const job = workflow.jobs.pair_artifacts;
  it("isolates candidate execution from signing jobs and mutable source refs", () => {
    expect(job.environment).toBe("collaboration-preview-build");
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.if).toContain("inputs.candidate_sha != ''");
    const guard = job.steps.findIndex((s: any) => s.name === "Verify reviewed controller and exact open PR");
    const checkout = job.steps.findIndex((s: any) => s.with?.path === "candidate");
    expect(guard).toBeGreaterThan(-1); expect(checkout).toBeGreaterThan(guard);
    expect(job.steps[checkout].with.ref).toBe("${{ inputs.candidate_sha }}");
    expect(job.steps[checkout].with["persist-credentials"]).toBe(false);
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|secrets:|inherit|publish always/);
    expect(workflow.jobs.mac.if).toContain("inputs.candidate_sha == ''");
    expect(workflow.jobs.linux.if).toContain("inputs.candidate_sha == ''");
  });
  it("checks execution and records artifact provenance without publishing updates", () => {
    const guard = job.steps.find((s: any) => s.name === "Verify reviewed controller and exact open PR");
    expect(guard.with.script).toContain("validatePreviewPairBuild(");
    expect(guard.env.REVIEWED_CONTROLLER_SHA).toBe("${{ vars.MATRIX_PREVIEW_PAIR_CONTROLLER_SHA }}");
    const build = job.steps.find((s: any) => s.name === "Build candidate without operator or signing credentials");
    expect(build.env.MATRIX_DESKTOP_SOURCE_SHA).toBe("${{ inputs.candidate_sha }}");
    expect(build.run).toContain("pnpm install --frozen-lockfile");
    const upload = job.steps.find((s: any) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(upload.with.path).toContain("preview-pair-source.json");
    expect(upload.with["if-no-files-found"]).toBe("error");
    expect(job.steps.find((s: any) => s.name === "Package unsigned portable app").run).toContain("--publish never");
  });
});
