import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const readDoc = (name: string) =>
  readFileSync(join(root, `www/content/docs/${name}.mdx`), "utf8");

describe("agent runtime public docs", () => {
  it("distinguishes Chat from optional messaging runtimes", () => {
    const agentRuntime = readDoc("hermes");

    expect(agentRuntime).toContain("Chat kernel");
    expect(agentRuntime).toContain("Claude Agent SDK V1");
    expect(agentRuntime).toContain("Messaging runtime");
    expect(agentRuntime).toContain("Hermes");
    expect(agentRuntime).toContain("OpenClaw");
    expect(agentRuntime).toContain("Settings");
    expect(agentRuntime).toContain("Agent");
    expect(agentRuntime).toContain("Platform-provided");
    expect(agentRuntime).toContain("API key");
    expect(agentRuntime).toContain("subscription login");
    expect(agentRuntime).toContain("never stored in the browser");
    expect(agentRuntime).toContain("keeps Chat available");
    expect(agentRuntime).toMatch(/keeps the\s+current healthy messaging runtime selected/);
  });

  it("uses the same runtime language on overview, glossary, and Messages pages", () => {
    const overview = readDoc("index");
    const glossary = readDoc("glossary");
    const messages = readDoc("messages");

    expect(overview).not.toContain("Hermes is always on");
    expect(overview).toContain("Chat kernel");
    expect(overview).toContain("Hermes or OpenClaw");
    expect(glossary).toContain("**Chat kernel**");
    expect(glossary).toContain("**Messaging runtime**");
    expect(glossary).not.toContain("**Hermes** — Matrix's always-on chat agent");
    expect(messages).toContain("selected messaging runtime");
    expect(messages).not.toContain("does not let Hermes read or reply");
  });
});
