import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function readRepoFile(path: string) {
  return readFile(resolve(root, path), "utf8");
}

describe("www legal pages", () => {
  it("ships legal pages with required company, contact, service, and license language", async () => {
    const [terms, privacy] = await Promise.all([
      readRepoFile("www/src/app/terms/page.tsx"),
      readRepoFile("www/src/app/privacy/page.tsx"),
    ]);

    for (const page of [terms, privacy]) {
      expect(page).toContain("Finna Labs Inc.");
      expect(page).toContain("support@matrix-os.com");
      expect(page).toMatch(/Matrix OS/);
    }

    expect(terms).toMatch(/AGPL-3\.0-or-later|GNU Affero General Public License/i);
    expect(terms).toMatch(/owner-controlled|your data/i);
    expect(privacy).toMatch(/customer VPS|Matrix home|local Postgres/i);
    expect(privacy).toMatch(/Clerk|PostHog|Vercel|Pipedream/);
  });

  it("links terms and privacy from the landing page footer and keeps license copy accurate", async () => {
    const [landing, footer, finalCta] = await Promise.all([
      readRepoFile("www/src/app/page.tsx"),
      readRepoFile("www/src/components/landing/SiteFooter.tsx"),
      readRepoFile("www/src/components/landing/FinalCtaSection.tsx"),
    ]);

    expect(landing).toContain("<SiteFooter />");
    expect(landing).toContain("<FinalCtaSection />");
    expect(footer).toContain('href: "/terms"');
    expect(footer).toContain('href: "/privacy"');
    expect(finalCta).toContain('href="/terms"');
    expect(finalCta).toContain('href="/privacy"');
    expect(footer).toMatch(/AGPL-3\.0-or-later|GNU Affero General Public License/i);
    expect(footer).not.toContain("MIT licensed");
    expect(landing).not.toContain("MIT licensed");
  });
});
