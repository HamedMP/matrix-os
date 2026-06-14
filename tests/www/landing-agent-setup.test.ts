import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function readRepoFile(path: string) {
  return readFile(resolve(root, path), "utf8");
}

describe("www landing agent setup", () => {
  it("promotes the copy-agent-prompt path in the landing hero", async () => {
    const [landing, hero] = await Promise.all([
      readRepoFile("www/src/app/page.tsx"),
      readRepoFile("www/src/components/landing/Hero.tsx"),
    ]);

    expect(landing).toContain("<Hero />");
    expect(hero).toContain("CopyPromptButton");
    expect(hero).toContain("COPYABLE_AGENT_SETUP_PROMPT");
  });

  it("renders public landing CTAs without waiting on Clerk auth state", async () => {
    const [header, hero, finalCta] = await Promise.all([
      readRepoFile("www/src/components/landing/SiteHeader.tsx"),
      readRepoFile("www/src/components/landing/Hero.tsx"),
      readRepoFile("www/src/components/landing/FinalCtaSection.tsx"),
    ]);

    for (const source of [header, hero, finalCta]) {
      expect(source).not.toContain("@clerk/nextjs");
      expect(source).not.toContain("SignedIn");
      expect(source).not.toContain("SignedOut");
    }

    expect(header).toContain("Get started");
    expect(hero).toContain("Get started");
    expect(finalCta).toContain("Get started");
  });

  it("keeps Clerk middleware off the public landing render path", async () => {
    const proxy = await readRepoFile("www/src/proxy.ts");

    expect(proxy).toContain('"/dashboard(.*)"');
    expect(proxy).toContain('"/admin(.*)"');
    expect(proxy).toContain('matcher: ["/dashboard(.*)", "/admin(.*)", "/((?!_next|.*\\\\..*).*)"]');
    expect(proxy).not.toContain('"/(api|trpc)(.*)"');
  });

  it("keeps the full agent setup block with copy support and agent brands on the Symphony page", async () => {
    const [symphonyPage, setupSection] = await Promise.all([
      readRepoFile("www/src/app/symphony/page.tsx"),
      readRepoFile("www/src/components/landing/AgentSetupSection.tsx"),
    ]);

    expect(symphonyPage).toContain("<AgentSetupSection />");
    expect(setupSection).toContain("CopyPromptButton");
    expect(setupSection).toContain("COPYABLE_AGENT_SETUP_PROMPT");

    for (const brand of ["Claude Code", "Codex", "Pi", "OpenCode"]) {
      expect(setupSection).toContain(brand);
    }

    expect(setupSection).toContain('logo: "/agents/claude-code.svg"');
    expect(setupSection).toContain('logo: "/agents/codex.svg"');
  });

  it("ships a clipboard button with a safe fallback state", async () => {
    const copyButton = await readRepoFile("www/src/components/landing/CopyPromptButton.tsx");

    expect(copyButton).toContain('"use client"');
    expect(copyButton).toContain("navigator.clipboard.writeText");
    expect(copyButton).toContain("ClipboardIcon");
    expect(copyButton).toContain("Copied");
  });
});
