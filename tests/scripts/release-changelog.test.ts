import { describe, expect, it } from "vitest";
import {
  buildReleaseChangelog,
  gitLogArgs,
  humanizeCommitSubject,
} from "../../scripts/release-changelog.mjs";

describe("release changelog generation", () => {
  it("turns conventional commit subjects into reader-friendly notes", () => {
    expect(humanizeCommitSubject("fix(platform): sync Clerk users into platform db (#423)")).toBe(
      "Sync Clerk users into platform database.",
    );
    expect(humanizeCommitSubject("feat(cli): document package runner launch path")).toBe(
      "Document package runner launch path.",
    );
  });

  it("groups every included commit without showing hashes", () => {
    const changelog = buildReleaseChangelog([
      "feat(shell): add billing plan chooser",
      "fix(platform): route signup billing through auth shell",
      "chore(ci): refresh bundle release workflow",
    ]);

    expect(changelog).toContain("What's changed");
    expect(changelog).toContain("New");
    expect(changelog).toContain("- Add billing plan chooser.");
    expect(changelog).toContain("Fixed");
    expect(changelog).toContain("- Route signup billing through auth shell.");
    expect(changelog).toContain("Polish and reliability");
    expect(changelog).toContain("- Refresh bundle release workflow.");
    expect(changelog).not.toContain("feat(shell)");
    expect(changelog).not.toContain("abc123");
  });

  it("caps the no-base fallback so it cannot emit the whole repository history", () => {
    expect(gitLogArgs({ base: "", head: "HEAD" })).toEqual([
      "log",
      "--reverse",
      "--format=%s",
      "--max-count=100",
      "HEAD",
    ]);
  });

  it("does not cap explicit base-to-head release ranges", () => {
    expect(gitLogArgs({ base: "base-sha", head: "head-sha" })).toEqual([
      "log",
      "--reverse",
      "--format=%s",
      "base-sha..head-sha",
    ]);
  });
});
