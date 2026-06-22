import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function readRepoFile(path: string) {
  return readFile(resolve(root, path), "utf8");
}

describe("www landing team page", () => {
  it("links Team from the shared landing header", async () => {
    const header = await readRepoFile("www/src/components/landing/SiteHeader.tsx");

    expect(header).toContain('{ label: "Team", href: "/team" }');
  });

  it("ships the founders section on the shared marketing shell", async () => {
    const page = await readRepoFile("www/src/app/team/page.tsx");

    expect(page).toContain('title: "Team | Matrix OS"');
    expect(page).toContain("<SiteHeader />");
    expect(page).toContain('src="/images/team-founders.jpg"');
    expect(page).toContain("AI-native computer");
    expect(page).toContain("high-craft consumer software");
    expect(page).toContain("Hamed Mohammadpour");
    expect(page).toContain("CEO & Co-Founder");
    expect(page).toContain("https://www.linkedin.com/in/hamedmohammadpour/");
    expect(page).toContain("https://x.com/thehamedmp");
    expect(page).toContain("PostHog and Newly");
    expect(page).toContain("real workflows");
    expect(page).toContain("Nima Naderi");
    expect(page).toContain("CTO & Co-Founder");
    expect(page).toContain("https://www.linkedin.com/in/nima-naderi04/");
    expect(page).toContain("https://x.com/NimaNaderi2004");
    expect(page).toContain("Olympiad gold-medal problem solving");
    expect(page).toContain("reliable systems");
    expect(page).toContain("<SiteFooter />");
  });
});
