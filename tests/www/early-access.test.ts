import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function readRepoFile(path: string) {
  return readFile(resolve(root, path), "utf8");
}

describe("www early access page", () => {
  it("uses an internally scrollable Tally iframe instead of mobile-fragile dynamic height", async () => {
    const page = await readRepoFile("www/src/app/early-access/page.tsx");

    expect(page).toContain("scrolling=\"yes\"");
    expect(page).toContain("overflow-hidden");
    expect(page).not.toContain("dynamicHeight");
  });
});
