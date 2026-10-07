import { readFileSync } from "node:fs";
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
  });

  it("loads prompt body for each agent", () => {
    const agents = loadCustomAgents("./home/agents/custom");
    expect(agents.builder.prompt).toContain("WORKFLOW");
    expect(agents.healer.prompt).toContain("COMMON FAILURE PATTERNS");
    expect(agents.researcher.prompt).toContain("GUIDELINES");
    expect(agents.deployer.prompt).toContain("PORT MANAGEMENT");
    expect(agents.evolver.prompt).toContain("SAFETY RULES");
  });

  it("resolves ~/ paths when homePath provided", () => {
    const agents = loadCustomAgents("./home/agents/custom", "/test/home");
    expect(agents.builder.prompt).toContain("/test/home/modules/");
    expect(agents.builder.prompt).not.toContain("~/modules/");
  });
});

const home = `${process.cwd()}/home`;
describe("registered builder product style direction", () => {
  it.each([
    ["core builder", () => getCoreAgents("/test/owner").builder.prompt],
    ["template builder", () => loadCustomAgents(`${home}/agents/custom`, "/test/owner").builder.prompt],
    ["runtime knowledge", () => readFileSync(`${home}/agents/knowledge/app-generation.md`, "utf8")],
  ])("%s permits coherent product styles without forcing platform colors", (_name, read) => {
    const prompt = read();
    for (const direction of ["neo-brutalism", "minimalism", "playful", "retro", "neumorphism", "DESIGN.md", "app-local", "random", "once", "shadcn", "responsive-layout.md", "360", "1440", "44"]) {
      expect(prompt).toContain(direction);
    }
    expect(prompt).not.toMatch(/always apply -- non-negotiable|ALWAYS inherit|literal colors are fallbacks only|explicit app branding only|Use inherited typography|Use inherited fonts|inherit Matrix\s+tokens and fonts/i);
    expect(prompt).toContain("No remote");
  });
  it("gives the core builder image generation while preserving its persistence boundary", () => {
    const builder = getCoreAgents("/test/owner").builder;
    expect(builder.tools).toEqual(["Read", "Write", "Edit", "Glob", "Grep", "Bash", "mcp__matrix-os-ipc__claim_task", "mcp__matrix-os-ipc__complete_task", "mcp__matrix-os-ipc__fail_task", "mcp__matrix-os-ipc__send_message", "mcp__matrix-os-ipc__generate_image"]);
    expect(builder.prompt).toContain("window.MatrixOS.db");
    expect(builder.prompt).toContain("Only use tools present in this run");
  });
});
