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
    // Spec 063 moved the builder prompt from the legacy ~/modules tree to
    // the app-runtime ~/apps tree; deployer/healer still reference the
    // module registry. Assert path substitution on whichever agent owns
    // each reference.
    expect(agents.builder.prompt).toContain("/test/matrixos/apps/");
    expect(agents.deployer.prompt).toContain("/test/matrixos/modules/");
    expect(agents.deployer.prompt).toContain(
      "/test/matrixos/system/modules.json",
    );
  });

  it("builder prompt contains verification instructions", () => {
    const agents = getCoreAgents(homePath);
    expect(agents.builder.prompt).toContain("VERIFICATION");
    expect(agents.builder.prompt).toContain("absolute");
  });

  it("builder prompt applies current Matrix brand guidance through a user taste brief", () => {
    const prompt = getCoreAgents(homePath).builder.prompt;
    expect(prompt).toContain("Bricolage Grotesque");
    expect(prompt).toContain("Geist");
    expect(prompt).toContain("#0E3422");
    expect(prompt).toContain("taste brief");
    expect(prompt).toContain("user's taste");
    expect(prompt).not.toContain("Orbitron");
  });

  it("builder prompt directs app work through Matrix and animation skills", () => {
    const builder = getCoreAgents(homePath).builder;
    const prompt = builder.prompt;
    for (const skill of [
      "matrix-app-builder",
      "matrix-design-system",
      "matrix-app-ui-patterns",
      "find-animation-opportunities",
      "animate",
      "animation-accessibility",
      "animation-performance",
    ]) {
      expect(prompt).toContain(skill);
    }
    expect(builder.tools).toContain("mcp__matrix-os-ipc__load_skill");
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
  it("returns an empty object for nonexistent directory", () => {
    const agents = loadCustomAgents("/nonexistent/path");
    expect(agents).toEqual({});
  });

  it("loads all five agent files from home/agents/custom", () => {
    const agents = loadCustomAgents("./home/agents/custom");
    expect(Object.keys(agents).sort()).toEqual([
      "builder",
      "deployer",
      "evolver",
      "healer",
      "researcher",
    ]);
  });

  it("parses agent frontmatter correctly", () => {
    const agents = loadCustomAgents("./home/agents/custom");
    expect(agents.builder.model).toBe("opus");
    expect(agents.builder.maxTurns).toBe(50);
    expect(agents.builder.tools).toContain("Read");
    expect(agents.builder.tools).toContain("mcp__matrix-os-ipc__claim_task");
    expect(agents.builder.tools).toContain("mcp__matrix-os-ipc__load_skill");
  });

  it("loads prompt body for each agent", () => {
    const agents = loadCustomAgents("./home/agents/custom");
    expect(agents.builder.prompt).toContain("WORKFLOW");
    expect(agents.healer.prompt).toContain("COMMON FAILURE PATTERNS");
    expect(agents.researcher.prompt).toContain("GUIDELINES");
    expect(agents.deployer.prompt).toContain("PORT MANAGEMENT");
    expect(agents.evolver.prompt).toContain("SAFETY RULES");
  });

  it("keeps the custom builder aligned with the current brand and motion skill routing", () => {
    const prompt = loadCustomAgents("./home/agents/custom").builder.prompt;
    expect(prompt).toContain("Bricolage Grotesque");
    expect(prompt).toContain("taste brief");
    expect(prompt).toContain("matrix-app-builder");
    expect(prompt).toContain("animation-accessibility");
    expect(prompt).not.toContain("Orbitron");
  });

  it("resolves ~/ paths when homePath provided", () => {
    const agents = loadCustomAgents("./home/agents/custom", "/test/home");
    expect(agents.builder.prompt).toContain("/test/home/modules/");
    expect(agents.builder.prompt).not.toContain("~/modules/");
  });
});
