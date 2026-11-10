import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HOSTED_LABEL, POOL_LABEL, selectUnitRunner } from "../../scripts/ci/select-runner.mjs";

const now = 1_800_000_000;
const fresh = (idle: number, age = 30) => `${now - age} ${idle}`;
const select = (overrides: Partial<Parameters<typeof selectUnitRunner>[0]> = {}) =>
  selectUnitRunner({
    heartbeat: fresh(4), now, eventName: "pull_request", headRepository: "HamedMP/matrix-os", repository: "HamedMP/matrix-os",
    ...overrides,
  });

describe("unit shard runner selection", () => {
  it("uses the pool for trusted source while every shard can start", () => {
    expect(select()).toBe(POOL_LABEL);
    expect(select({ heartbeat: fresh(6) })).toBe(POOL_LABEL);
    expect(select({ eventName: "push", headRepository: "" })).toBe(POOL_LABEL);
    expect(select({ eventName: "merge_group", headRepository: "" })).toBe(POOL_LABEL);
  });

  it.each([
    ["a fork PR", { headRepository: "someone/matrix-os" }],
    ["a PR without repository identity", { headRepository: "", repository: "" }],
    // Exact-source refresh dispatches run on main but can check out a fork PR's merge.
    ["a manual dispatch", { eventName: "workflow_dispatch", headRepository: "" }],
    ["an unknown event", { eventName: undefined }],
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
    // A fast-ci infrastructure fallback means the shared host failed: never wait on its pool.
    expect(workflow.jobs.unit["runs-on"]).toBe(
      "${{ needs.ci-backend.outputs.infrastructure_fallback == 'true' && 'ubuntu-latest' || needs.changes.outputs.unit_runner }}",
    );
    expect(workflow.jobs.unit.needs).toContain("ci-backend");
    expect(workflow.jobs.changes.outputs.unit_runner).toBe("${{ steps.runner.outputs.unit_runner || 'ubuntu-latest' }}");
    const step = workflow.jobs.changes.steps.find((s: { id?: string }) => s.id === "runner");
    expect(step.env.EVENT_NAME).toBe("${{ github.event_name }}");
    expect(step.env.HEAD_REPOSITORY).toBe("${{ github.event.pull_request.head.repo.full_name }}");
    expect(step.env.REPOSITORY).toBe("${{ github.repository }}");
    // One worker per two CPUs; more starves the gateway build inside customer-vps-runtime-loader.
    const test = workflow.jobs.unit.steps.find((s: { run?: string }) => s.run?.includes("bun run test -- --shard="));
    expect(test.env.MATRIX_TEST_WORKERS).toBe("${{ runner.environment == 'self-hosted' && '4' || '2' }}");
    expect(step.env.POOL_HEARTBEAT).toBe("${{ vars.MATRIX_CI_POOL_HEARTBEAT }}");
  });
});
