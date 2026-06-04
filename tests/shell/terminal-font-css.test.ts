import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("terminal font CSS", () => {
  it("uses font-display block for bundled Meslo faces so xterm measures stable glyph metrics", async () => {
    const css = await readFile("shell/src/app/globals.css", "utf8");
    const mesloFaces = css.match(/@font-face\s*{[^}]*font-family:\s*"MesloLGS NF";[^}]*}/g) ?? [];

    expect(mesloFaces).toHaveLength(4);
    for (const face of mesloFaces) {
      expect(face).toContain("font-display: block;");
      expect(face).not.toContain("font-display: swap;");
    }
  });
});
