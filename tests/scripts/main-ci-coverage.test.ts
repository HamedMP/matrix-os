import { describe, expect, it, vi } from "vitest";
import {
  buildMainCiCoveragePlan,
  classifyMainCiChanges,
  listSuccessfulCoverageRuns,
  selectCoverageFrontier,
} from "../../scripts/ci/main-ci-coverage.mjs";
import { EMPTY_TREE_SHA, MAX_CHANGED_PATHS } from "../../scripts/ci/git-coverage.mjs";

describe("main CI coverage planning", () => {
  it("keeps both source and docs obligations for a mixed change set", () => {
    expect(
      classifyMainCiChanges([
        "packages/gateway/src/server.ts",
        "docs/dev/onboarding.md",
      ]),
    ).toEqual({
      shouldRun: true,
      docsContractTests: true,
    });
  });

  it.each([
    [["docs/dev/onboarding.md"], { shouldRun: false, docsContractTests: true }],
    [["specs/123-queue/spec.md"], { shouldRun: false, docsContractTests: true }],
    [["README.md"], { shouldRun: false, docsContractTests: true }],
    [["packages/gateway/src/server.ts"], { shouldRun: true, docsContractTests: false }],
    [[], { shouldRun: false, docsContractTests: false }],
  ])("classifies %j without dropping independent obligations", (paths, expected) => {
    expect(classifyMainCiChanges(paths)).toEqual(expected);
  });

  it("rejects an unbounded changed-path set", () => {
    expect(() => classifyMainCiChanges(Array(MAX_CHANGED_PATHS + 1).fill("README.md")))
      .toThrow("Changed path count exceeds the limit");
  });

  it("selects the newest successful coverage-aware ancestor as the frontier", async () => {
    const runs = [
      { headSha: "newer", displayTitle: "CI coverage-v1 · newer" },
      { headSha: "untrusted", displayTitle: "CI" },
      { headSha: "older", displayTitle: "CI coverage-v1 · older" },
    ];

    await expect(
      selectCoverageFrontier(runs, "target", {
        isAncestor: async (candidate, target) =>
          target === "target" && candidate !== "newer",
      }),
    ).resolves.toBe("older");
  });

  it("promotes a queued docs commit when broader predecessor coverage did not succeed", async () => {
    const changedRanges: Array<[string, string]> = [];

    await expect(
      buildMainCiCoveragePlan(
        {
          targetSha: "docs-head",
          successfulRuns: [
            { headSha: "last-green", displayTitle: "CI coverage-v1 · last-green" },
          ],
        },
        {
          isAncestor: async () => true,
          getEmptyTreeSha: async () => "empty-tree",
          getChangedPaths: async (base, head) => {
            changedRanges.push([base, head]);
            return ["packages/gateway/src/server.ts", "docs/dev/onboarding.md"];
          },
        },
      ),
    ).resolves.toEqual({
      baseSha: "last-green",
      bootstrap: false,
      shouldRun: true,
      docsContractTests: true,
    });
    expect(changedRanges).toEqual([["last-green", "docs-head"]]);
  });

  it("bootstraps from the empty tree when no trusted coverage run exists", async () => {
    const getChangedPaths = vi.fn(async () => ["scripts/ci/main-ci-coverage.mjs"]);

    await expect(
      buildMainCiCoveragePlan(
        { targetSha: "first-head", successfulRuns: [] },
        {
          isAncestor: async () => false,
          getEmptyTreeSha: async () => EMPTY_TREE_SHA,
          getChangedPaths,
        },
      ),
    ).resolves.toEqual({
      baseSha: EMPTY_TREE_SHA,
      bootstrap: true,
      shouldRun: true,
      docsContractTests: false,
    });
    expect(getChangedPaths).toHaveBeenCalledWith(EMPTY_TREE_SHA, "first-head");
  });

  it("keeps a docs successor lightweight after its broader predecessor succeeds", async () => {
    await expect(
      buildMainCiCoveragePlan(
        {
          targetSha: "docs-head",
          successfulRuns: [
            { headSha: "full-green", displayTitle: "CI coverage-v1 · full-green" },
          ],
        },
        {
          isAncestor: async () => true,
          getEmptyTreeSha: async () => EMPTY_TREE_SHA,
          getChangedPaths: async () => ["docs/dev/releases.md"],
        },
      ),
    ).resolves.toEqual({
      baseSha: "full-green",
      bootstrap: false,
      shouldRun: false,
      docsContractTests: true,
    });
  });

  it("loads only bounded successful main-push history from the fixed GitHub API", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      workflow_runs: [
        {
          id: 42,
          head_sha: "a".repeat(40),
          display_title: "CI coverage-v1 · candidate",
        },
      ],
    }), { status: 200 }));

    await expect(
      listSuccessfulCoverageRuns({
        repository: "HamedMP/matrix-os",
        token: "test-token",
        fetchImpl,
      }),
    ).resolves.toEqual([
      {
        id: 42,
        headSha: "a".repeat(40),
        displayTitle: "CI coverage-v1 · candidate",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/HamedMP/matrix-os/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=100",
      expect.objectContaining({
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
