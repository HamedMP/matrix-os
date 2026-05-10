import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Symphony workflow", () => {
  it("does not configure Codex agents to inherit the full runner environment", async () => {
    const workflow = await readFile("WORKFLOW.md", "utf8");

    expect(workflow).not.toContain("shell_environment_policy.inherit=all");
    expect(workflow).toContain("shell_environment_policy.inherit=core");
  });
});
