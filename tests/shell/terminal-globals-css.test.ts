import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const globalsCssPath = fileURLToPath(new URL("../../shell/src/app/globals.css", import.meta.url));

describe("terminal global CSS", () => {
  it("scopes the sessions drawer scrollbar to terminal chrome variables", () => {
    const globalsCss = readFileSync(globalsCssPath, "utf8");

    expect(globalsCss).toContain(".terminal-sessions-scroll::-webkit-scrollbar-thumb");
    expect(globalsCss).toContain("[data-theme-style=\"neumorphic\"] .terminal-sessions-scroll::-webkit-scrollbar-thumb");
    expect(globalsCss).toContain("background: var(--terminal-drawer-scrollbar-thumb)");
    expect(globalsCss).not.toMatch(/terminal-sessions-scroll[\s\S]{0,400}--muted-foreground/);
  });
});
