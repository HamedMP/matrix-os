import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { resolveReleaseSnapshotEligibility } from "../../scripts/release-snapshot-eligibility.mjs";

describe("numbered register-only host bundle candidates", () => {
  it("admits a channel-none dispatch through the existing CI and explicit deployment gates", () => {
    const workflow = parse(readFileSync(".github/workflows/host-bundle-release.yml", "utf8"));
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs.channel.options).toContain("none");
    expect(inputs.channel.default).toBe("dev");
    expect(inputs.deploy_after_publish.default).toBe(false);
    expect(workflow.jobs.build.needs).toContain("ci-gate");
    expect(workflow.jobs["ci-gate"].steps[0].env.TARGET_SHA).toBe("${{ github.sha }}");
    const publish = workflow.jobs.publish.steps.find((step: { name?: string }) => step.name === "Publish release");
    expect(publish.env.HOST_BUNDLE_CHANNEL).toBe("${{ needs.build.outputs.channel }}");
    expect(workflow.jobs.deploy.if).toContain("inputs.deploy_after_publish");
    expect(resolveReleaseSnapshotEligibility("none")).toBe(false);
  });
});
