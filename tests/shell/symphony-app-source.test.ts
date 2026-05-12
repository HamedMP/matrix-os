import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const sourcePath = new URL("../../home/apps/symphony/src/App.tsx", import.meta.url);

describe("Symphony app source guards", () => {
  it("keeps the active Symphony workflow state list aligned with badge handling", async () => {
    const source = await readFile(sourcePath, "utf8");

    expect(source).not.toContain('{ name: "Human Review"');
    expect(source).not.toContain('stateName === "Human Review"');
  });

  it("surfaces config save failures from dropdown-driven saves", async () => {
    const source = await readFile(sourcePath, "utf8");

    expect(source).toContain("const saveConfig = useCallback(async (next: SymphonyConfig) => {");
    expect(source).toContain("[symphony] config save failed:");
    expect(source).toContain("Symphony settings could not be saved.");
  });
});
