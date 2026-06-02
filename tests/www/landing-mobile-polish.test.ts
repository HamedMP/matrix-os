import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function readRepoFile(path: string) {
  return readFile(resolve(root, path), "utf8");
}

describe("www landing mobile polish", () => {
  it("keeps the Matrix OS wordmark visible and compact in the mobile navigation", async () => {
    const landing = await readRepoFile("www/src/app/page.tsx");

    expect(landing).toContain("mobile-brand-wordmark");
    expect(landing).toContain("width: fit-content");
    expect(landing).toContain("max-width: calc(100vw - 1rem)");
    expect(landing).toContain("grid-template-columns: max-content max-content");
    expect(landing).toContain("justify-content: start");
    expect(landing).toContain("@media (max-width: 350px)");
    expect(landing).not.toContain('className="hidden min-[1100px]:inline whitespace-nowrap');
    expect(landing).not.toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(landing).not.toContain("justify-content: space-between");
  });

  it("keeps the agent setup links in a compact two-column row on phones", async () => {
    const landing = await readRepoFile("www/src/app/page.tsx");

    expect(landing).toContain('aria-label="Agent setup resources"');
    expect(landing).toContain("grid grid-cols-2");
    expect(landing).toContain("Open skills.md");
    expect(landing).toContain("Developer workflow");
  });

  it("uses tighter landing section spacing than the original blanket rhythm", async () => {
    const landing = await readRepoFile("www/src/app/page.tsx");
    const billing = await readRepoFile("www/src/components/landing/LandingBilling.tsx");

    expect(landing).not.toContain("py-32 md:py-44");
    expect(landing).not.toContain("py-20 md:py-28");
    expect(landing).not.toContain("py-24 md:py-32");
    expect(landing).toContain("pt-12 pb-8 md:pt-14 md:pb-10");
    expect(landing).toContain("pt-8 pb-14 md:pt-12 md:pb-20");
    expect(landing).toContain("py-14 md:py-20");
    expect(landing).toContain("py-16 md:py-24");
    expect(billing).not.toContain("min-h-screen");
    expect(billing).not.toContain("py-20 md:py-28");
    expect(billing).toContain("py-16 md:py-24");
  });
});
