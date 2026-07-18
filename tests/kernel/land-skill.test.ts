import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("land skill", () => {
  it("lets GitHub generate the squash commit subject", () => {
    const skill = readFileSync(
      join(process.cwd(), ".agents/skills/land/SKILL.md"),
      "utf8",
    );

    expect(skill).toContain('gh pr merge --squash --body "$pr_body"');
    expect(skill).not.toContain('--subject "$pr_title"');
  });
});
