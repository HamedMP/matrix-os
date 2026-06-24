import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("terminal session renderer wiring", () => {
  it("wires Desktop terminal session paths into TerminalApp initialSessionId", async () => {
    const source = await readFile("shell/src/components/Desktop.tsx", "utf8");

    expect(source).toContain("parseTerminalSessionLaunchPath");
    expect(source).toContain("initialSessionId={parseTerminalSessionLaunchPath(win.path) ?? undefined}");
  });
});
