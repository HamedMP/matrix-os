import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildReleaseChangelog,
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
    const source = readFileSync(join(process.cwd(), "scripts/release-changelog.mjs"), "utf8");

    expect(source).toContain("FALLBACK_MAX_COMMITS = 100");
    expect(source).toContain("args.push(`--max-count=${FALLBACK_MAX_COMMITS}`)");
  });
});
