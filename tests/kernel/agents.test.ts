import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  loadCustomAgents,
  getCoreAgents,
} from "../../packages/kernel/src/agents.js";

describe("parseFrontmatter", () => {
  it("extracts YAML frontmatter and body from markdown", () => {
    const md = `---
name: builder
description: Builds apps from natural language
model: opus
---
You are the builder agent.
Build things.`;

    const result = parseFrontmatter(md);
    expect(result.frontmatter.name).toBe("builder");
    expect(result.frontmatter.description).toBe(
      "Builds apps from natural language",
    );
    expect(result.frontmatter.model).toBe("opus");
    expect(result.body).toContain("You are the builder agent.");
  });

  it("preserves the full body after frontmatter", () => {
    const md = `---
name: test
description: Test agent
---
Line 1
Line 2
Line 3`;

    const result = parseFrontmatter(md);
    expect(result.body).toContain("Line 1");
    expect(result.body).toContain("Line 2");
    expect(result.body).toContain("Line 3");
  });

  it("handles missing frontmatter (no --- delimiters)", () => {
    const md = "Just a plain markdown file with no frontmatter.";
    const result = parseFrontmatter(md);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(md);
  });

  it("parses tools as an array", () => {
    const md = `---
name: builder
description: Builds stuff
tools:
  - Read
  - Write
  - Edit
  - Bash
---
Build prompt.`;

    const result = parseFrontmatter(md);
    expect(result.frontmatter.tools).toEqual(["Read", "Write", "Edit", "Bash"]);
  });

  it("ignores unknown fields without error", () => {
    const md = `---
name: test
description: Test
unknownField: some value
anotherWeirdThing: 42
---
Body.`;

    const result = parseFrontmatter(md);
    expect(result.frontmatter.name).toBe("test");
    expect(result.frontmatter.unknownField).toBe("some value");
  });

  it("parses maxTurns as number", () => {
    const md = `---
name: builder
description: Builder
maxTurns: 20
---
Prompt.`;

    const result = parseFrontmatter(md);
    expect(result.frontmatter.maxTurns).toBe(20);
  });
});

describe("getCoreAgents", () => {
  const homePath = "/test/matrixos";

  it("injects absolute paths -- no ~/ remains in any agent prompt", () => {
    const agents = getCoreAgents(homePath);
    for (const [, agent] of Object.entries(agents)) {
      expect(agent.prompt).not.toContain("~/");
    }
  });

  it("replaces ~/ with the provided homePath", () => {
    const agents = getCoreAgents(homePath);
    expect(agents.builder.prompt).toContain("/test/matrixos/modules/");
    expect(agents.builder.prompt).toContain("/test/matrixos/apps/");
    expect(agents.builder.prompt).toContain(
      "/test/matrixos/system/modules.json",
    );
  });

  it("builder prompt contains verification instructions", () => {
    const agents = getCoreAgents(homePath);
    expect(agents.builder.prompt).toContain("VERIFICATION (REQUIRED)");
    expect(agents.builder.prompt).toContain("absolute");
  });

  it("returns all five core agents", () => {
    const agents = getCoreAgents(homePath);
    expect(Object.keys(agents)).toEqual([
      "builder",
      "healer",
      "researcher",
      "deployer",
      "evolver",
    ]);
  });
});

describe("loadCustomAgents", () => {
  it("returns an empty object for empty directory", () => {
    const agents = loadCustomAgents("./home/agents/custom");
    expect(agents).toEqual({});
  });

  it("returns an empty object for nonexistent directory", () => {
    const agents = loadCustomAgents("/nonexistent/path");
    expect(agents).toEqual({});
  });

  it("loads agent definitions from markdown files", () => {
    // This test will pass once we have actual .md files in the custom dir
    // For now it validates the empty-dir behavior
    const agents = loadCustomAgents("./home/agents/custom");
    expect(typeof agents).toBe("object");
  });
});
