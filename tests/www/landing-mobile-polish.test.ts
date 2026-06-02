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
});
