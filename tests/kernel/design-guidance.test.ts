import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("design review motion advice", () => {
  it("limits stagger recommendations to purposeful occasional entrances", () => {
    const skill = readFileSync(resolve(__dirname, "../../skills/matrix/emil-design-eng/SKILL.md"), "utf8");
    expect(skill).toContain("[review-checklist.md](review-checklist.md)");
    const reference = readFileSync(resolve(__dirname, "../../skills/matrix/emil-design-eng/review-checklist.md"), "utf8");
    const stagger = reference.split("## Stagger Animations")[1].split("## Debugging Animations")[0];
    expect(stagger).toContain("purposeful, occasional entrances");
    expect(stagger).toContain("list refresh");
    expect(stagger).toContain("immediate");
    const checklist = reference.split("## Review Checklist")[1];
    expect(checklist).toContain("purposeful, occasional entrances");
    expect(checklist).toContain("list refresh");
    expect(checklist).toContain("immediate");
    expect(checklist).not.toContain("Elements all appear at once");
  });
});
