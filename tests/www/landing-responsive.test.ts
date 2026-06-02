import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function readRepoFile(path: string) {
  return readFile(resolve(root, path), "utf8");
}

describe("www landing responsive layout", () => {
  it("keeps the hero stacked until laptop widths and uses compact first-fold spacing", async () => {
    const landing = await readRepoFile("www/src/app/page.tsx");

    expect(landing).toContain("lg:grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)]");
    expect(landing).not.toContain("md:grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)]");
    expect(landing).toContain("min-h-[72svh]");
    expect(landing).toContain("pt-24 pb-12");
  });

  it("keeps mobile nav CTA-only below the tablet breakpoint", async () => {
    const landing = await readRepoFile("www/src/app/page.tsx");

    expect(landing).toContain("@media (min-width: 760px)");
    expect(landing).toContain(".nav-links {\n          display: none;");
    expect(landing).toContain("className=\"nav-links\"");
    expect(landing).toContain("className=\"nav-actions\"");
  });

  it("uses responsive section rhythm instead of desktop-heavy blanket spacing", async () => {
    const landing = await readRepoFile("www/src/app/page.tsx");

    expect(landing).toContain("py-20 md:py-28 lg:py-36");
    expect(landing).toContain("px-6 sm:px-8");
    expect(landing).not.toContain("className=\"py-32 md:py-44\"");
  });

  it("keeps pricing from forcing a full viewport on mobile", async () => {
    const billing = await readRepoFile("www/src/components/landing/LandingBilling.tsx");

    expect(billing).toContain("min-h-0");
    expect(billing).toContain("lg:min-h-screen");
    expect(billing).not.toContain("className=\"relative flex min-h-screen");
  });
});
