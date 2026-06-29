import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function readRepoFile(path: string) {
  return readFile(resolve(root, path), "utf8");
}

describe("www landing mobile polish", () => {
  it("keeps the Matrix OS wordmark visible and the mobile bar compact", async () => {
    const header = await readRepoFile("www/src/components/landing/SiteHeader.tsx");

    // Brand pill always renders the wordmark; it never collapses to logo-only.
    expect(header).toContain("site-header-brand");
    expect(header).toContain("whitespace-nowrap text-[13px] font-bold tracking-tight");
    expect(header).toContain("Matrix OS");

    // Mobile keeps a single uncrowded row: sign-in is desktop-only and the
    // remaining actions cannot wrap mid-label.
    expect(header).toContain(".site-header-signin { display: none; }");
    expect(header).toContain("white-space: nowrap;");
    expect(header).toContain("site-header-menu-toggle");
  });

  it("opens a full-screen mobile menu that escapes the sticky header", async () => {
    const header = await readRepoFile("www/src/components/landing/SiteHeader.tsx");

    expect(header).toContain("site-header-sheet");
    expect(header).toContain("position: fixed;");
    expect(header).toContain("inset: 0;");
    // The entrance transform must not live on .site-header itself: a transform
    // there becomes the containing block for the fixed sheet and traps it.
    const headerRule = header.slice(header.indexOf(".site-header {"), header.indexOf("@keyframes header-enter"));
    expect(headerRule).not.toContain("animation");
    expect(header).toContain('document.body.style.overflow = "hidden"');
  });

  it("keeps the agent setup links compact and reachable on phones", async () => {
    const setupSection = await readRepoFile("www/src/components/landing/AgentSetupSection.tsx");

    expect(setupSection).toContain("flex flex-wrap");
    expect(setupSection).toContain("Open skills.md");
    expect(setupSection).toContain('href="/docs/quickstart"');
    expect(setupSection).toContain("Quickstart");
  });

  it("uses the shared card-section rhythm instead of the old blanket spacing", async () => {
    const [landing, billing, platformGrid] = await Promise.all([
      readRepoFile("www/src/app/page.tsx"),
      readRepoFile("www/src/components/landing/LandingBilling.tsx"),
      readRepoFile("www/src/components/landing/PlatformGrid.tsx"),
    ]);

    expect(landing).not.toContain("py-32 md:py-44");
    expect(platformGrid).toContain("pt-16 md:pt-28");
    expect(billing).not.toContain("min-h-screen");
    expect(billing).toContain("pt-16 md:pt-28");
  });
});
