import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("land skill", () => {
  it("lets GitHub generate the squash commit subject", () => {
    const skill = readFileSync(
      join(process.cwd(), ".agents/skills/land/SKILL.md"),
      "utf8",
    );

    expect(skill).toContain(
      "Never pass `--subject` or `-s` to `gh pr merge`",
    );
    expect(skill).toContain(
      "Custom `--body` and `--body-file` values are allowed",
    );

    const mergeCommands = skill.match(/^gh pr merge .*$/gm) ?? [];
    expect(mergeCommands).toContain('gh pr merge --squash --body "$pr_body"');
    expect(mergeCommands).not.toHaveLength(0);
    for (const command of mergeCommands) {
      expect(command).not.toMatch(/\s(?:--subject|-s)(?:\s|=|$)/);
    }
  });
});
