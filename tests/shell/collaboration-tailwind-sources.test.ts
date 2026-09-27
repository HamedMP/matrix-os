import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("shared collaboration control styles", () => {
  it("compiles the shared Share controls' utilities for Web as well as Electron Desktop", () => {
    // Without this source the web build drops utilities only the collaboration
    // components use (for example the Share explanation popover width).
    expect(read("../../shell/src/app/globals.css")).toContain('@source "../../../packages/ui/src/collaboration";');
    expect(read("../../desktop/src/renderer/src/design/index.css")).toContain('@source "../../../../../packages/ui/src/collaboration";');
  });
});
