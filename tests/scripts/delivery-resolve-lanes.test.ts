import { describe, expect, it } from "vitest";
import {
  buildGitDiffArgs,
  formatGitDiffFailure,
  GIT_DIFF_TIMEOUT_MS,
  resolveLaneDecision,
  validateLaneDecision,
} from "../../scripts/delivery/resolve-lanes.mjs";

describe("delivery lane router", () => {
  it("routes shell changes to both pre-VPS shell and customer runtime lanes", () => {
    const decision = resolveLaneDecision({
      changedPaths: ["shell/src/components/BillingGate.tsx"],
    });

    expect(decision.lanes).toEqual(["shell", "runtime"]);
    expect(decision.requires).toEqual(["react-doctor", "shell-smoke", "host-bundle-smoke"]);
    expect(decision.blocked).toEqual([]);
  });

  it("fans root workspace metadata out to every lane that installs from the workspace", () => {
    const decision = resolveLaneDecision({
      changedPaths: ["pnpm-lock.yaml"],
    });

    expect(decision.lanes).toEqual(["platform", "shell", "edge", "runtime", "cli", "ops"]);
    expect(decision.reason).toContain("root workspace metadata");
  });

  it("adds lanes from explicit deploy selectors", () => {
    const decision = resolveLaneDecision({
      changedPaths: [],
      selectors: ["deploy/platform", "deploy/shell"],
    });

    expect(decision.lanes).toEqual(["platform", "shell"]);
    expect(decision.reason).toContain("manual dispatch");
  });

  it("rejects unknown deploy selectors instead of falling through to a default lane", () => {
    expect(() =>
      resolveLaneDecision({
        changedPaths: [],
        selectors: ["deploy/database"],
      }),
    ).toThrow(/Unknown deploy selector/);
  });

  it("keeps existing v* host-bundle tags on the runtime lane and rejects runtime/* tags", () => {
    expect(
      resolveLaneDecision({
        changedPaths: [],
        tags: ["v2026.06.16-1"],
      }).lanes,
    ).toEqual(["runtime"]);

    expect(() =>
      resolveLaneDecision({
        changedPaths: [],
        tags: ["runtime/v2026.06.16-1"],
      }),
    ).toThrow(/runtime\/\* tags are not valid/);
  });

  it("rejects prerelease-looking CLI tags instead of routing them to the CLI lane", () => {
    expect(() =>
      resolveLaneDecision({
        changedPaths: [],
        tags: ["cli-v1.2.3-rc1"],
      }),
    ).toThrow(/Unknown deploy tag/);
  });

  it("routes shared proxy package changes through the platform lane", () => {
    const decision = resolveLaneDecision({
      changedPaths: ["packages/proxy/src/main.ts"],
    });

    expect(decision.lanes).toEqual(["platform"]);
    expect(decision.reason).toContain("proxy package changed");
  });

  it("routes shared UI package changes through shell and runtime lanes", () => {
    const decision = resolveLaneDecision({
      changedPaths: ["packages/ui/src/Button.tsx"],
    });

    expect(decision.lanes).toEqual(["shell", "runtime"]);
    expect(decision.requires).toEqual(["react-doctor", "shell-smoke", "host-bundle-smoke"]);
    expect(decision.reason).toContain("shared UI package changed");
  });

  it("validates emitted decisions before workflows can consume them", () => {
    expect(() =>
      validateLaneDecision({
        lanes: ["shell", "database"],
        reason: "bad lane",
        requires: [],
        blocked: [],
      }),
    ).toThrow(/Invalid lane/);

    expect(() =>
      validateLaneDecision({
        lanes: ["shell"],
        reason: "bad block",
        requires: [],
        blocked: ["unsupported-path"],
      }),
    ).toThrow(/Invalid blocked entry/);
  });

  it("builds the git diff command without shell interpolation", () => {
    expect(buildGitDiffArgs({ base: "base-sha", head: "head-sha" })).toEqual([
      "diff",
      "--name-only",
      "base-sha..head-sha",
    ]);
    expect(GIT_DIFF_TIMEOUT_MS).toBe(30_000);
  });

  it("surfaces spawn errors from git diff failures", () => {
    const args = buildGitDiffArgs({ base: "base-sha", head: "head-sha" });

    expect(
      formatGitDiffFailure(args, {
        stderr: "",
        error: Object.assign(new Error("spawn git ETIMEDOUT"), { code: "ETIMEDOUT" }),
      }),
    ).toContain("spawn git ETIMEDOUT");
  });
});
