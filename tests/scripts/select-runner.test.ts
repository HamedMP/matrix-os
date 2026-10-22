import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HOSTED_LABEL, POOL_LABEL, selectUnitRunner } from "../../scripts/ci/select-runner.mjs";

const now = 1_800_000_000;
const fresh = (idle: number, age = 30) => `${now - age} ${idle}`;
const select = (overrides: Partial<Parameters<typeof selectUnitRunner>[0]> = {}) =>
  selectUnitRunner({ heartbeat: fresh(4), now, sameRepository: "true", unitScope: "full", ...overrides });

describe("unit shard runner selection", () => {
  it("uses the pool for same-repository full-suite runs while every shard can start", () => {
    expect(select()).toBe(POOL_LABEL);
    expect(select({ heartbeat: fresh(6) })).toBe(POOL_LABEL);
  });

  it.each([
    ["a fork PR", { sameRepository: "false" }],
    ["an affected-only PR", { unitScope: "affected" }],
    ["a missing heartbeat", { heartbeat: undefined }],
    ["a malformed heartbeat", { heartbeat: "online" }],
    ["a heartbeat without an idle count", { heartbeat: String(now) }],
    ["a stale heartbeat", { heartbeat: fresh(4, 181) }],
    ["a heartbeat from the future", { heartbeat: fresh(4, -61) }],
    ["too few idle slots", { heartbeat: fresh(3) }],
  ])("stays on hosted runners for %s", (_, overrides) => {
    expect(select(overrides)).toBe(HOSTED_LABEL);
  });

  it("routes only the unit shards, from the changes job's decision", () => {
    const workflow = parse(readFileSync(resolve(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8"));
    const routed = Object.entries(workflow.jobs as Record<string, { "runs-on": string }>)
      .filter(([, job]) => job["runs-on"] !== "ubuntu-latest" && !String(job["runs-on"]).startsWith("ubuntu-"))
      .map(([id]) => id);
    expect(routed).toEqual(["unit"]);
    expect(workflow.jobs.unit["runs-on"]).toBe("${{ needs.changes.outputs.unit_runner }}");
    expect(workflow.jobs.changes.outputs.unit_runner).toBe("${{ steps.runner.outputs.unit_runner || 'ubuntu-latest' }}");
    const step = workflow.jobs.changes.steps.find((s: { id?: string }) => s.id === "runner");
    expect(step.env.SAME_REPOSITORY).toBe(
      "${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}",
    );
    expect(step.env.POOL_HEARTBEAT).toBe("${{ vars.MATRIX_CI_POOL_HEARTBEAT }}");
  });
});
