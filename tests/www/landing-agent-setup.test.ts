import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function readRepoFile(path: string) {
  return readFile(resolve(root, path), "utf8");
}

describe("www landing agent setup", () => {
  it("promotes the coding-agent setup block near the top with copy support and agent brands", async () => {
    const landing = await readRepoFile("www/src/app/page.tsx");

    expect(landing).toContain("<AgentSetupSection />");
    expect(landing.indexOf("<AgentSetupSection />")).toBeLessThan(landing.indexOf("<PreviewSection />"));
    expect(landing).toContain("AgentSetupCopyButton");
    expect(landing).toContain("COPYABLE_AGENT_SETUP_PROMPT");

    for (const brand of ["Claude Code", "Codex", "Pi", "OpenCode"]) {
      expect(landing).toContain(brand);
    }

    expect(landing).toContain('logo: "/agents/claude-code.svg"');
    expect(landing).toContain('logo: "/agents/codex.svg"');
  });

  it("ships a clipboard button with a safe fallback state", async () => {
    const copyButton = await readRepoFile("www/src/components/landing/AgentSetupCopyButton.tsx");

    expect(copyButton).toContain('"use client"');
    expect(copyButton).toContain("navigator.clipboard.writeText");
    expect(copyButton).toContain("ClipboardIcon");
    expect(copyButton).toContain("Copied");
  });
});
