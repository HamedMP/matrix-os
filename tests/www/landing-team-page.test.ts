import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function readRepoFile(path: string) {
  return readFile(resolve(root, path), "utf8");
}

describe("www landing team page", () => {
  it("links About us from the shared landing header", async () => {
    const header = await readRepoFile("www/src/components/landing/SiteHeader.tsx");

    expect(header).toContain('{ label: "About us", href: "/team" }');
  });

  it("ships the founders section on the shared marketing shell", async () => {
    const page = await readRepoFile("www/src/app/team/page.tsx");
    const founderHeadingIndex = page.indexOf('<h2 className="text-[1.25rem]');
    const firstLogoIndex = page.indexOf("founder.logos.map");
    const linkedinIndex = page.indexOf("founder.linkedin");
    const xIndex = page.indexOf("founder.x");

    expect(page).toContain('title: "About us | Matrix OS"');
    expect(page).toContain("<SiteHeader />");
    expect(page).toContain('src="/images/team-founders.jpg"');
    expect(page).toContain("Mission");
    expect(page).toContain("Meet our founders");
    expect(page).toContain("personal computer in the cloud");
    expect(page).toContain("security depth");
    expect(page).toContain("Hamed Mohammadpour");
    expect(page).toContain("CEO & Co-Founder");
    expect(page).toContain("/images/team/posthog-logo.png");
    expect(page).toContain("/images/team/newly-logo.jpg");
    expect(page).toContain("/images/team/kth-logo.svg");
    expect(page).toContain("https://www.linkedin.com/in/hamedmohammadpour/");
    expect(page).toContain("https://x.com/thehamedmp");
    expect(page).toContain("PostHog and Newly");
    expect(page).toContain("real workflows");
    expect(page).toContain("Nima Naderi");
    expect(page).toContain("CTO & Co-Founder");
    expect(page).toContain("/images/team/bending-spoons-logo.svg");
    expect(page).toContain("/images/team/ioi-logo.png");
    expect(page).toContain("https://www.linkedin.com/in/nima-naderi04/");
    expect(page).toContain("https://x.com/NimaNaderi2004");
    expect(page).toContain("function XLogoIcon");
    expect(page).not.toContain("XIcon");
    expect(page).toContain("Olympiad gold-medal problem solving");
    expect(page).toContain("reliable systems");
    expect(page).toContain("<SiteFooter />");
    expect(firstLogoIndex).toBeGreaterThan(-1);
    expect(founderHeadingIndex).toBeGreaterThan(-1);
    expect(linkedinIndex).toBeGreaterThan(founderHeadingIndex);
    expect(xIndex).toBeGreaterThan(linkedinIndex);
    expect(firstLogoIndex).toBeGreaterThan(xIndex);
  });
});
